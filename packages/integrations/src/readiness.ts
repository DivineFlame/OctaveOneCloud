import { PrismaClient } from '@ooc/db';
import { AppConfig, appEnv, isInsecureHttp, sellerProfile } from '@ooc/shared';
import { costDrift } from './resellerclub/pricing';

/**
 * Launch readiness: what the running system can check about itself, plus the manual launch gates it cannot
 * verify (they stay `manual` until a person records evidence). Never includes secret values.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'manual';
export interface ReadinessCheck {
  id: string;
  area: 'configuration' | 'payments' | 'tax' | 'catalogue' | 'operations' | 'security' | 'launch_gate';
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessReport {
  generatedAt: string;
  appEnv: string;
  summary: Record<CheckStatus, number>;
  /** True when nothing fails. Manual gates still need sign-off before taking real payments. */
  automatedChecksPass: boolean;
  checks: ReadinessCheck[];
}

const MANUAL_GATES: [string, string][] = [
  ['gate.merchant_activation', 'Cashfree production account activated; ResellerClub live account and IP allowlist confirmed'],
  ['gate.webhooks', 'Production webhook URL configured in Cashfree and a signed test event received'],
  ['gate.capabilities', 'Every product for sale has verified capabilities and prices (docs/provider-capabilities.md + docs/evidence/)'],
  ['gate.accountant', 'Accountant sign-off on tax rules, SAC codes, invoice and credit-note format, e-invoicing applicability'],
  ['gate.staging', 'Deployed to a staging project (APP_ENV=staging, sandboxes) and the purchase → invoice → refund path smoke-tested'],
  ['gate.restore', 'Restore drill on the VPS recorded (restore.sh drill) and an off-site backup copy verified'],
  ['gate.load', 'Load test run and measured capacity recorded'],
  ['gate.security', 'Security review: dependency audit, headers, auth flows, penetration test'],
  ['gate.reconciliation', 'Reconciliation sign-off: payments ↔ orders ↔ invoices ↔ supplier records'],
  ['gate.migration', 'Existing-customer migration rehearsed (no re-ordering, no re-charging) or not applicable'],
  ['gate.authorisation', 'Explicit release authorisation by the business owner'],
];

