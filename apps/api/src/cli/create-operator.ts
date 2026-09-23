/**
 * Bootstrap an internal operator account.
 *   OOC_OPERATOR_PASSWORD='...' node apps/api/dist/cli/create-operator.js --email ops@example.com --role operator_admin
 * The password is read from the environment (not argv) to keep it out of shell history and process lists.
 * The operator must enable MFA (Dashboard → Security) before any operator endpoint will respond.
 */
import { createPrismaClient } from '@ooc/db';
import { OPERATOR_ROLES, OperatorRole, loadConfig } from '@ooc/shared';
import { hashPassword, PASSWORD_MIN } from '../auth/passwords';

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const email = get('--email')?.trim().toLowerCase();
  const role = (get('--role') ?? 'operator_admin') as OperatorRole;
  const password = process.env.OOC_OPERATOR_PASSWORD;
  if (!email || !OPERATOR_ROLES.includes(role)) throw new Error(`Usage: --email <email> --role <${OPERATOR_ROLES.join('|')}>`);
  if (!password || password.length < PASSWORD_MIN) throw new Error(`Set OOC_OPERATOR_PASSWORD (min ${PASSWORD_MIN} characters)`);
  const config = loadConfig(process.env);
  const db = createPrismaClient(config.DATABASE_URL);
  try {
    const user = await db.user.upsert({
      where: { email },
      update: { operatorRole: role },
      create: { email, operatorRole: role, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() },
    });
    await db.auditEvent.create({ data: { actorType: 'system', action: 'operator.bootstrapped', targetType: 'user', targetId: user.id, metadata: { role } } });
    process.stdout.write(`Operator ${email} ready with role ${role}. Enable MFA at first sign-in.\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
