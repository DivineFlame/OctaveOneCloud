import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, Tx } from '@ooc/db';
import { redact } from '@ooc/shared';
import { PRISMA } from './prisma.module';

export interface AuditInput {
  actorId?: string | null;
  actorType: 'user' | 'operator' | 'system' | 'provider';
  orgId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}

  async record(input: AuditInput, tx?: Tx): Promise<void> {
    const client = tx ?? this.db;
    await client.auditEvent.create({
      data: {
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        orgId: input.orgId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
        ip: input.ip ?? null,
      },
    });
  }
}
