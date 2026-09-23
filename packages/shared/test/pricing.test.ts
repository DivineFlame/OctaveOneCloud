import { describe, expect, it } from 'vitest';
import { computeCandidateNetPrice } from '../src/pricing';

describe('candidate net price', () => {
  it('applies (fixed + variable) / (1 - margin - fee)', () => {
    const r = computeCandidateNetPrice({ fixedDeliveryCostMinor: 40000, expectedVariableCostMinor: 20000, targetMarginBps: 3800, collectionFeeBps: 200 });
    // 60000 / 0.60 = 100000
    expect(r.candidateNetPriceMinor).toBe(100000);
    expect(r.expectedCollectionFeeMinor).toBe(2000);
    expect(r.expectedContributionMinor).toBe(38000);
  });
  it('rounds up so margin is never below target', () => {
    const r = computeCandidateNetPrice({ fixedDeliveryCostMinor: 1, expectedVariableCostMinor: 0, targetMarginBps: 3333, collectionFeeBps: 0 });
    expect(r.candidateNetPriceMinor).toBe(2);
  });
  it('rejects impossible margins', () => {
    expect(() => computeCandidateNetPrice({ fixedDeliveryCostMinor: 1, expectedVariableCostMinor: 0, targetMarginBps: 9000, collectionFeeBps: 1000 })).toThrow();
  });
});
