import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { SellerProfile, divideRoundHalfUp } from '@ooc/shared';

/**
 * GST invoices and credit notes.
 *
 *  - One tax invoice per paid order, issued from the frozen quote (prices/tax as accepted, never recomputed).
 *  - Numbers are consecutive per series and Indian financial year (April–March, IST), e.g. OOC/26-27/00001,
 *    allocated inside the issuing transaction so there are no gaps or duplicates.
 *  - Issued documents are immutable (database triggers); corrections are credit notes.
 * The document layout and wording must be confirmed by the accountant before launch.
 */

type Tx = Prisma.TransactionClient;

export interface TaxComponentAmount {
  name: string;
  rateBps: number;
  taxableMinor: number;
  amountMinor: number;
}

const IST_OFFSET_MS = 330 * 60_000;

/** Indian financial year label for a date, evaluated in IST: 2026-04-01 → "26-27", 2027-03-31 → "26-27". */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Allocates the next number in a series atomically (row-locked upsert). */
export async function nextDocumentNumber(tx: Tx, prefix: string, date: Date): Promise<string> {
  const series = `${prefix}/${financialYear(date)}`;
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
    INSERT INTO "DocumentSequence" ("series", "lastNumber", "updatedAt") VALUES (${series}, 1, now())
    ON CONFLICT ("series") DO UPDATE SET "lastNumber" = "DocumentSequence"."lastNumber" + 1, "updatedAt" = now()
    RETURNING "lastNumber"`);
  const n = rows[0]!.lastNumber;
  if (n > 99_999) throw new Error(`Document series ${series} exhausted`);
  const number = `${series}/${String(n).padStart(5, '0')}`;
  if (number.length > 16) throw new Error(`Document number ${number} exceeds 16 characters`);
  return number;
}

interface SnapshotLine {
  planPriceVersionId: string;
  description: string;
  quantity: number;
  totalMinor: number;
  taxableMinor: number;
  tax: { ruleId: string; components: { name: string; rateBps: number; amountMinor: number }[]; totalTaxMinor: number };
}

export type IssueResult = { result: 'issued' | 'exists'; invoiceId: string; number: string | null } | { result: 'not_ready'; reason: string };

export async function issueInvoiceForOrder(db: PrismaClient, orderId: string, seller: SellerProfile, now = new Date()): Promise<IssueResult> {
  const existing = await db.invoice.findUnique({ where: { orderId } });
  if (existing) return { result: 'exists', invoiceId: existing.id, number: existing.number };

  const order = await db.order.findUnique({ where: { id: orderId }, include: { org: true, quote: { include: { lines: true } } } });
  if (!order) return { result: 'not_ready', reason: 'order_not_found' };
  if (!order.paidAt) return { result: 'not_ready', reason: 'order_not_paid' };
  if (!order.quote) return { result: 'not_ready', reason: 'order_without_quote' };

  const snapshot = order.quote.snapshot as unknown as { lines: SnapshotLine[] };
  if (order.quote.totalMinor !== order.totalMinor) return { result: 'not_ready', reason: 'order_quote_total_mismatch' };
  const ruleIds = [...new Set(snapshot.lines.map((l) => l.tax.ruleId))];
  const rules = await db.taxRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, sacCode: true } });
  const sacByRule = new Map(rules.map((r) => [r.id, r.sacCode]));

  const lines = snapshot.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    amountMinor: BigInt(l.taxableMinor),
    taxMinor: BigInt(l.tax.totalTaxMinor),
    taxDetail: l.tax.components.map((c) => ({ ...c, taxableMinor: l.taxableMinor })) as unknown as Prisma.InputJsonValue,
    sacCode: sacByRule.get(l.tax.ruleId) ?? null,
  }));
  const breakdown = new Map<string, TaxComponentAmount>();
  for (const l of snapshot.lines) {
    for (const c of l.tax.components) {
      const key = `${c.name}@${c.rateBps}`;
      const b = breakdown.get(key) ?? { name: c.name, rateBps: c.rateBps, taxableMinor: 0, amountMinor: 0 };
      b.taxableMinor += l.taxableMinor;
      b.amountMinor += c.amountMinor;
      breakdown.set(key, b);
    }
  }
  const quote = order.quote;
  const taxMinor = minorFromDb(quote.taxMinor);
  const totalMinor = minorFromDb(order.quote.totalMinor);
  const org = order.org;

  try {
    const invoice = await db.$transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, seller.invoicePrefix, now);
      return tx.invoice.create({
        data: {
          orgId: order.orgId,
          orderId,
          number,
          status: 'issued',
          currency: order.currency,
          subtotalMinor: BigInt(totalMinor - taxMinor),
          taxMinor: BigInt(taxMinor),
          totalMinor: BigInt(totalMinor),
          taxBreakdown: [...breakdown.values()] as unknown as Prisma.InputJsonValue,
          billingSnapshot: {
            seller: { legalName: seller.legalName, address: seller.address, gstin: seller.gstin, stateCode: seller.stateCode },
            buyer: { legalName: org.legalName ?? org.name, gstin: org.gstin, address: org.billingAddress, stateCode: org.stateCode, country: org.country, email: org.billingEmail },
            placeOfSupply: org.country === 'IN' ? org.stateCode : 'outside India',
            supplyType: quote.supplyType,
            reverseCharge: false,
            orderId,
            paidAt: order.paidAt!.toISOString(),
          } as Prisma.InputJsonValue,
          issuedAt: now,
          lines: { create: lines },
        },
      });
    });
    return { result: 'issued', invoiceId: invoice.id, number: invoice.number };
  } catch (e) {
    // A concurrent issuer won the unique(orderId) race; its transaction (and number) stands, ours rolled back.
    const again = await db.invoice.findUnique({ where: { orderId } });
    if (again) return { result: 'exists', invoiceId: again.id, number: again.number };
    throw e;
  }
}

export class CreditNoteError extends Error {}

/**
 * Credit note for part or all of an invoice's taxable value. Tax is credited in the same proportion as the
 * invoice's tax breakdown. Total credits can never exceed the invoice (enforced under a row lock).
 */
export async function issueCreditNote(
  db: PrismaClient,
  input: { invoiceId: string; taxableMinor: number; reason: string; refundId?: string; actorId?: string },
  seller: SellerProfile,
  now = new Date(),
) {
  if (!Number.isSafeInteger(input.taxableMinor) || input.taxableMinor <= 0) throw new CreditNoteError('Credit amount must be a positive integer of paise');
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Invoice" WHERE id = ${input.invoiceId}::uuid AND "number" IS NOT NULL FOR UPDATE`);
    if (locked.length !== 1) throw new CreditNoteError('Invoice not found or not issued');
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId }, include: { creditNotes: true } });
    const invoiceTaxable = minorFromDb(invoice.subtotalMinor);
    const credited = invoice.creditNotes.reduce((a, c) => a + minorFromDb(c.amountMinor), 0);
    if (credited + input.taxableMinor > invoiceTaxable) {
      throw new CreditNoteError(`Credit exceeds remaining creditable value (${invoiceTaxable - credited} paise)`);
    }
    const breakdown = invoice.taxBreakdown as unknown as TaxComponentAmount[];
    const components = breakdown.map((b) => ({
      name: b.name,
      rateBps: b.rateBps,
      taxableMinor: input.taxableMinor,
      amountMinor: invoiceTaxable === 0 ? 0 : divideRoundHalfUp(b.amountMinor * input.taxableMinor, invoiceTaxable),
    }));
    const taxMinor = components.reduce((a, c) => a + c.amountMinor, 0);
    const number = await nextDocumentNumber(tx, seller.creditNotePrefix, now);
    return tx.creditNote.create({
      data: {
        invoiceId: invoice.id,
        number,
        amountMinor: BigInt(input.taxableMinor),
        taxMinor: BigInt(taxMinor),
        taxDetail: components as unknown as Prisma.InputJsonValue,
        reason: input.reason,
        refundId: input.refundId,
        createdById: input.actorId,
        issuedAt: now,
      },
    });
  });
}

/** Paid orders that still need an invoice (used by the worker's sweeper). */
export async function ordersAwaitingInvoice(db: PrismaClient, limit = 50) {
  return db.order.findMany({ where: { paidAt: { not: null }, invoices: { none: {} } }, select: { id: true }, take: limit, orderBy: { paidAt: 'asc' } });
}
