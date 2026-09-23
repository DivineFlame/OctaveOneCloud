import { MoneyError, applyBasisPoints, assertNonNegativeMinor } from './money';
import { TaxRule, SupplyType, TaxLineResult, computeLineTax } from './tax';

export interface QuoteLineInput {
  planPriceVersionId: string;
  description: string;
  unitAmountMinor: number;
  quantity: number;
  setupFeeMinor?: number;
  discountBps?: number;
  taxCategory: string;
  /** e.g. "P1M", "P1Y" – customer billing interval; items must share compatible terms per checkout group */
  billingInterval: string;
  currency: 'INR';
}

export interface QuoteLineResult extends QuoteLineInput {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  tax: TaxLineResult;
  totalMinor: number;
}

export interface QuoteTotals {
  lines: QuoteLineResult[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: 'INR';
}

export function computeQuote(
  lines: readonly QuoteLineInput[],
  supplyType: SupplyType,
  rules: readonly TaxRule[],
  opts: { allowUnreviewedTax?: boolean } = {},
): QuoteTotals {
  if (lines.length === 0) throw new MoneyError('A quote requires at least one line');
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size !== 1) throw new MoneyError('All quote lines must share one currency');
  const results = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new MoneyError('Quantity must be a positive integer');
    assertNonNegativeMinor(line.unitAmountMinor, 'unitAmountMinor');
    const setup = assertNonNegativeMinor(line.setupFeeMinor ?? 0, 'setupFeeMinor');
    const discountBps = line.discountBps ?? 0;
    if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new MoneyError('Invalid discount');
    const subtotal = line.unitAmountMinor * line.quantity + setup;
    const discount = applyBasisPoints(subtotal, discountBps);
    const taxable = subtotal - discount;
    const tax = computeLineTax(taxable, line.taxCategory, supplyType, rules, { allowUnreviewed: opts.allowUnreviewedTax });
    return { ...line, subtotalMinor: subtotal, discountMinor: discount, taxableMinor: taxable, tax, totalMinor: taxable + tax.totalTaxMinor };
  });
  const sum = (f: (l: QuoteLineResult) => number) => results.reduce((a, l) => a + f(l), 0);
  return {
    lines: results,
    subtotalMinor: sum((l) => l.subtotalMinor),
    discountMinor: sum((l) => l.discountMinor),
    taxMinor: sum((l) => l.tax.totalTaxMinor),
    totalMinor: sum((l) => l.totalMinor),
    currency: 'INR',
  };
}

/** Groups basket items into checkout groups sharing currency and billing interval (MVP rule). */
export function groupForCheckout<T extends { currency: string; billingInterval: string }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.currency}|${item.billingInterval}`;
    const g = groups.get(key) ?? [];
    g.push(item);
    groups.set(key, g);
  }
  return [...groups.values()];
}
