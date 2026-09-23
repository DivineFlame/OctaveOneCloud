import { MoneyError, assertNonNegativeMinor, divideCeil } from './money';

/**
 * Internal planning model from the product plan:
 *   candidate net price = (fixed delivery cost + expected included variable cost)
 *                         / (1 - target contribution margin - percentage collection fee)
 * Fixed per-transaction costs are added to the cost base explicitly. Tax, discounts and
 * annual-payment economics are applied separately. This is NOT a market quotation.
 */
export interface CandidatePriceInput {
  fixedDeliveryCostMinor: number;
  expectedVariableCostMinor: number;
  fixedTransactionCostMinor?: number;
  targetMarginBps: number;
  collectionFeeBps: number;
}

export interface CandidatePriceResult {
  costBaseMinor: number;
  candidateNetPriceMinor: number;
  expectedCollectionFeeMinor: number;
  expectedContributionMinor: number;
}

export function computeCandidateNetPrice(input: CandidatePriceInput): CandidatePriceResult {
  const fixed = assertNonNegativeMinor(input.fixedDeliveryCostMinor, 'fixedDeliveryCostMinor');
  const variable = assertNonNegativeMinor(input.expectedVariableCostMinor, 'expectedVariableCostMinor');
  const txn = assertNonNegativeMinor(input.fixedTransactionCostMinor ?? 0, 'fixedTransactionCostMinor');
  const { targetMarginBps: m, collectionFeeBps: f } = input;
  for (const [k, v] of [['targetMarginBps', m], ['collectionFeeBps', f]] as const) {
    if (!Number.isInteger(v) || v < 0 || v >= 10_000) throw new MoneyError(`${k} must be an integer in [0, 10000)`);
  }
  const denominatorBps = 10_000 - m - f;
  if (denominatorBps <= 0) throw new MoneyError('Margin plus collection fee must be below 100%');
  const costBase = fixed + variable + txn;
  const price = divideCeil(costBase * 10_000, denominatorBps);
  const fee = Math.ceil((price * f) / 10_000);
  return {
    costBaseMinor: costBase,
    candidateNetPriceMinor: price,
    expectedCollectionFeeMinor: fee,
    expectedContributionMinor: price - costBase - fee,
  };
}
