'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';

interface Grant { sourceType: string; limit: number | null; validTo: string | null }
interface FeatureUsage { featureKey: string; name: string; unit: string | null; metered: boolean; limit: number | null; used: number; reserved: number; grants: Grant[] }
interface Summary { period: { start: string; end: string }; features: FeatureUsage[] }

const day = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const num = (n: number) => n.toLocaleString('en-IN');
const SOURCE: Record<string, string> = { subscription: 'Plan', usage_pack: 'Usage pack', manual: 'Added by our team' };

export default function Usage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<Summary>(`/orgs/${orgId}/usage`).then(setS).catch((e) => setError(describeError(e))), [orgId]);

  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}`}>← Organisation</Link></p>
      <h1>Usage and limits</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {!s && !error && <p aria-busy="true">Loading…</p>}
      {s && (
        <>
          <p className="muted">Metered usage for {day(s.period.start)} – {day(new Date(new Date(s.period.end).getTime() - 1).toISOString())}; it resets on the 1st of each month (IST). Work that would exceed a limit is stopped — nothing is charged automatically beyond your plan and packs.</p>
          {s.features.length === 0 && <p className="muted">No active plan features yet.</p>}
          <div className="stack-list">
            {s.features.map((f) => {
              const pct = f.metered && f.limit ? Math.min(100, Math.round(((f.used + f.reserved) / f.limit) * 100)) : null;
              return (
                <section key={f.featureKey} className="card">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{f.name}</h2>
                    {pct !== null && pct >= 80 && <span className={`badge ${pct >= 100 ? 'warn' : 'progress'}`}>{pct >= 100 ? 'Limit reached' : `${pct}% used`}</span>}
                  </div>
                  {f.metered && f.limit !== null ? (
                    <>
                      <p>{num(f.used)} of {num(f.limit)} {f.unit ?? ''} used this month{f.reserved ? ` (${num(f.reserved)} in progress)` : ''}</p>
                      <progress max={f.limit} value={Math.min(f.limit, f.used + f.reserved)} style={{ width: '100%' }} aria-label={`${f.name} usage`} />
                    </>
                  ) : (
                    <p>{f.limit === null ? 'Included' : `Up to ${num(f.limit)} ${f.unit ?? ''}`}</p>
                  )}
                  <p className="muted" style={{ fontSize: '0.9rem' }}>
                    {f.grants.map((g, i) => (
                      <span key={i}>{i ? ' · ' : ''}{SOURCE[g.sourceType] ?? g.sourceType}{g.limit !== null ? `: ${num(g.limit)}` : ''}{g.validTo ? ` (until ${day(g.validTo)})` : ''}</span>
                    ))}
                  </p>
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
