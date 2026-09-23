import { MoneyError, applyBasisPoints } from './money';

/**
 * Tax configuration is data, not code. Rates are supplied from accountant-reviewed
 * configuration (TaxRule rows). Nothing here asserts which rate applies to which product.
 */
export type TaxComponentName = 'CGST' | 'SGST' | 'IGST' | 'OTHER';

export interface TaxRuleComponent {
  name: TaxComponentName;
  rateBps: number;
}

export interface TaxRule {
  id: string;
  taxCategory: string;
  /** 'intra_state' | 'inter_state' | 'export' | 'any' */
  supplyType: SupplyType | 'any';
  components: TaxRuleComponent[];
  reviewed: boolean;
}

export type SupplyType = 'intra_state' | 'inter_state' | 'export';

export interface TaxContext {
  sellerStateCode: string | null;
  buyerStateCode: string | null;
  buyerCountry: string;
}

export function determineSupplyType(ctx: TaxContext): SupplyType {
  if (ctx.buyerCountry !== 'IN') return 'export';
  if (!ctx.sellerStateCode || !ctx.buyerStateCode) {
    throw new MoneyError('Seller and buyer state codes are required to determine supply type');
  }
  return ctx.sellerStateCode === ctx.buyerStateCode ? 'intra_state' : 'inter_state';
}

export interface TaxLineResult {
  ruleId: string;
  components: { name: TaxComponentName; rateBps: number; amountMinor: number }[];
  totalTaxMinor: number;
}

export function computeLineTax(
  taxableMinor: number,
  taxCategory: string,
  supplyType: SupplyType,
  rules: readonly TaxRule[],
  opts: { allowUnreviewed?: boolean } = {},
): TaxLineResult {
  const rule =
    rules.find((r) => r.taxCategory === taxCategory && r.supplyType === supplyType) ??
    rules.find((r) => r.taxCategory === taxCategory && r.supplyType === 'any');
  if (!rule) throw new MoneyError(`No tax rule configured for category=${taxCategory} supply=${supplyType}`);
  if (!rule.reviewed && !opts.allowUnreviewed) {
    throw new MoneyError(`Tax rule ${rule.id} has not been reviewed and cannot be used for a live quote`);
  }
  const components = rule.components.map((c) => ({
    name: c.name,
    rateBps: c.rateBps,
    amountMinor: applyBasisPoints(taxableMinor, c.rateBps),
  }));
  return { ruleId: rule.id, components, totalTaxMinor: components.reduce((a, c) => a + c.amountMinor, 0) };
}
