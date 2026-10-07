'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { SUB_STATUS, SubscriptionView, day } from '@/lib/subscriptions';

export default function AdminSubscriptions() {
  const [filter, setFilter] = useState('attention');
  const [subs, setSubs] = useState<SubscriptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const q = filter === 'attention' ? '?attention=true' : filter ? `?status=${filter}` : '';
    return api<SubscriptionView[]>(`/admin/subscriptions${q}`).then(setSubs).catch((e) => setError(describeError(e)));
  }, [filter]);
  useEffect(() => void load(), [load]);

  async function act(s: SubscriptionView, action: 'suspend' | 'resume') {
    const reason = window.prompt(`Reason to ${action} ${s.product.name} for ${s.org.name} (recorded in the audit log):`);
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    try {
      await api(`/admin/subscriptions/${s.id}/${action}`, { method: 'POST', body: { reason: reason.trim() } });
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>Subscriptions</h1>
      <p className="muted">Suspend/resume requests are carried out by the worker through the app adapter (normally within a minute). Suspension never deletes customer data.</p>
      <label style={{ maxWidth: 320 }}>Show
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="attention">Needs attention (lifecycle errors)</option>
          <option value="">All (latest 200)</option>
          {Object.entries(SUB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      {subs && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th scope="col">Organisation</th><th scope="col">Product / plan</th><th scope="col">Status</th><th scope="col">Period ends</th><th scope="col">Notes</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.org.name}</td>
                  <td>{s.product.name} — {s.plan.name}<br /><span className="muted">{formatINR(s.amountMinor)} × {s.quantity}</span></td>
                  <td><span className={`badge ${SUB_STATUS[s.status]?.tone ?? ''}`}>{SUB_STATUS[s.status]?.label ?? s.status}</span></td>
                  <td>{day(s.currentPeriodEnd)}</td>
                  <td>
                    {s.pendingAction && <div>Pending: {s.pendingAction}</div>}
                    {s.cancelAtPeriodEnd && <div>Cancels at period end</div>}
                    {s.scheduledChange && <div>Changes to {s.scheduledChange.planName}</div>}
                    {s.renewal && <div>Renewal due {day(s.renewal.dueAt)}{s.renewal.orderId ? ' (awaiting payment)' : ''}</div>}
                    {s.renewal?.problem && <div className="error">Renewal: {s.renewal.problem}</div>}
                    {s.suspensionReason && <div>Suspended: {s.suspensionReason}</div>}
                    {s.lastLifecycleError && <div className="error">{s.lastLifecycleError}</div>}
                  </td>
                  <td>
                    {s.status === 'suspended' ? (
                      <button type="button" className="btn secondary" disabled={!!s.pendingAction} onClick={() => act(s, 'resume')}>Resume</button>
                    ) : s.status !== 'cancelled' && s.status !== 'pending_activation' ? (
                      <button type="button" className="btn secondary" disabled={!!s.pendingAction} onClick={() => act(s, 'suspend')}>Suspend</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {subs.length === 0 && <p className="muted">Nothing to show.</p>}
        </div>
      )}
    </>
  );
}
