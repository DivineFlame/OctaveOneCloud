import { Prisma, PrismaClient } from '@ooc/db';
import { canonicalHash } from '@ooc/shared';

/**
 * Human approval for consequential agent actions (outbound messages, publishing, deletion, spend).
 * The approval binds to the SHA-256 of the canonical action inputs: any change to the inputs
 * invalidates it, and it can be executed at most once before expiry. Enforced outside the LLM.
 */
export type ApprovalActionType = 'outbound_message' | 'publish_campaign' | 'delete' | 'spend';

export class ApprovalError extends Error {
  constructor(public readonly code: 'not_found' | 'not_approved' | 'expired' | 'inputs_changed' | 'already_used' | 'self_approval', message?: string) {
    super(message ?? code);
  }
}

export async function requestApproval(db: PrismaClient, input: { orgId: string; agentRunId?: string; actionType: ApprovalActionType; payload: Record<string, unknown>; ttlMs?: number }) {
  return db.approvalRequest.create({
    data: {
      orgId: input.orgId,
      agentRunId: input.agentRunId,
      actionType: input.actionType,
      actionHash: canonicalHash({ actionType: input.actionType, payload: input.payload }),
      payload: input.payload as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? 24 * 3600_000)),
    },
  });
}

export async function decideApproval(db: PrismaClient, input: { orgId: string; approvalId: string; userId: string; approve: boolean }) {
  const updated = await db.approvalRequest.updateMany({
    where: { id: input.approvalId, orgId: input.orgId, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: input.approve ? 'approved' : 'rejected', decidedById: input.userId, decidedAt: new Date() },
  });
  if (updated.count !== 1) throw new ApprovalError('not_found', 'Approval not pending, expired, or not in this organisation');
}

/** Atomically consumes an approval for the exact action about to be executed. */
export async function consumeApproval(db: PrismaClient, input: { orgId: string; approvalId: string; actionType: ApprovalActionType; payload: Record<string, unknown> }) {
  const a = await db.approvalRequest.findFirst({ where: { id: input.approvalId, orgId: input.orgId } });
  if (!a) throw new ApprovalError('not_found');
  if (a.expiresAt <= new Date()) throw new ApprovalError('expired');
  const hash = canonicalHash({ actionType: input.actionType, payload: input.payload });
  if (hash !== a.actionHash) {
    await db.approvalRequest.updateMany({ where: { id: a.id, status: { in: ['pending', 'approved'] } }, data: { status: 'invalidated' } });
    throw new ApprovalError('inputs_changed');
  }
  if (a.status === 'executed') throw new ApprovalError('already_used');
  const claimed = await db.approvalRequest.updateMany({ where: { id: a.id, status: 'approved', actionHash: hash, expiresAt: { gt: new Date() } }, data: { status: 'executed', executedAt: new Date() } });
  if (claimed.count !== 1) throw new ApprovalError(a.status === 'approved' ? 'already_used' : 'not_approved');
  return a;
}
