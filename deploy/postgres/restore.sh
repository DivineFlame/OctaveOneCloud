#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OctaveOneCloud — PostgreSQL backup / restore helper. Run on the VPS as root (or a docker-group user).
#
#   restore.sh list                         list dumps in the pgbackups volume
#   restore.sh backup                       take a dump right now
#   restore.sh drill  [dump]                restore into a scratch database, compare row counts, drop it
#                                           (non-destructive — use this for the monthly restore rehearsal)
#   restore.sh replace <dump>               DESTRUCTIVE: replace the live database with <dump>
#
# Options:  -p <compose project>   the Dokploy app name (auto-detected when only one OctaveOneCloud stack runs)
# [dump] defaults to the newest file. Dumps are the ooc-*.dump files written by the db-backup service.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT=""
while getopts "p:" opt; do
  case $opt in
    p) PROJECT=$OPTARG ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
CMD="${1:-}"
DUMP="${2:-}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
detect_project() {
  [[ -n "$PROJECT" ]] && return
  # OctaveOneCloud stacks are the compose projects that contain a db-backup service.
  local projects
  projects=$(docker ps -a --filter label=com.docker.compose.service=db-backup --format '{{.Label "com.docker.compose.project"}}' | sort -u)
  [[ -n "$projects" && $(wc -l <<<"$projects") -eq 1 ]] || die "Cannot auto-detect the stack. Use -p <project>. Candidates: $(tr '\n' ' ' <<<"$projects")"
  PROJECT=$projects
}
container() {
  local ids
  mapfile -t ids < <(docker ps -a --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}')
  [[ ${#ids[@]} -eq 1 ]] || die "Expected one '$1' container in project '$PROJECT', found ${#ids[@]}."
  echo "${ids[0]}"
}

detect_project
BACKUP=$(container db-backup)
bexec() { docker exec "$BACKUP" "$@" </dev/null; }

latest() { bexec sh -c 'ls -1t /backups/ooc-*.dump 2>/dev/null | head -1'; }
resolve_dump() {
  local d=${1:-$(latest)}
  [[ -n "$d" ]] || die "No dumps found in the pgbackups volume."
  [[ "$d" == /backups/* ]] || d="/backups/$d"
  bexec sh -c "[ -f '$d' ]" || die "Dump not found: $d"
  echo "$d"
}

TABLES='"Organization" "User" "Order" "PaymentAttempt" "Subscription" "Service" "AuditEvent"'
counts() {
  local db=$1 out="" t
  for t in $TABLES; do
    out+="$t=$(bexec psql -d "$db" -Atc "SELECT count(*) FROM $t" 2>/dev/null || echo '?') "
  done
  echo "$out"
}

case "$CMD" in
  list)
    # shellcheck disable=SC2016  # expanded inside the container
    bexec sh -c 'ls -lh /backups/ooc-*.dump 2>/dev/null || echo "(no dumps yet)"; [ -f /backups/.last_success ] && echo "last success: $(date -u -d @$(cat /backups/.last_success) 2>/dev/null || cat /backups/.last_success)"'
    ;;
  backup)
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    bexec sh -c "pg_dump -Fc -Z 6 -f /backups/ooc-$ts.dump.partial && pg_restore --list /backups/ooc-$ts.dump.partial >/dev/null && mv /backups/ooc-$ts.dump.partial /backups/ooc-$ts.dump && date -u +%s > /backups/.last_success"
    echo "Created /backups/ooc-$ts.dump"
    ;;
  drill)
    d=$(resolve_dump "$DUMP")
    echo "Restore drill from $d (project $PROJECT)"
    start=$(date +%s)
    bexec psql -d postgres -qc 'DROP DATABASE IF EXISTS ooc_restore_drill' -c 'CREATE DATABASE ooc_restore_drill'
    bexec pg_restore --no-owner --exit-on-error -d ooc_restore_drill "$d"
    secs=$(( $(date +%s) - start ))
    echo "Restored in ${secs}s."
    echo "live   : $(counts ooc)"
    echo "backup : $(counts ooc_restore_drill)"
    bexec psql -d ooc_restore_drill -Atc 'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1' | sed 's/^/latest migration in backup: /'
    bexec psql -d postgres -qc 'DROP DATABASE ooc_restore_drill'
    echo "Drill OK — record the date, dump name and ${secs}s in docs/evidence/ (launch gate: restore rehearsal)."
    ;;
  replace)
    [[ -n "$DUMP" ]] || die "replace needs an explicit dump name (see: restore.sh list)."
    d=$(resolve_dump "$DUMP")
    echo "About to REPLACE the live 'ooc' database in project '$PROJECT' with $d."
    echo "Payments, supplier actions and sign-ups after that dump will be lost and must be reconciled"
    echo "(docs/runbooks/backup-restore.md → 'After a real restore')."
    read -r -p "Type the project name to continue: " confirm
    [[ "$confirm" == "$PROJECT" ]] || die "Aborted."
    mapfile -t app < <(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Label "com.docker.compose.service"}}' | awk '$2=="api"||$2=="worker"||$2=="web"{print $1}')
    echo "Stopping: ${app[*]:-none}"
    [[ ${#app[@]} -gt 0 ]] && docker stop "${app[@]}" >/dev/null
    echo "Safety dump of the current database first…"
    "$0" -p "$PROJECT" backup
    bexec psql -d postgres -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ooc' AND pid <> pg_backend_pid()" >/dev/null
    bexec psql -d postgres -qc 'DROP DATABASE ooc' -c 'CREATE DATABASE ooc OWNER ooc'
    bexec pg_restore --no-owner --role=ooc --exit-on-error -d ooc "$d"
    echo "Restored. Rows: $(counts ooc)"
    [[ ${#app[@]} -gt 0 ]] && docker start "${app[@]}" >/dev/null
    echo "Application containers started. Keep CASHFREE/RESELLERCLUB disabled until reconciliation is complete."
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 2
    ;;
esac
