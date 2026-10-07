import { Prisma, PrismaClient, ProvisioningStatus } from '@ooc/db';
import { redact } from '@ooc/shared';
import { AdapterRegistry, EntitlementPayload } from '../adapters/contract';

/**
 * Durable provisioning workflow. A job covers one paid order item; bundles expand into one step per
 * component (in provisionOrder). A step becomes `active` only with evidence from its adapter.
 * Unknown outcomes stop the job for reconciliation; nothing is blindly retried.
 */

interface StepPlan {
  name: string;
  adapterKey: string | null;
  planVersionId: string;
  fulfillment: string;
}

export interface ProvisioningResult {
  jobId: string;
  status: ProvisioningStatus;
  steps: { name: string; status: ProvisioningStatus; error?: string }[];
}

export async function runProvisioningJob(db: PrismaClient, adapters: AdapterRegistry, jobId: string): Promise<ProvisioningResult> {
  const claimed = await db.provisioningJob.updateMany({ where: { id: jobId, status: { in: ['queued', 'partially_failed'] } }, data: { status: 'running', attempts: { increment: 1 } } });
  const job = await db.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, include: { steps: true } });
  if (claimed.count === 0) return { jobId, status: job.status, steps: job.steps.map((s) => ({ name: s.name, status: s.status })) };
  if (!job.orderItemId) throw new Error('Provisioning job without order item');

  const item = await db.orderItem.findUniqueOrThrow({ where: { id: job.orderItemId } });
  const price = await db.priceVersion.findUniqueOrThrow({ where: { id: item.priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } });
  const product = price.planVersion.plan.product;

  const plan: StepPlan[] = [];
  if (product.fulfillment === 'bundle') {
    const comps = await db.bundleComponent.findMany({
      where: { bundleVersionId: price.planVersionId },
      orderBy: { provisionOrder: 'asc' },
      include: { componentVersion: { include: { plan: { include: { product: true } } } } },
    });
    for (const c of comps) {
      const p = c.componentVersion.plan.product;
      plan.push({ name: `component:${p.key}`, adapterKey: p.adapterKey, planVersionId: c.componentVersionId, fulfillment: p.fulfillment });
    }
  } else {
    plan.push({ name: `product:${product.key}`, adapterKey: product.adapterKey, planVersionId: price.planVersionId, fulfillment: product.fulfillment });
  }

  const results: ProvisioningResult['steps'] = [];
  let stop = false;
  for (const stepPlan of plan) {
    const step = await db.provisioningStep.upsert({ where: { jobId_name: { jobId, name: stepPlan.name } }, update: {}, create: { jobId, name: stepPlan.name } });
    if (step.status === 'active') {
      results.push({ name: step.name, status: 'active' });
      continue;
    }
    if (stop) {
      results.push({ name: step.name, status: step.status });
      continue;
    }
    await db.provisioningStep.update({ where: { id: step.id }, data: { status: 'running', startedAt: new Date(), error: null } });

    if (price.kind === 'usage_pack') {
      // Prepaid usage: an additive, expiring grant enforced by our quota API — no app call needed.
      const packFeatures = await db.planFeature.findMany({ where: { planVersionId: stepPlan.planVersionId }, include: { feature: true } });
      const invalid = packFeatures.filter((f) => !f.feature.metered || f.feature.mergePolicy !== 'additive' || f.limit === null);
      if (packFeatures.length === 0 || invalid.length) {
        const error = packFeatures.length === 0 ? 'usage_pack_without_features' : `usage_pack_feature_not_additive_metered: ${invalid.map((f) => f.featureKey).join(',')}`;
        await finishStep(db, step.id, 'failed', undefined, error);
        results.push({ name: step.name, status: 'failed', error });
        continue;
      }
      const validFrom = new Date();
      const validTo = addIsoDuration(validFrom, price.billingInterval);
      await db.$transaction(async (tx) => {
        for (const f of packFeatures) {
          const sourceId = `${item.id}:${stepPlan.planVersionId}`;
          await tx.entitlement.upsert({
            where: { orgId_featureKey_sourceType_sourceId: { orgId: job.orgId, featureKey: f.featureKey, sourceType: 'usage_pack', sourceId } },
            update: {},
            create: { orgId: job.orgId, featureKey: f.featureKey, mergePolicy: 'additive', limit: f.limit! * BigInt(item.quantity), sourceType: 'usage_pack', sourceId, validFrom, validTo },
          });
        }
        await tx.provisioningStep.update({ where: { id: step.id }, data: { status: 'active', finishedAt: new Date(), evidence: { grantedBy: 'octaveonecloud', validTo: validTo.toISOString() } } });
      });
      results.push({ name: step.name, status: 'active' });
      continue;
    }

    if (stepPlan.fulfillment !== 'app_adapter' || !stepPlan.adapterKey) {
      const error = stepPlan.fulfillment === 'manual_service' ? 'manual_service_task_required' : 'automated_fulfilment_not_available';
      await finishStep(db, step.id, 'failed', undefined, error);
      results.push({ name: step.name, status: 'failed', error });
      continue;
    }
    const adapter = adapters.get(stepPlan.adapterKey);
    const adapterRow = await db.appAdapter.findUnique({ where: { key: stepPlan.adapterKey } });
    if (!adapter || !adapterRow || adapterRow.status === 'unconfigured' || adapterRow.status === 'disabled') {
      await finishStep(db, step.id, 'failed', undefined, 'adapter_unconfigured');
      results.push({ name: step.name, status: 'failed', error: 'adapter_unconfigured' });
      continue;
    }

    const features = await db.planFeature.findMany({ where: { planVersionId: stepPlan.planVersionId }, include: { feature: true } });
    const entitlements: EntitlementPayload[] = features.map((f) => ({ featureKey: f.featureKey, limit: f.limit === null ? null : Number(f.limit) * item.quantity }));
    const r = await adapter.provisionTenant({
      orgId: job.orgId,
      correlationId: job.correlationId,
      idempotencyKey: `${job.idempotencyKey}:${step.name}`,
      planVersionId: stepPlan.planVersionId,
      entitlements,
      configuration: item.configuration ?? undefined,
    });

    if (r.outcome === 'succeeded' && r.evidence) {
      await db.$transaction(async (tx) => {
        for (const f of features) {
          await tx.entitlement.upsert({
            where: { orgId_featureKey_sourceType_sourceId: { orgId: job.orgId, featureKey: f.featureKey, sourceType: 'subscription', sourceId: `${item.id}:${stepPlan.planVersionId}` } },
            update: { revokedAt: null, limit: f.limit === null ? null : f.limit * BigInt(item.quantity) },
            create: {
              orgId: job.orgId,
              featureKey: f.featureKey,
              mergePolicy: f.feature.mergePolicy,
              limit: f.limit === null ? null : f.limit * BigInt(item.quantity),
              sourceType: 'subscription',
              sourceId: `${item.id}:${stepPlan.planVersionId}`,
            },
          });
        }
        await tx.provisioningStep.update({ where: { id: step.id }, data: { status: 'active', finishedAt: new Date(), evidence: redact({ ...r.evidence, externalRef: r.externalRef }) as Prisma.InputJsonValue } });
      });
      results.push({ name: step.name, status: 'active' });
    } else if (r.outcome === 'unknown' || r.outcome === 'pending' || (r.outcome === 'succeeded' && !r.evidence)) {
      await finishStep(db, step.id, 'unknown_outcome', undefined, r.error ?? r.outcome);
      results.push({ name: step.name, status: 'unknown_outcome', error: r.error });
      stop = true; // do not continue dependent components until reconciled
    } else {
      await finishStep(db, step.id, 'failed', undefined, r.error ?? 'failed');
      results.push({ name: step.name, status: 'failed', error: r.error });
    }
  }

  const statuses = results.map((s) => s.status);
  const jobStatus: ProvisioningStatus = statuses.every((s) => s === 'active')
    ? 'active'
    : statuses.includes('unknown_outcome')
      ? 'unknown_outcome'
      : statuses.some((s) => s === 'active')
        ? 'partially_failed'
        : 'failed';
  await db.provisioningJob.update({ where: { id: jobId }, data: { status: jobStatus, lastError: results.find((s) => s.error)?.error ?? null } });

  if (jobStatus === 'active' && price.kind === 'subscription') await ensureSubscription(db, job.orgId, item.id, price.planVersionId, price.id, price.billingInterval, item.quantity);
  await rollUpOrderStatus(db, item.orderId);
  return { jobId, status: jobStatus, steps: results };
}

