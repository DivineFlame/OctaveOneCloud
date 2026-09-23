/**
 * Entitlement merge rules. Overlapping bundles must not accidentally double-grant quotas.
 * Each feature declares how grants from multiple sources combine:
 *  - "max": take the largest grant (default for limits like seats included in two bundles)
 *  - "additive": sum grants (only for explicitly stackable add-ons, e.g. purchased usage packs)
 *  - "boolean": any source grants access
 */
export type MergePolicy = 'max' | 'additive' | 'boolean';

export interface EntitlementGrant {
  featureKey: string;
  sourceId: string; // subscription item / bundle component id
  mergePolicy: MergePolicy;
  limit: number | null; // null = boolean feature
}

export interface EffectiveEntitlement {
  featureKey: string;
  mergePolicy: MergePolicy;
  limit: number | null;
  enabled: boolean;
  sources: string[];
}

export function mergeEntitlements(grants: readonly EntitlementGrant[]): Map<string, EffectiveEntitlement> {
  const out = new Map<string, EffectiveEntitlement>();
  for (const g of grants) {
    const existing = out.get(g.featureKey);
    if (!existing) {
      out.set(g.featureKey, { featureKey: g.featureKey, mergePolicy: g.mergePolicy, limit: g.limit, enabled: true, sources: [g.sourceId] });
      continue;
    }
    if (existing.mergePolicy !== g.mergePolicy) {
      throw new Error(`Conflicting merge policies for feature ${g.featureKey}: ${existing.mergePolicy} vs ${g.mergePolicy}`);
    }
    existing.sources.push(g.sourceId);
    if (g.mergePolicy === 'boolean') continue;
    const a = existing.limit ?? 0;
    const b = g.limit ?? 0;
    existing.limit = g.mergePolicy === 'additive' ? a + b : Math.max(a, b);
  }
  return out;
}