export async function launchReadiness(db: PrismaClient, c: AppConfig, now = new Date()): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, area: ReadinessCheck['area'], title: string, status: CheckStatus, detail: string) => checks.push({ id, area, title, status, detail });
  const env = appEnv(c);

  // ── Configuration ──
  add('config.app_env', 'configuration', 'APP_ENV is production', env === 'production' ? 'pass' : 'warn', `APP_ENV=${env}`);
  const https = c.APP_URL.startsWith('https://') && c.API_URL.startsWith('https://');
  add('config.https', 'security', 'Site served over HTTPS', https && !isInsecureHttp(c) ? 'pass' : 'fail', https ? 'APP_URL and API_URL use https' : 'APP_URL/API_URL are not https (IP:port trial mode must not take real customers)');
  add('config.cookie_secure', 'security', 'Session cookies are Secure', c.COOKIE_SECURE ? 'pass' : 'fail', `COOKIE_SECURE=${c.COOKIE_SECURE}`);
  add('config.smtp', 'configuration', 'Email delivery configured', c.SMTP_URL && c.MAIL_FROM ? 'pass' : 'fail', c.SMTP_URL ? 'SMTP_URL and MAIL_FROM set' : 'SMTP_URL missing');
  add('config.support_email', 'operations', 'Support notifications go to a mailbox', c.SUPPORT_NOTIFY_EMAIL ? 'pass' : 'warn', c.SUPPORT_NOTIFY_EMAIL ? 'SUPPORT_NOTIFY_EMAIL set' : 'New tickets are only visible in the admin queue');
  // No error-tracking SDK is built in yet (SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT are reserved names).
  add('config.monitoring', 'operations', 'Monitoring in place', 'warn', 'Structured JSON logs only: set up Dokploy notifications, an external uptime check and log review (docs/deploy-vps.md §7)');

  // ── Payments ──
  add('payments.cashfree_env', 'payments', 'Cashfree in production mode', c.CASHFREE_ENV === 'production' ? 'pass' : 'fail', `CASHFREE_ENV=${c.CASHFREE_ENV}`);
  add('payments.webhook_secret', 'payments', 'Webhook signature secret set', c.CASHFREE_WEBHOOK_SECRET ? 'pass' : 'fail', c.CASHFREE_WEBHOOK_SECRET ? 'configured' : 'CASHFREE_WEBHOOK_SECRET missing: webhooks would be rejected');
  const lastWebhook = await db.webhookInbox.findFirst({ where: { provider: 'cashfree' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } });
  add('payments.webhook_seen', 'payments', 'A signed Cashfree webhook has been received', lastWebhook ? 'pass' : 'warn', lastWebhook ? `last at ${lastWebhook.receivedAt.toISOString()}` : 'none received yet');
  add('payments.mandates', 'payments', 'Automatic renewal collection (mandates)', c.CASHFREE_SUBSCRIPTIONS_ENABLED ? 'warn' : 'pass',
    c.CASHFREE_SUBSCRIPTIONS_ENABLED ? 'CASHFREE_SUBSCRIPTIONS_ENABLED=true but mandate collection is not implemented; renewals stay customer-paid' : 'Renewals are customer-paid (documented)');

  // ── Tax and invoicing ──
  const seller = sellerProfile(c);
  add('tax.seller', 'tax', 'Seller details for invoices', seller ? 'pass' : 'fail', seller ? `${seller.legalName}, state ${seller.stateCode}` : 'SELLER_LEGAL_NAME / SELLER_ADDRESS / SELLER_STATE_CODE missing');
  add('tax.seller_gstin', 'tax', 'Seller GSTIN set', c.SELLER_GSTIN ? 'pass' : 'warn', c.SELLER_GSTIN ? 'set' : 'Not set — confirm registration status with the accountant');
  const activeProducts = await db.product.findMany({ where: { status: 'active' }, select: { key: true, taxCategory: true, fulfillment: true, adapterKey: true } });
  const categories = [...new Set(activeProducts.map((p) => p.taxCategory))];
  const rules = await db.taxRule.findMany({ where: { taxCategory: { in: categories }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } });
  const unreviewed = categories.filter((cat) => !rules.some((r) => r.taxCategory === cat && r.reviewed));
  add('tax.rules_reviewed', 'tax', 'Tax rules for products on sale are reviewed', categories.length === 0 ? 'warn' : unreviewed.length ? 'fail' : 'pass',
    categories.length === 0 ? 'no active products' : unreviewed.length ? `unreviewed: ${unreviewed.join(', ')}` : `${categories.length} categories reviewed`);
  const noSac = [...new Set(rules.filter((r) => r.reviewed && !r.sacCode).map((r) => r.taxCategory))];
  add('tax.sac_codes', 'tax', 'SAC codes set for invoiced categories', noSac.length ? 'warn' : 'pass', noSac.length ? `missing for: ${noSac.join(', ')}` : 'all set');
  const awaitingInvoice = await db.order.count({ where: { paidAt: { not: null }, invoices: { none: {} } } });
  add('tax.invoices_current', 'tax', 'Every paid order has an invoice', awaitingInvoice ? 'warn' : 'pass', awaitingInvoice ? `${awaitingInvoice} paid orders without invoice` : 'up to date');

  // ── Catalogue and fulfilment ──
  add('catalogue.products', 'catalogue', 'Products are on sale', activeProducts.length ? 'pass' : 'fail', `${activeProducts.length} active products`);
  // Bundles count through their components' apps.
  const bundleComponents = await db.bundleComponent.findMany({
    where: { bundleVersion: { publishedAt: { not: null }, retiredAt: null, plan: { product: { status: 'active', fulfillment: 'bundle' } } } },
    select: { componentVersion: { select: { plan: { select: { product: { select: { fulfillment: true, adapterKey: true } } } } } } },
  });
  const adapterKeys = [...new Set([
    ...activeProducts.filter((p) => p.fulfillment === 'app_adapter' && p.adapterKey).map((p) => p.adapterKey!),
    ...bundleComponents.map((b) => b.componentVersion.plan.product).filter((p) => p.fulfillment === 'app_adapter' && p.adapterKey).map((p) => p.adapterKey!),
  ])];
  const adapters = await db.appAdapter.findMany({ where: { key: { in: adapterKeys } } });
  const notLive = adapterKeys.filter((k) => adapters.find((a) => a.key === k)?.status !== 'active');
  add('catalogue.adapters', 'catalogue', 'App adapters for products on sale are active (not sandbox)', notLive.length ? 'fail' : 'pass', notLive.length ? `not active: ${notLive.join(', ')}` : `${adapterKeys.length} active`);
  const rcProducts = activeProducts.filter((p) => p.fulfillment === 'resellerclub');
  if (c.RESELLERCLUB_ENV !== 'disabled') {
    const snap = await db.supplierPriceSnapshot.findFirst({ where: { provider: 'resellerclub', kind: 'cost', environment: c.RESELLERCLUB_ENV }, orderBy: { fetchedAt: 'desc' } });
    const fresh = snap && now.getTime() - snap.checkedAt.getTime() < 48 * 3600_000;
    add('catalogue.supplier_prices', 'catalogue', 'ResellerClub cost prices are current', fresh ? 'pass' : 'warn',
      snap ? `last checked ${snap.checkedAt.toISOString()}${fresh ? '' : ' (older than 48 h)'}` : 'never fetched — Admin → ResellerClub prices → Fetch prices now');
    if (c.RESELLERCLUB_CURRENCY !== 'INR') add('catalogue.supplier_currency', 'catalogue', 'ResellerClub account currency matches the catalogue', 'warn', `RESELLERCLUB_CURRENCY=${c.RESELLERCLUB_CURRENCY}; supplier costs cannot be used for INR prices`);
    const drift = await costDrift(db, c.RESELLERCLUB_ENV, now);
    add('catalogue.cost_drift', 'catalogue', 'No supplier cost changes behind prices on sale', drift.length ? 'warn' : 'pass', drift.length ? `${drift.length} price(s) affected — see Admin → ResellerClub prices` : 'none');
  }
  if (rcProducts.length) {
    const live = c.RESELLERCLUB_ENV === 'live' && c.RESELLERCLUB_ALLOW_LIVE_MUTATIONS;
    add('catalogue.resellerclub', 'catalogue', 'ResellerClub live for supplier products', live ? 'pass' : 'fail', `RESELLERCLUB_ENV=${c.RESELLERCLUB_ENV}, live mutations ${c.RESELLERCLUB_ALLOW_LIVE_MUTATIONS ? 'allowed' : 'blocked'}`);
  }

  // ── Operations and security ──
  const admins = await db.user.findMany({ where: { operatorRole: { not: null } }, select: { operatorRole: true, mfaEnabledAt: true } });
  const mfaAdmins = admins.filter((a) => a.operatorRole === 'operator_admin' && a.mfaEnabledAt).length;
  add('security.operator_mfa', 'security', 'An operator admin with MFA exists', mfaAdmins ? 'pass' : 'fail', `${mfaAdmins} admin(s) with MFA`);
  const withoutMfa = admins.filter((a) => !a.mfaEnabledAt).length;
  add('security.all_operators_mfa', 'security', 'All operators have MFA', withoutMfa ? 'warn' : 'pass', withoutMfa ? `${withoutMfa} operator(s) without MFA (they cannot use admin routes)` : 'all enabled');
  add('operations.finance_operator', 'operations', 'A finance operator exists (refunds, credit notes)', admins.some((a) => a.operatorRole === 'operator_finance' && a.mfaEnabledAt) ? 'pass' : 'warn', 'operator_finance with MFA');
  const pendingMigrations = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`.catch(() => [{ n: -1n }]);
  const pm = Number(pendingMigrations[0]?.n ?? -1);
  add('operations.migrations', 'operations', 'All database migrations applied cleanly', pm === 0 ? 'pass' : 'fail', pm === 0 ? 'ok' : pm < 0 ? 'migration table unreadable' : `${pm} unfinished/rolled back`);
  const [deadWebhooks, stuckJobs, unknownSupplier, lifecycleErrors, refundErrors] = await Promise.all([
    db.webhookInbox.count({ where: { status: 'failed' } }),
    db.provisioningJob.count({ where: { status: { in: ['failed', 'partially_failed', 'unknown_outcome'] } } }),
    db.supplierOperation.count({ where: { status: 'unknown' } }),
    db.subscription.count({ where: { lastLifecycleError: { not: null } } }),
    db.refund.count({ where: { status: { in: ['requested', 'pending'] }, updatedAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } }),
  ]);
  const backlog = deadWebhooks + stuckJobs + unknownSupplier + lifecycleErrors + refundErrors;
  add('operations.backlog', 'operations', 'No unresolved failures', backlog ? 'warn' : 'pass',
    backlog ? `webhooks failed ${deadWebhooks}, provisioning ${stuckJobs}, supplier unknown ${unknownSupplier}, subscription errors ${lifecycleErrors}, refunds >24h ${refundErrors}` : 'none');

  for (const [id, title] of MANUAL_GATES) add(id, 'launch_gate', title, 'manual', 'Record evidence in docs/evidence/ and tick it in docs/PROGRESS.md');

  const order: ReadinessCheck['area'][] = ['security', 'configuration', 'payments', 'tax', 'catalogue', 'operations', 'launch_gate'];
  checks.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area)); // stable: keeps order within an area
  const summary = { pass: 0, fail: 0, warn: 0, manual: 0 } as Record<CheckStatus, number>;
  for (const ch of checks) summary[ch.status]++;
  return { generatedAt: now.toISOString(), appEnv: env, summary, automatedChecksPass: summary.fail === 0, checks };
}
