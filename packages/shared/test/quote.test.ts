import { describe, expect, it } from 'vitest';
import { computeQuote, groupForCheckout } from '../src/quote';
import { TaxRule, determineSupplyType } from '../src/tax';

const rules: TaxRule[] = [
  { id: 'r-intra', taxCategory: 'saas', supplyType: 'intra_state', reviewed: true, components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }] },
  { id: 'r-inter', taxCategory: 'saas', supplyType: 'inter_state', reviewed: true, components: [{ name: 'IGST', rateBps: 1800 }] },
  { id: 'r-draft', taxCategory: 'domain', supplyType: 'any', reviewed: false, components: [{ name: 'IGST', rateBps: 1800 }] },
];
const line = { planPriceVersionId: 'p1', description: 'CRM Starter', unitAmountMinor: 49900, quantity: 3, taxCategory: 'saas', billingInterval: 'P1M', currency: 'INR' as const };

describe('quote', () => {
  it('computes intra-state split tax', () => {
    const q = computeQuote([line], 'intra_state', rules);
    expect(q.subtotalMinor).toBe(149700);
    expect(q.taxMinor).toBe(13473 * 2);
    expect(q.totalMinor).toBe(149700 + 26946);
  });
  it('applies discount before tax', () => {
    const q = computeQuote([{ ...line, discountBps: 1000 }], 'inter_state', rules);
    expect(q.discountMinor).toBe(14970);
    expect(q.taxMinor).toBe(24251); // 18% of 134730 = 24251.4 -> 24251
  });
  it('refuses unreviewed tax rules for live quotes', () => {
    expect(() => computeQuote([{ ...line, taxCategory: 'domain' }], 'inter_state', rules)).toThrow(/not been reviewed/);
  });
  it('determines supply type', () => {
    expect(determineSupplyType({ sellerStateCode: '29', buyerStateCode: '29', buyerCountry: 'IN' })).toBe('intra_state');
    expect(determineSupplyType({ sellerStateCode: '29', buyerStateCode: '27', buyerCountry: 'IN' })).toBe('inter_state');
    expect(determineSupplyType({ sellerStateCode: '29', buyerStateCode: null, buyerCountry: 'US' })).toBe('export');
  });
  it('groups mixed-term baskets', () => {
    const groups = groupForCheckout([line, { ...line, billingInterval: 'P1Y' }, line]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });
});
