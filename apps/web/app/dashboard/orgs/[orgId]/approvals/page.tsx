'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';

interface Approval {
  id: string;
  actionType: string;
  summary: string | null;
  requestedBy: string | null;
  payload: Record<string, unknown>;
  actionHash: string;
  status: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  createdAt: string;
  canDecide: boolean;
}

const ACTION: Record<string, string> = { outbound_message: 'Send a message', publish_campaign: 'Publish a campaign', delete: 'Delete data', spend: 'Spend money' };
const STATUS: Record<string, string> = { pending: 'Waiting for decision', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', invalidated: 'Cancelled (action changed)', executed: 'Done' };

export default function Approvals({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<Approval[]>(`/orgs/${orgId}/approvals${all ? '' : '?status=pending'}`).then(setRows).catch((e) => setError(describeError(e))), [orgId, all]);
  useEffect(() => void load(), [load]);

  async function decide(a: Approval, approve: boolean) {
    if (approve && !window.confirm(`Approve: ${a.summary ?? ACTION[a.actionType]}?\n\nThe assistant may perform exactly this action once.`)) return;
    setBusy(a.id);
    setError(null);
    try {
      await api(`/orgs/${orgId}/approvals/${a.id}/decide`, { method: 'POST', body: { approve, actionHash: a.actionHash } });
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
      <h1>Approvals</h1>
      <p className="muted">Assistants ask before sending messages, publishing, deleting data or spending money. An approval covers exactly the action shown, once, until it expires.</p>
      <label className="row" style={{ maxWidth: 360 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ minHeight: 0 }} /> Show decided and expired requests</label>
      {error && <p role="alert" className="error">{error}</p>}
      {rows === null && !error && <p aria-busy="true">Loading…</p>}
      {rows?.length === 0 && <p className="muted">{all ? 'No requests yet.' : 'Nothing is waiting for approval.'}</p>}
      <div className="stack-list">
        {rows?.map((a) => (
          <section key={a.id} className="card" aria-labelledby={`ap-${a.id}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 id={`ap-${a.id}`} style={{ margin: 0, fontSize: '1.1rem' }}>{a.summary ?? ACTION[a.actionType] ?? a.actionType}</h2>
              <span className={`badge ${a.status === 'pending' ? 'progress' : a.status === 'approved' || a.status === 'executed' ? 'good' : ''}`}>{STATUS[a.status] ?? a.status}</span>
            </div>
            <p className="muted">{ACTION[a.actionType] ?? a.actionType} · requested by {a.requestedBy ?? 'an assistant'} on {new Date(a.createdAt).toLocaleString('en-IN')} · expires {new Date(a.expiresAt).toLocaleString('en-IN')}</p>
            <details open={a.status === 'pending'}>
              <summary>Exact action</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--surface-2)', padding: 12, borderRadius: 8 }}>{JSON.stringify(a.payload, null, 2)}</pre>
            </details>
            {a.status === 'pending' && (a.canDecide ? (
              <div className="row">
                <button type="button" className="btn" disabled={busy === a.id} onClick={() => decide(a, true)}>Approve</button>
                <button type="button" className="btn secondary" disabled={busy === a.id} onClick={() => decide(a, false)}>Reject</button>
              </div>
            ) : <p className="muted">{a.actionType === 'spend' ? 'An owner or billing member can decide.' : 'An owner or admin can decide.'}</p>)}
          </section>
        ))}
      </div>
    </>
  );
}
