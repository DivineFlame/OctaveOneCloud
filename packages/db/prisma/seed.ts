/**
 * Seeds the catalogue skeleton. Everything is created as DRAFT and NOT purchasable:
 *  - The live OctaveOneCloud catalogue and the ResellerClub account's enabled products have not been verified.
 *  - Hosted apps have no configured adapters yet.
 *  - No prices are seeded: prices must come from verified supplier cost or measured delivery cost.
 *  - Tax rules are seeded unreviewed; live quotes refuse unreviewed rules until an accountant signs off.
 * Idempotent: safe to run repeatedly.
 */
import { createPrismaClient, FulfillmentKind, MergePolicy, PlanTier, ProductFamily } from '../src';

const db = createPrismaClient(process.env.DATABASE_URL!);

const CATALOGUE_UNVERIFIED = 'Current catalogue and ResellerClub account capability not yet verified (Stage 0).';
const APP_UNCONFIGURED = 'Roadmap: app adapter not configured and app licensing/operation not verified.';

type ProductSeed = {
  key: string;
  name: string;
  family: ProductFamily;
  fulfillment: FulfillmentKind;
  adapterKey?: string;
  taxCategory: string;
  note: string;
  tiers: PlanTier[];
  description?: string;
};

const features: { key: string; name: string; unit?: string; mergePolicy: MergePolicy; metered?: boolean }[] = [
  { key: 'seats', name: 'User seats', unit: 'seats', mergePolicy: 'max' },
  { key: 'crm.access', name: 'CRM access', mergePolicy: 'boolean' },
  { key: 'crm.active_contacts', name: 'Active contacts', unit: 'contacts', mergePolicy: 'max' },
  { key: 'marketing.access', name: 'Marketing workspace access', mergePolicy: 'boolean' },
  { key: 'marketing.brands', name: 'Brands', unit: 'brands', mergePolicy: 'max' },
  { key: 'marketing.channels', name: 'Connected channels', unit: 'channels', mergePolicy: 'max' },
  { key: 'support.access', name: 'Support desk access', mergePolicy: 'boolean' },
  { key: 'support.conversations', name: 'Conversations', unit: 'conversations', mergePolicy: 'max', metered: true },
  { key: 'workflow.access', name: 'Workflow automation access', mergePolicy: 'boolean' },
  { key: 'workflow.executions', name: 'Workflow executions', unit: 'executions', mergePolicy: 'max', metered: true },
  { key: 'workflow.connectors', name: 'Connected accounts', unit: 'connectors', mergePolicy: 'max' },
  { key: 'knowledge.access', name: 'Knowledge assistant access', mergePolicy: 'boolean' },
  { key: 'storage.gb', name: 'Storage', unit: 'gb', mergePolicy: 'max', metered: true },
  { key: 'ai.credits', name: 'AI usage credits', unit: 'credits', mergePolicy: 'additive', metered: true },
  { key: 'agent.approval_policy', name: 'Human approval policy for agent actions', mergePolicy: 'boolean' },
];

