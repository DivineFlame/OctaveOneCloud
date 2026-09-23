/**
 * Supplier capability registry — mirrors docs/provider-capabilities.md.
 * A capability is sellable only when `verified` is true, which requires: exact documentation link,
 * account eligibility confirmed in the authenticated ResellerClub panel, and a recorded sandbox (demo) test.
 * Nothing is verified yet (Stage 0 pending), so every ResellerClub product stays in draft.
 */
export interface Capability {
  adapterKey: string;
  operation: string;
  docs: string | null;
  accountEligible: boolean | null;
  sandboxVerifiedAt: string | null;
  verified: boolean;
  fallback: string;
}

export const RESELLERCLUB_CAPABILITIES: Capability[] = [
  { adapterKey: 'resellerclub.domain', operation: 'availability', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Disable domain search' },
  { adapterKey: 'resellerclub.domain', operation: 'register', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Manual service task' },
  { adapterKey: 'resellerclub.domain', operation: 'transfer', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Manual service task' },
  { adapterKey: 'resellerclub.domain', operation: 'renew', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Manual service task' },
  { adapterKey: 'resellerclub.domain', operation: 'dns_manage', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Support ticket' },
  { adapterKey: 'resellerclub.hosting', operation: 'order', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Not sold' },
  { adapterKey: 'resellerclub.vps', operation: 'order', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Not sold' },
  { adapterKey: 'resellerclub.email', operation: 'order', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Not sold' },
  { adapterKey: 'resellerclub.ssl', operation: 'order', docs: null, accountEligible: null, sandboxVerifiedAt: null, verified: false, fallback: 'Not sold' },
];

/** A product adapter is sellable only if its purchase-path operations are all verified. */
export function isCapabilityVerified(adapterKey: string): boolean {
  const caps = RESELLERCLUB_CAPABILITIES.filter((c) => c.adapterKey === adapterKey);
  return caps.length > 0 && caps.filter((c) => ['register', 'order', 'availability'].includes(c.operation)).every((c) => c.verified);
}
