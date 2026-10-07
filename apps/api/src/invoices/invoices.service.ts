import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { CreditNoteError, issueCreditNote, issueInvoiceForOrder } from '@ooc/integrations';
import { AppConfig, sellerProfile } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';

const withDetail = { lines: true, creditNotes: { orderBy: { issuedAt: 'asc' } } } satisfies Prisma.InvoiceInclude;
type InvoiceWithDetail = Prisma.InvoiceGetPayload<{ include: typeof withDetail }>;
type InvoiceRow = Prisma.InvoiceGetPayload<object>;

/** Tax invoices and credit notes. Issuing happens in the worker after payment; this service reads and corrects. */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db.invoice.findMany({ where: { orgId, number: { not: null } }, orderBy: { issuedAt: 'desc' }, take: 200 });
    return rows.map((r) => summary(r));
  }

  async get(orgId: string, invoiceId: string) {
    const inv = await this.db.invoice.findFirst({ where: { id: invoiceId, orgId, number: { not: null } }, include: withDetail });
    if (!inv) throw new NotFoundException();
    return detail(inv);
  }

  // ── Operator ──

  async adminList(q: { orgId?: string; number?: string }) {
    const rows = await this.db.invoice.findMany({
      where: { number: q.number ? { contains: q.number } : { not: null }, ...(q.orgId ? { orgId: q.orgId } : {}) },
      include: { org: { select: { name: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
    const awaiting = await this.db.order.count({ where: { paidAt: { not: null }, invoices: { none: {} } } });
    return { sellerConfigured: sellerProfile(this.config) !== null, ordersAwaitingInvoice: awaiting, invoices: rows.map((r) => ({ ...summary(r), orgName: r.org.name })) };
  }

  async adminGet(invoiceId: string) {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId }, include: withDetail });
    if (!inv) throw new NotFoundException();
    return detail(inv);
  }

  /** Issues the invoice for one paid order now (normally the worker does this within a minute). */
  async adminIssueForOrder(orderId: string, actorId: string) {
    const r = await issueInvoiceForOrder(this.db, orderId, this.seller());
    if (r.result === 'not_ready') throw new BadRequestException({ error: r.reason, message: `Invoice cannot be issued: ${r.reason}` });
    if (r.result === 'issued') await this.audit.record({ actorId, actorType: 'operator', action: 'invoice.issued_manually', targetType: 'invoice', targetId: r.invoiceId, metadata: { orderId, number: r.number } });
    return r;
  }

  async adminCreditNote(invoiceId: string, actorId: string, input: { taxableMinor: number; reason: string; refundId?: string }) {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId }, select: { orgId: true } });
    if (!inv) throw new NotFoundException();
    try {
      const cn = await issueCreditNote(this.db, { invoiceId, ...input, actorId }, this.seller());
      await this.audit.record({ actorId, actorType: 'operator', orgId: inv.orgId, action: 'invoice.credit_note_issued', targetType: 'invoice', targetId: invoiceId, metadata: { creditNoteId: cn.id, number: cn.number, taxableMinor: input.taxableMinor, refundId: input.refundId ?? null } });
      return creditNote(cn);
    } catch (e) {
      if (e instanceof CreditNoteError) throw new BadRequestException({ error: 'credit_note_rejected', message: e.message });
      throw e;
    }
  }

  private seller() {
    const s = sellerProfile(this.config);
    if (!s) throw new ServiceUnavailableException({ error: 'seller_not_configured', message: 'Set SELLER_LEGAL_NAME, SELLER_ADDRESS and SELLER_STATE_CODE to issue tax documents.' });
    return s;
  }
}

function summary(r: InvoiceRow) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    orderId: r.orderId,
    currency: r.currency,
    subtotalMinor: minorFromDb(r.subtotalMinor),
    taxMinor: minorFromDb(r.taxMinor),
    totalMinor: minorFromDb(r.totalMinor),
    issuedAt: r.issuedAt,
  };
}

function creditNote(c: InvoiceWithDetail['creditNotes'][number]) {
  return { id: c.id, number: c.number, amountMinor: minorFromDb(c.amountMinor), taxMinor: minorFromDb(c.taxMinor), taxDetail: c.taxDetail, reason: c.reason, refundId: c.refundId, issuedAt: c.issuedAt };
}

function detail(inv: InvoiceWithDetail) {
  return {
    ...summary(inv),
    taxBreakdown: inv.taxBreakdown,
    billing: inv.billingSnapshot,
    lines: inv.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, sacCode: l.sacCode, amountMinor: minorFromDb(l.amountMinor), taxMinor: minorFromDb(l.taxMinor), taxDetail: l.taxDetail })),
    creditNotes: inv.creditNotes.map(creditNote),
  };
}