const products: ProductSeed[] = [
  { key: 'domain-registration', name: 'Domain registration & transfer', family: 'domains', fulfillment: 'resellerclub', adapterKey: 'resellerclub.domain', taxCategory: 'domain', note: CATALOGUE_UNVERIFIED, tiers: ['standard'] },
  { key: 'shared-hosting', name: 'Shared / WordPress hosting', family: 'web_infrastructure', fulfillment: 'resellerclub', adapterKey: 'resellerclub.hosting', taxCategory: 'hosting', note: CATALOGUE_UNVERIFIED + ' Reseller-hosting packages are excluded from sale.', tiers: ['standard'] },
  { key: 'vps', name: 'VPS', family: 'web_infrastructure', fulfillment: 'resellerclub', adapterKey: 'resellerclub.vps', taxCategory: 'hosting', note: CATALOGUE_UNVERIFIED, tiers: ['standard'] },
  { key: 'business-email', name: 'Business email', family: 'business_essentials', fulfillment: 'resellerclub', adapterKey: 'resellerclub.email', taxCategory: 'saas', note: CATALOGUE_UNVERIFIED, tiers: ['standard'] },
  { key: 'ssl-certificate', name: 'SSL certificate', family: 'business_essentials', fulfillment: 'resellerclub', adapterKey: 'resellerclub.ssl', taxCategory: 'saas', note: CATALOGUE_UNVERIFIED, tiers: ['standard'] },
  { key: 'crm', name: 'CRM', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.crm', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'] },
  { key: 'marketing-workspace', name: 'Marketing workspace', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.marketing', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'] },
  { key: 'support-desk', name: 'Support desk', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.support', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'] },
  { key: 'workflow-automation', name: 'Workflow automation', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.workflow', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'] },
  { key: 'knowledge-assistant', name: 'Knowledge assistant', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.knowledge', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'] },
  { key: 'bundle-sales-desk', name: 'Sales Desk', family: 'agentic_bundles', fulfillment: 'bundle', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'], description: 'CRM + lead qualification + follow-up drafting + task automation' },
  { key: 'bundle-marketing-desk', name: 'Marketing Desk', family: 'agentic_bundles', fulfillment: 'bundle', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'], description: 'Content workspace + campaign planning + approval queue + publishing connectors' },
  { key: 'bundle-support-desk', name: 'Support Desk', family: 'agentic_bundles', fulfillment: 'bundle', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'], description: 'Knowledge base + chat assistant + ticket escalation' },
  { key: 'bundle-business-operations', name: 'Business Operations', family: 'agentic_bundles', fulfillment: 'bundle', taxCategory: 'saas', note: APP_UNCONFIGURED, tiers: ['starter', 'growth', 'business'], description: 'Selected apps + workflow orchestration + reporting' },
  { key: 'managed-setup', name: 'Setup & onboarding', family: 'managed_services', fulfillment: 'manual_service', taxCategory: 'services', note: 'Scope and pricing to be defined.', tiers: ['standard'] },
  { key: 'managed-migration', name: 'Migration service', family: 'managed_services', fulfillment: 'manual_service', taxCategory: 'services', note: 'Scope and pricing to be defined.', tiers: ['standard'] },
];

// Boolean access features per app; numeric allowances are intentionally NOT seeded (pending capacity/cost measurement).
const appAccess: Record<string, string[]> = {
  crm: ['crm.access'],
  'marketing-workspace': ['marketing.access'],
  'support-desk': ['support.access'],
  'workflow-automation': ['workflow.access'],
  'knowledge-assistant': ['knowledge.access'],
};

const bundleComponents: Record<string, string[]> = {
  'bundle-sales-desk': ['crm', 'workflow-automation'],
  'bundle-marketing-desk': ['marketing-workspace', 'workflow-automation'],
  'bundle-support-desk': ['support-desk', 'knowledge-assistant'],
  'bundle-business-operations': ['workflow-automation', 'crm'],
};

async function main() {
  for (const f of features) {
    await db.feature.upsert({ where: { key: f.key }, update: { name: f.name, unit: f.unit, metered: f.metered ?? false }, create: { ...f, metered: f.metered ?? false } });
  }

  const versionIds = new Map<string, string>(); // `${productKey}:${tier}` -> planVersionId
  for (const p of products) {
    const product = await db.product.upsert({
      where: { key: p.key },
      update: { name: p.name, verificationNote: p.note, description: p.description },
      create: { key: p.key, name: p.name, family: p.family, fulfillment: p.fulfillment, adapterKey: p.adapterKey, taxCategory: p.taxCategory, verificationNote: p.note, description: p.description, status: 'draft' },
    });
    for (const tier of p.tiers) {
      const key = `${p.key}-${tier}`;
      const plan = await db.plan.upsert({ where: { key }, update: {}, create: { key, name: `${p.name} ${tier[0]!.toUpperCase()}${tier.slice(1)}`, tier, productId: product.id } });
      const version = await db.planVersion.upsert({ where: { planId_version: { planId: plan.id, version: 1 } }, update: {}, create: { planId: plan.id, version: 1 } });
      versionIds.set(`${p.key}:${tier}`, version.id);
      for (const featureKey of appAccess[p.key] ?? []) {
        await db.planFeature.upsert({ where: { planVersionId_featureKey: { planVersionId: version.id, featureKey } }, update: {}, create: { planVersionId: version.id, featureKey } });
      }
    }
  }

  for (const [bundleKey, components] of Object.entries(bundleComponents)) {
    for (const tier of ['starter', 'growth', 'business'] as const) {
      const bundleVersionId = versionIds.get(`${bundleKey}:${tier}`)!;
      for (const [i, componentKey] of components.entries()) {
        const componentVersionId = versionIds.get(`${componentKey}:${tier}`)!;
        await db.bundleComponent.upsert({
          where: { bundleVersionId_componentVersionId: { bundleVersionId, componentVersionId } },
          update: {},
          create: { bundleVersionId, componentVersionId, provisionOrder: i },
        });
      }
    }
  }

  const adapters = [
    ['resellerclub.domain', 'ResellerClub domains'],
    ['resellerclub.hosting', 'ResellerClub hosting'],
    ['resellerclub.vps', 'ResellerClub VPS'],
    ['resellerclub.email', 'ResellerClub business email'],
    ['resellerclub.ssl', 'ResellerClub SSL'],
    ['app.crm', 'CRM app'],
    ['app.marketing', 'Marketing workspace app'],
    ['app.support', 'Support desk app'],
    ['app.workflow', 'Workflow automation app'],
    ['app.knowledge', 'Knowledge assistant app'],
  ] as const;
  for (const [key, name] of adapters) {
    await db.appAdapter.upsert({ where: { key }, update: {}, create: { key, name, status: 'unconfigured' } });
  }

  const existingRules = await db.taxRule.count();
  if (existingRules === 0) {
    const note = 'PLACEHOLDER — requires accountant review before use in live quotes.';
    for (const category of ['saas', 'hosting', 'domain', 'services']) {
      await db.taxRule.createMany({
        data: [
          { taxCategory: category, supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], notes: note },
          { taxCategory: category, supplyType: 'inter_state', components: [{ name: 'IGST', rateBps: 1800 }], notes: note },
        ],
      });
    }
  }

  const counts = { products: await db.product.count(), plans: await db.plan.count(), bundles: await db.bundleComponent.count(), adapters: await db.appAdapter.count() };
  console.log('Seeded draft catalogue:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
