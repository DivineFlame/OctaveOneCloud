import { beforeEach, describe, expect, it } from 'vitest';
import { QuotaExceededError, ensureCounter, releaseUsage, reserveUsage, settleUsage } from '../src/usage';
import { ApprovalError, consumeApproval, decideApproval, requestApproval } from '../src/approvals';
import { db, makeOrg, reset } from './fixtures';

describe('usage metering', () => {
  beforeEach(reset);

  it('enforces caps under concurrent reservations', async () => {
    const org = await makeOrg();
    const c = await ensureCounter(db, { orgId: org.id, resource: 'workflow.executions', periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-10-01'), limit: 100n });
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => reserveUsage(db, { counterId: c.id, quantity: 10n, idempotencyKey: `run-${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof QuotaExceededError)).toHaveLength(15);
    const counter = await db.usageCounter.findUniqueOrThrow({ where: { id: c.id } });
    expect(counter.reserved).toBe(100n);
  });

  it('settles actual usage capped at the reservation, deduplicates, and releases capacity', async () => {
    const org = await makeOrg();
    const c = await ensureCounter(db, { orgId: org.id, resource: 'ai.credits', periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-10-01'), limit: 50n });
    const r1 = await reserveUsage(db, { counterId: c.id, quantity: 20n, idempotencyKey: 'a' });
    expect((await reserveUsage(db, { counterId: c.id, quantity: 20n, idempotencyKey: 'a' })).id).toBe(r1.id);
    const s = await settleUsage(db, { reservationId: r1.id, actualQuantity: 35n, source: 'agent-runtime', sourceEventId: 'run-1' });
    expect(s).toMatchObject({ settled: true, billed: 20n, cappedFrom: 35n });
    expect((await settleUsage(db, { reservationId: r1.id, actualQuantity: 5n, source: 'agent-runtime', sourceEventId: 'run-1b' })).settled).toBe(false);
    const r2 = await reserveUsage(db, { counterId: c.id, quantity: 30n, idempotencyKey: 'b' });
    await expect(reserveUsage(db, { counterId: c.id, quantity: 1n, idempotencyKey: 'c' })).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await releaseUsage(db, r2.id)).toBe(true);
    const counter = await db.usageCounter.findUniqueOrThrow({ where: { id: c.id } });
    expect([counter.used, counter.reserved]).toEqual([20n, 0n]);
  });
});

describe('agent action approvals', () => {
  beforeEach(reset);
  const payload = { channel: 'email', to: ['lead@example.com'], body: 'Hello' };

  it('executes only the exact approved action, once', async () => {
    const org = await makeOrg();
    const a = await requestApproval(db, { orgId: org.id, actionType: 'outbound_message', payload });
    await expect(consumeApproval(db, { orgId: org.id, approvalId: a.id, actionType: 'outbound_message', payload })).rejects.toMatchObject({ code: 'not_approved' });
    await decideApproval(db, { orgId: org.id, approvalId: a.id, userId: '00000000-0000-0000-0000-000000000001', approve: true });
    await consumeApproval(db, { orgId: org.id, approvalId: a.id, actionType: 'outbound_message', payload: { body: 'Hello', to: ['lead@example.com'], channel: 'email' } });
    await expect(consumeApproval(db, { orgId: org.id, approvalId: a.id, actionType: 'outbound_message', payload })).rejects.toBeInstanceOf(ApprovalError);
  });

  it('invalidates the approval when inputs change and blocks cross-tenant use', async () => {
    const org = await makeOrg('A');
    const other = await makeOrg('B');
    const a = await requestApproval(db, { orgId: org.id, actionType: 'outbound_message', payload });
    await decideApproval(db, { orgId: org.id, approvalId: a.id, userId: '00000000-0000-0000-0000-000000000001', approve: true });
    await expect(consumeApproval(db, { orgId: other.id, approvalId: a.id, actionType: 'outbound_message', payload })).rejects.toMatchObject({ code: 'not_found' });
    await expect(consumeApproval(db, { orgId: org.id, approvalId: a.id, actionType: 'outbound_message', payload: { ...payload, to: ['everyone@example.com'] } })).rejects.toMatchObject({ code: 'inputs_changed' });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('invalidated');
    await expect(consumeApproval(db, { orgId: org.id, approvalId: a.id, actionType: 'outbound_message', payload })).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('rejects expired approvals', async () => {
    const org = await makeOrg();
    const a = await requestApproval(db, { orgId: org.id, actionType: 'spend', payload: { amountMinor: 5000 }, ttlMs: -1 });
    await expect(decideApproval(db, { orgId: org.id, approvalId: a.id, userId: '00000000-0000-0000-0000-000000000001', approve: true })).rejects.toBeInstanceOf(ApprovalError);
  });
});
