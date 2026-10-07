'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { CATEGORY_LABEL, TICKET_STATUS, TicketSummary } from '@/lib/tickets';
import { useMe } from '@/components/useMe';

export default function SupportList({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const { me } = useMe();
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<TicketSummary[]>(`/orgs/${orgId}/tickets`).then(setTickets).catch((e) => setError(describeError(e))), [orgId]);
  useEffect(() => void load(), [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const t = await api<{ id: string }>(`/orgs/${orgId}/tickets`, { method: 'POST', body: { subject: f.get('subject'), body: f.get('body'), category: f.get('category') } });
      router.push(`/dashboard/orgs/${orgId}/support/${t.id}`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  if (!me) return <p aria-busy="true">Loading…</p>;
  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}`}>← Organisation</Link></p>
      <h1>Support</h1>
      <h2>Your requests</h2>
      {tickets === null ? (
        <p aria-busy="true">Loading…</p>
      ) : tickets.length === 0 ? (
        <p className="muted">No support requests yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Subject</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Updated</th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/dashboard/orgs/${orgId}/support/${t.id}`}>{t.subject}</Link></td>
                  <td>{CATEGORY_LABEL[t.category ?? 'general'] ?? t.category}</td>
                  <td><span className={`badge ${TICKET_STATUS[t.status]?.tone ?? ''}`}>{TICKET_STATUS[t.status]?.label ?? t.status}</span></td>
                  <td>{new Date(t.updatedAt).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>New request</h2>
      <form className="stack" onSubmit={create}>
        <label>Type
          <select name="category" defaultValue="general">
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Subject<input name="subject" required minLength={3} maxLength={200} /></label>
        <label>Details
          <textarea name="body" required rows={6} maxLength={10000} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit' }} aria-describedby="details-hint" />
          <span id="details-hint" className="hint">Never include passwords or card numbers.</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
    </>
  );
}
