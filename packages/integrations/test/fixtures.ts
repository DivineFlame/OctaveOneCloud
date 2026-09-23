import { createPrismaClient, PrismaClient, ProductFamily, FulfillmentKind } from '@ooc/db';
import { truncateAll } from '@ooc/db/testing';

export const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL!);

export async function reset() {
  await truncateAll(db);
}

export async function makeOrg(name = 'Acme') {
  return db.organization.create({ data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, stateCode: '29' } });
}

export async function makeFeature(key: string, mergePolicy: 'max' | 'additive' | 'boolean' = 'max') {
  return db.feature.upsert({ where: { key }, update: {}, create: { key, name: key, mergePolicy } });
}

export async function makeProduct(opts: { key: string; fulfillment: FulfillmentKind; adapterKey?: string; adapterStatus?: 'unconfigured' | 'sandbox' | 'active'; family?: ProductFamily; amountMinor?: number; features?: { key: string; limit: number | null }[] }) {
  if (opts.adapterKey) {
    await db.appAdapter.upsert({ where: { key: opts.adapterKey }, update: { status: opts.adapterStatus ?? 'sandbox' }, create: { key: opts.adapterKey, name: opts.adapterKey, status: opts.adapterStatus ?? 'sandbox' } });
  }
  const product = await db.product.create({
    data: { key: opts.key, name: opts.key, family: opts.family ?? 'hosted_apps', fulfillment: opts.fulfillment, adapterKey: opts.adapterKey, taxCategory: 'saas', status: 'active' },
  });
  const plan = await db.plan.create({ data: { productId: product.id, key: `${opts.key}-starter`, name: `${opts.key} Starter`, tier: 'starter' } });
  const version = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  for (const f of opts.features ?? []) {
    await makeFeature(f.key, f.limit === null ? 'boolean' : 'max');
    await db.planFeature.create({ data: { planVersionId: version.id, featureKey: f.key, limit: f.limit === null ? null : BigInt(f.limit) } });
  }
  const price = await db.priceVersion.create({ data: { planVersionId: version.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: BigInt(opts.amountMinor ?? 99900) } });
  await db.planVersion.update({ where: { id: version.id }, data: { publishedAt: new Date() } });
  return { product, plan, version, price };
}

export async function makePaidPendingOrder(orgId: string, items: { priceVersionId: string; totalMinor: number }[]) {
  const total = items.reduce((a, i) => a + i.totalMinor, 0);
  const order = await db.order.create({
    data: {
      orgId,
      status: 'awaiting_payment',
      totalMinor: BigInt(total),
      idempotencyKey: `idem-${Math.random()}`,
      items: { create: items.map((i) => ({ priceVersionId: i.priceVersionId, quantity: 1, totalMinor: BigInt(i.totalMinor) })) },
    },
    include: { items: true },
  });
  const po = await db.paymentOrder.create({ data: { orgId, orderId: order.id, environment: 'sandbox', providerOrderId: `ooc-${order.id}`, amountMinor: BigInt(total), currency: 'INR', status: 'active' } });
  return { order, po };
}
