#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OctaveOneCloud — fresh VPS bootstrap for Ubuntu 24.04 LTS, then Dokploy install.
#
# Run ONCE as root on a brand-new server (after adding your SSH key to the provider):
#   curl -fsSLo setup-ubuntu.sh https://raw.githubusercontent.com/DivineFlame/OctaveOneCloud/main/deploy/vps/setup-ubuntu.sh
#   less setup-ubuntu.sh          # read it first
#   sudo bash setup-ubuntu.sh
#
# Options (environment variables):
#   DEPLOY_USER=ooc        create this sudo user and copy root's authorized SSH keys to it (default: ooc; empty = skip)
#   SWAP_SIZE_GB=4         swap file size when the server has no swap (0 = skip)
#   TIMEZONE=UTC           server timezone (keep UTC; the app stores UTC)
#   INSTALL_DOKPLOY=yes    run the official Dokploy installer at the end
#   ASSUME_YES=no          yes = do not ask for confirmation
#
# Safe to re-run: every step checks before changing anything.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER-ooc}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-4}"
TIMEZONE="${TIMEZONE:-UTC}"
INSTALL_DOKPLOY="${INSTALL_DOKPLOY:-yes}"
ASSUME_YES="${ASSUME_YES:-no}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo bash $0)."
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "This script targets Ubuntu (found: ${PRETTY_NAME:-unknown})."
[[ "${VERSION_ID:-}" == "24.04" ]] || warn "Tested on Ubuntu 24.04; found ${VERSION_ID:-unknown}. Continuing."

for port in 80 443 3000; do
  if ss -ltnH "sport = :$port" | grep -q .; then
    if ! docker service ls 2>/dev/null | grep -q dokploy; then
      die "Port $port is already in use. Dokploy needs 80, 443 and 3000 free (stop Apache/Nginx first)."
    fi
  fi
done

mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
log "Server: ${PRETTY_NAME}, ${mem_mb} MB RAM, ${disk_gb} GB free disk"
(( mem_mb >= 3500 )) || warn "Less than 4 GB RAM: building the web app may fail without swap. 8 GB recommended."
(( disk_gb >= 30 )) || warn "Less than 30 GB free disk. 40 GB+ recommended (images, database, backups)."

if [[ "$ASSUME_YES" != "yes" ]]; then
  read -r -p "Harden this server and install Dokploy? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "Aborted."
fi

export DEBIAN_FRONTEND=noninteractive

log "Updating packages"
apt-get update -y
apt-get -o Dpkg::Options::="--force-confold" upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges \
  htop jq git logrotate

log "Timezone and time sync"
timedatectl set-timezone "$TIMEZONE"
timedatectl set-ntp true || true

log "Automatic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Security updates only; no automatic reboot (reboot manually in a maintenance window).
sed -i 's#^//\?\s*Unattended-Upgrade::Automatic-Reboot .*#Unattended-Upgrade::Automatic-Reboot "false";#' /etc/apt/apt.conf.d/50unattended-upgrades || true

if (( SWAP_SIZE_GB > 0 )) && ! swapon --show | grep -q .; then
  log "Creating ${SWAP_SIZE_GB} GB swap file"
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Kernel settings (Redis/Postgres friendly)"
cat >/etc/sysctl.d/99-octaveonecloud.conf <<'EOF'
vm.swappiness = 10
vm.overcommit_memory = 1
net.core.somaxconn = 1024
fs.inotify.max_user_watches = 524288
EOF
sysctl --system >/dev/null

if [[ -n "$DEPLOY_USER" ]]; then
  log "Admin user: $DEPLOY_USER"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
  fi
  usermod -aG sudo "$DEPLOY_USER"
  if [[ -s /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
    install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
  fi
  echo "Set a sudo password for $DEPLOY_USER later with: passwd $DEPLOY_USER"
fi

log "SSH hardening"
if [[ -s /root/.ssh/authorized_keys ]] || { [[ -n "$DEPLOY_USER" ]] && [[ -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]]; }; then
  cat >/etc/ssh/sshd_config.d/99-octaveonecloud.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 4
X11Forwarding no
EOF
  sshd -t && systemctl reload ssh
else
  warn "No SSH key found in /root/.ssh/authorized_keys — password login left ENABLED to avoid locking you out. Add a key and re-run."
fi

log "fail2ban (SSH brute-force protection)"
cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

log "Firewall (ufw): SSH, HTTP, HTTPS, Dokploy panel"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
# Dokploy panel on :3000 until you give it a domain (docs/deploy-vps.md step 4), then: ufw delete allow 3000/tcp
ufw allow 3000/tcp >/dev/null
ufw --force enable >/dev/null
ufw status verbose
# Note: Docker publishes ports around ufw. The OctaveOneCloud stack publishes NO ports; only Dokploy's
# Traefik (80/443) and panel (3000) are exposed. Never add `ports:` for postgres/redis/api.

log "Docker log rotation defaults"
install -d /etc/docker
if [[ ! -s /etc/docker/daemon.json ]]; then
  cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
fi

if [[ "$INSTALL_DOKPLOY" == "yes" ]]; then
  if docker service ls 2>/dev/null | grep -q dokploy; then
    log "Dokploy is already installed — skipping"
  else
    log "Installing Dokploy (official installer: https://dokploy.com/install.sh)"
    curl -sSL https://dokploy.com/install.sh | sh
  fi
fi

public_ip=$(curl -fsS --max-time 10 https://api.ipify.org || echo "unknown")
cat <<EOF

────────────────────────────────────────────────────────────────────
 Done.
 Public / outbound IP : ${public_ip}
   → point your DNS A records here (app + panel domains)
   → allowlist this IP in ResellerClub before enabling that integration
 Dokploy panel        : http://${public_ip}:3000   (create the admin account NOW)
 Next steps           : docs/deploy-vps.md, from step 4
────────────────────────────────────────────────────────────────────
EOF
