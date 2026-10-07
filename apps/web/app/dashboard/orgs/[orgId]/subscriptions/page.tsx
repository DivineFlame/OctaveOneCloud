'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR, formatInterval } from '@/lib/format';
import { SUB_STATUS, SubscriptionView, day } from '@/lib/subscriptions';

export default function Subscriptions({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [subs, setSubs] = useState<SubscriptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<SubscriptionView[]>(`/orgs/${orgId}/subscriptions`).then(setSubs).catch((e) => setError(describeError(e))), [orgId]);
  useEffect(() => void load(), [load]);

  async function act(id: string, path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(id);
    setError(null);
    try {
      await api(`/orgs/${orgId}/subscriptions/${id}/${path}`, { method: 'POST', body });
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}`}>← Organisation</Link></p>
      <h1>Subscriptions</h1>
      <p className="muted">Cancelling stops renewal — you keep access until the end of the period you paid for. Moving to a cheaper plan takes effect at renewal. For upgrades, buy the higher plan from <Link href="/pricing">Pricing</Link> or contact support for a prorated quote.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {subs === null && !error && <p aria-busy="true">Loading…</p>}
      {subs?.length === 0 && <p className="muted">No subscriptions yet.</p>}
      <div className="stack-list">
        {subs?.map((s) => (
          <section key={s.id} className="card" aria-labelledby={`sub-${s.id}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 id={`sub-${s.id}`} style={{ margin: 0 }}>{s.product.name} — {s.plan.name}</h2>
              <span className={`badge ${SUB_STATUS[s.status]?.tone ?? ''}`}>{SUB_STATUS[s.status]?.label ?? s.status}</span>
            </div>
            <p>
              {formatINR(s.amountMinor)} per {formatInterval(s.billingInterval)}{s.quantity > 1 ? ` × ${s.quantity}` : ''} (plus GST) · Current period {day(s.currentPeriodStart)} – {day(s.currentPeriodEnd)}
            </p>
            {s.cancelAtPeriodEnd && s.status !== 'cancelled' && <p><strong>Ends on {day(s.currentPeriodEnd)}.</strong> It will not renew.</p>}
            {s.status === 'suspended' && <p><strong>Access is suspended.</strong> Your data is kept. Please contact support.</p>}
            {s.scheduledChange && (
              <p>Changes to <strong>{s.scheduledChange.planName}</strong>{s.scheduledChange.amountMinor !== null ? ` (${formatINR(s.scheduledChange.amountMinor)})` : ''} on {day(s.scheduledChange.effectiveAt)}.{' '}
                <button type="button" className="btn secondary" disabled={busy === s.id} onClick={() => act(s.id, 'scheduled-change/withdraw')}>Keep current plan</button>
              </p>
            )}
            <div className="row">
              {s.status !== 'cancelled' && !s.cancelAtPeriodEnd && s.status !== 'pending_activation' && (
                <button type="button" className="btn secondary" disabled={busy === s.id} onClick={() => act(s.id, 'cancel', undefined, `Cancel ${s.product.name}? It stays active until ${day(s.currentPeriodEnd)} and will not renew.`)}>Cancel at period end</button>
              )}
              {s.cancelAtPeriodEnd && s.status !== 'cancelled' && (
                <button type="button" className="btn" disabled={busy === s.id} onClick={() => act(s.id, 'keep')}>Keep subscription</button>
              )}
              {s.downgradeOptions.length > 0 && !s.scheduledChange && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('price'); void act(s.id, 'downgrade', { priceVersionId: v, quantity: s.quantity }); }}>
                  <label>Move at renewal to
                    <select name="price" required>
                      {s.downgradeOptions.map((o) => <option key={o.priceVersionId} value={o.priceVersionId}>{o.planName} — {formatINR(o.amountMinor)}/{formatInterval(o.billingInterval)}</option>)}
                    </select>
                  </label>
                  <button type="submit" className="btn secondary" disabled={busy === s.id}>Schedule change</button>
                </form>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
