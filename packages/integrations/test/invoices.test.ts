import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@ooc/db';
import { computeQuote, SellerProfile } from '@ooc/shared';
import { CreditNoteError, financialYear, issueCreditNote, issueInvoiceForOrder, ordersAwaitingInvoice } from '../src/invoices';
import { db, makeOrg, makeProduct, reset } from './fixtures';

const seller: SellerProfile = { legalName: 'Octave Test Pvt Ltd', address: '1 Test Road, Bengaluru', gstin: '29AAAAA0000A1Z5', stateCode: '29', invoicePrefix: 'OOC', creditNotePrefix: 'OCN' };

async function paidOrder(opts: { paid?: boolean; amountMinor?: number; quantity?: number } = {}) {
  const org = await makeOrg();
  const { price } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm', amountMinor: opts.amountMinor ?? 99900 });
  const rule = await db.taxRule.create({ data: { taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], sacCode: '998315', reviewed: true } });
  const totals = computeQuote(
    [{ planPriceVersionId: price.id, description: 'CRM Starter', unitAmountMinor: opts.amountMinor ?? 99900, quantity: opts.quantity ?? 2, taxCategory: 'saas', billingInterval: 'P1M', currency: 'INR' }],
    'intra_state',
    [{ id: rule.id, taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], reviewed: true }],
  );
  const quote = await db.quote.create({
    data: {
      orgId: org.id,
      status: 'accepted',
      supplyType: 'intra_state',
      subtotalMinor: BigInt(totals.subtotalMinor),
      discountMinor: BigInt(totals.discountMinor),
      taxMinor: BigInt(totals.taxMinor),
      totalMinor: BigInt(totals.totalMinor),
      snapshot: totals as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const order = await db.order.create({
    data: {
      orgId: org.id,
      quoteId: quote.id,
      status: opts.paid === false ? 'awaiting_payment' : 'provisioning',
      totalMinor: BigInt(totals.totalMinor),
      paidAt: opts.paid === false ? null : new Date(),
      idempotencyKey: `idem-${Math.random()}`,
    },
  });
  return { org, order, totals };
}

describe('financial year', () => {
  it('switches on 1 April IST', () => {
    expect(financialYear(new Date('2027-03-31T18:29:59Z'))).toBe('26-27'); // 23:59:59 IST, 31 March
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('27-28'); // 00:00 IST, 1 April
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('99-00');
  });
});

describe('tax invoices', () => {
  beforeEach(reset);

  it('issues one invoice per paid order from the frozen quote, idempotently', async () => {
    const { order, totals } = await paidOrder();
    const now = new Date('2026-10-07T06:00:00Z');
    const first = await issueInvoiceForOrder(db, order.id, seller, now);
    expect(first).toMatchObject({ result: 'issued', number: 'OOC/26-27/00001' });
    const again = await issueInvoiceForOrder(db, order.id, seller, now);
    expect(again).toMatchObject({ result: 'exists', number: 'OOC/26-27/00001' });

    const inv = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id }, include: { lines: true } });
    expect(Number(inv.totalMinor)).toBe(totals.totalMinor);
    expect(Number(inv.taxMinor)).toBe(totals.taxMinor);
    expect(Number(inv.subtotalMinor)).toBe(totals.totalMinor - totals.taxMinor);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.sacCode).toBe('998315');
    expect(inv.taxBreakdown).toEqual([
      { name: 'CGST', rateBps: 900, taxableMinor: 199800, amountMinor: 17982 },
      { name: 'SGST', rateBps: 900, taxableMinor: 199800, amountMinor: 17982 },
    ]);
    expect((inv.billingSnapshot as { seller: { gstin: string } }).seller.gstin).toBe(seller.gstin);
  });

  it('numbers consecutively without gaps under concurrency, one invoice per order', async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => paidOrder()));
    const now = new Date('2026-10-07T06:00:00Z');
    // Each order issued 3× concurrently.
    const results = await Promise.all(orders.flatMap(({ order }) => [1, 2, 3].map(() => issueInvoiceForOrder(db, order.id, seller, now))));
    expect(results.filter((r) => r.result === 'issued')).toHaveLength(6);
    const numbers = (await db.invoice.findMany({ select: { number: true } })).map((i) => i.number).sort();
    expect(numbers).toEqual(['00001', '00002', '00003', '00004', '00005', '00006'].map((n) => `OOC/26-27/${n}`));
  });

  it('starts a new series in a new financial year', async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    await issueInvoiceForOrder(db, a.order.id, seller, new Date('2027-03-31T10:00:00Z'));
    const r = await issueInvoiceForOrder(db, b.order.id, seller, new Date('2027-04-01T10:00:00Z'));
    expect(r).toMatchObject({ number: 'OOC/27-28/00001' });
  });

  it('does not invoice unpaid orders; the sweeper only sees paid orders without invoices', async () => {
    const unpaid = await paidOrder({ paid: false });
    const paid = await paidOrder();
    expect(await issueInvoiceForOrder(db, unpaid.order.id, seller)).toEqual({ result: 'not_ready', reason: 'order_not_paid' });
    expect((await ordersAwaitingInvoice(db)).map((o) => o.id)).toEqual([paid.order.id]);
    await issueInvoiceForOrder(db, paid.order.id, seller);
    expect(await ordersAwaitingInvoice(db)).toEqual([]);
  });

  it('makes issued invoices immutable and undeletable', async () => {
    const { order } = await paidOrder();
    const r = await issueInvoiceForOrder(db, order.id, seller);
    if (r.result === 'not_ready') throw new Error('expected invoice');
    await expect(db.invoice.update({ where: { id: r.invoiceId }, data: { totalMinor: 1n } })).rejects.toThrow(/immutable/);
    await expect(db.invoice.delete({ where: { id: r.invoiceId } })).rejects.toThrow(/cannot be deleted/);
  });
});

describe('credit notes', () => {
  beforeEach(reset);

  it('credits tax proportionally and never more than the invoice', async () => {
    const { order } = await paidOrder();
    const r = await issueInvoiceForOrder(db, order.id, seller, new Date('2026-10-07T06:00:00Z'));
    if (r.result === 'not_ready') throw new Error('expected invoice');
    const half = await issueCreditNote(db, { invoiceId: r.invoiceId, taxableMinor: 99900, reason: 'Downgrade' }, seller, new Date('2026-10-08T06:00:00Z'));
    expect(half.number).toBe('OCN/26-27/00001');
    expect(Number(half.taxMinor)).toBe(17982); // 9 % + 9 % of 999.00
    await expect(issueCreditNote(db, { invoiceId: r.invoiceId, taxableMinor: 99901, reason: 'Too much' }, seller)).rejects.toBeInstanceOf(CreditNoteError);
    const rest = await issueCreditNote(db, { invoiceId: r.invoiceId, taxableMinor: 99900, reason: 'Cancelled' }, seller, new Date('2026-10-09T06:00:00Z'));
    expect(rest.number).toBe('OCN/26-27/00002');
    await expect(db.creditNote.update({ where: { id: rest.id }, data: { amountMinor: 1n } })).rejects.toThrow(/immutable/);
  });

  it('serialises concurrent credit notes so the cap holds', async () => {
    const { order } = await paidOrder();
    const r = await issueInvoiceForOrder(db, order.id, seller);
    if (r.result === 'not_ready') throw new Error('expected invoice');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => issueCreditNote(db, { invoiceId: r.invoiceId, taxableMinor: 99900, reason: 'Race' }, seller)));
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(await db.creditNote.count({ where: { invoiceId: r.invoiceId } })).toBe(2);
  });
});
