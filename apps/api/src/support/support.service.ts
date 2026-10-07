import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, TicketStatus } from '@ooc/db';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';
import { MailService } from '../auth/mail.service';

export const TICKET_CATEGORIES = ['general', 'billing', 'technical', 'account', 'domain', 'manual_service_request'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

const CLOSED: TicketStatus[] = ['resolved', 'closed'];

/**
 * Customer support tickets. Customers see only their organisation's tickets and never internal notes.
 * Manual service requests (operations a supplier API does not support) are tickets with category
 * `manual_service_request`, optionally linked to a service.
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ── Customer side ──

  list(orgId: string) {
    return this.db.supportTicket.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, subject: true, status: true, category: true, createdAt: true, updatedAt: true },
      take: 200,
    });
  }

  async create(orgId: string, userId: string, input: { subject: string; body: string; category: TicketCategory; serviceId?: string }) {
    if (input.serviceId) {
      const svc = await this.db.service.findFirst({ where: { id: input.serviceId, orgId } });
      if (!svc) throw new BadRequestException({ error: 'unknown_service' });
    }
    const ticket = await this.db.supportTicket.create({
      data: {
        orgId,
        subject: input.subject,
        category: input.category,
        serviceId: input.serviceId,
        createdById: userId,
        status: 'open',
        messages: { create: { authorId: userId, body: input.body } },
      },
    });
    await this.audit.record({ actorId: userId, actorType: 'user', orgId, action: 'support.ticket_created', targetType: 'ticket', targetId: ticket.id, metadata: { category: input.category } });
    await this.notifyTeam(`New ticket: ${input.subject}`, ticket.id);
    return this.getForCustomer(orgId, ticket.id);
  }

  async getForCustomer(orgId: string, ticketId: string) {
    const t = await this.db.supportTicket.findFirst({
      where: { id: ticketId, orgId },
      include: { messages: { where: { internal: false }, orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException();
    return this.withAuthors(t);
  }

  async customerReply(orgId: string, ticketId: string, userId: string, body: string) {
    const t = await this.db.supportTicket.findFirst({ where: { id: ticketId, orgId } });
    if (!t) throw new NotFoundException();
    if (t.status === 'closed') throw new BadRequestException({ error: 'ticket_closed', message: 'This ticket is closed. Please open a new one.' });
    await this.db.$transaction([
      this.db.supportMessage.create({ data: { ticketId, authorId: userId, body } }),
      // A customer reply (including on a resolved ticket) puts it back in the team's queue.
      this.db.supportTicket.update({ where: { id: ticketId }, data: { status: 'pending_internal' } }),
    ]);
    await this.notifyTeam(`Customer replied: ${t.subject}`, ticketId);
    return this.getForCustomer(orgId, ticketId);
  }

  async customerClose(orgId: string, ticketId: string, userId: string) {
    const updated = await this.db.supportTicket.updateMany({ where: { id: ticketId, orgId, status: { not: 'closed' } }, data: { status: 'closed' } });
    if (updated.count !== 1) throw new NotFoundException();
    await this.audit.record({ actorId: userId, actorType: 'user', orgId, action: 'support.ticket_closed', targetType: 'ticket', targetId: ticketId });
    return this.getForCustomer(orgId, ticketId);
  }

  // ── Operator side ──

  queue(status?: TicketStatus) {
    return this.db.supportTicket.findMany({
      where: status ? { status } : { status: { notIn: CLOSED } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
      include: { org: { select: { id: true, name: true } } },
    });
  }

  async getForOperator(ticketId: string) {
    const t = await this.db.supportTicket.findUnique({
      where: { id: ticketId },
      include: { org: { select: { id: true, name: true, billingEmail: true } }, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException();
    return this.withAuthors(t);
  }

  async operatorReply(ticketId: string, operatorId: string, body: string, internal: boolean) {
    const t = await this.db.supportTicket.findUnique({ where: { id: ticketId } });
    if (!t) throw new NotFoundException();
    await this.db.$transaction([
      this.db.supportMessage.create({ data: { ticketId, authorId: operatorId, body, internal } }),
      ...(internal ? [] : [this.db.supportTicket.update({ where: { id: ticketId }, data: { status: 'pending_customer' } })]),
    ]);
    await this.audit.record({ actorId: operatorId, actorType: 'operator', orgId: t.orgId, action: internal ? 'support.internal_note' : 'support.replied', targetType: 'ticket', targetId: ticketId });
    if (!internal) {
      const requester = await this.db.user.findUnique({ where: { id: t.createdById } });
      if (requester) {
        await this.mail.trySend({
          to: requester.email,
          subject: `Re: ${t.subject}`,
          text: `Our support team replied to your request "${t.subject}".\n\nRead and reply: ${this.config.APP_URL}/dashboard/orgs/${t.orgId}/support/${t.id}`,
        });
      }
    }
    return this.getForOperator(ticketId);
  }

  async setStatus(ticketId: string, operatorId: string, status: TicketStatus) {
    const t = await this.db.supportTicket.update({ where: { id: ticketId }, data: { status } }).catch(() => null);
    if (!t) throw new NotFoundException();
    await this.audit.record({ actorId: operatorId, actorType: 'operator', orgId: t.orgId, action: 'support.status_changed', targetType: 'ticket', targetId: ticketId, metadata: { status } });
    return this.getForOperator(ticketId);
  }

  // ── helpers ──

  private async withAuthors<T extends { messages: { authorId: string; internal: boolean }[] }>(t: T) {
    const ids = [...new Set(t.messages.map((m) => m.authorId))];
    const users = await this.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, operatorRole: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      ...t,
      messages: t.messages.map((m) => {
        const u = byId.get(m.authorId);
        return { ...m, author: u ? { name: u.operatorRole ? `${u.name ?? 'Support'} (OctaveOneCloud)` : (u.name ?? u.email), isStaff: Boolean(u.operatorRole) } : { name: 'Unknown', isStaff: false } };
      }),
    };
  }

  private async notifyTeam(subject: string, ticketId: string) {
    if (!this.config.SUPPORT_NOTIFY_EMAIL) return;
    await this.mail.trySend({ to: this.config.SUPPORT_NOTIFY_EMAIL, subject: `[Support] ${subject}`, text: `${this.config.APP_URL}/admin/support/${ticketId}` });
  }
}