async function finishStep(db: PrismaClient, stepId: string, status: ProvisioningStatus, evidence: unknown, error: string) {
  await db.provisioningStep.update({ where: { id: stepId }, data: { status, finishedAt: new Date(), error, evidence: evidence as Prisma.InputJsonValue | undefined } });
}

export function addIsoDuration(start: Date, iso: string): Date {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(iso);
  if (!m) throw new Error(`Unsupported duration ${iso}`);
  const d = new Date(start);
  const [, y, mo, days] = m;
  if (y) d.setUTCFullYear(d.getUTCFullYear() + Number(y));
  if (mo) {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + Number(mo));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  if (days) d.setUTCDate(d.getUTCDate() + Number(days));
  return d;
}

async function ensureSubscription(db: PrismaClient, orgId: string, orderItemId: string, planVersionId: string, priceVersionId: string, interval: string, quantity: number) {
  const existing = await db.subscription.findFirst({ where: { sourceOrderItemId: orderItemId } });
  if (existing) return existing;
  const now = new Date();
  return db.subscription.create({
    data: { orgId, planVersionId, priceVersionId, quantity, status: 'active', currentPeriodStart: now, currentPeriodEnd: addIsoDuration(now, interval), sourceOrderItemId: orderItemId },
  });
}

/** Honest order state: active only when every item's job is active. */
export async function rollUpOrderStatus(db: PrismaClient, orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId }, include: { provisioningJobs: true } });
  const statuses = items.flatMap((i) => i.provisioningJobs.map((j) => j.status));
  if (statuses.length === 0) return;
  let next: 'active' | 'needs_attention' | 'provisioning' | 'delayed';
  if (statuses.every((s) => s === 'active')) next = 'active';
  else if (statuses.some((s) => s === 'failed' || s === 'partially_failed' || s === 'unknown_outcome')) next = 'needs_attention';
  else if (statuses.some((s) => s === 'queued' || s === 'running')) next = 'provisioning';
  else next = 'delayed';
  await db.order.updateMany({ where: { id: orderId, status: { in: ['paid', 'provisioning', 'delayed', 'needs_attention'] } }, data: { status: next } });
}
