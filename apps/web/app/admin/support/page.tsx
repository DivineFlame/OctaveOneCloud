'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { CATEGORY_LABEL, TICKET_STATUS, TicketSummary } from '@/lib/tickets';

const FILTERS = ['', 'open', 'pending_internal', 'pending_customer', 'resolved', 'closed'];

export default function SupportQueue() {
  const [status, setStatus] = useState('');
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTickets(null);
    api<TicketSummary[]>(`/admin/tickets${status ? `?status=${status}` : ''}`).then(setTickets).catch((e) => setError(describeError(e)));
  }, [status]);

  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>Support queue</h1>
      <label style={{ maxWidth: 320 }}>Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map((f) => <option key={f} value={f}>{f ? TICKET_STATUS[f]?.label : 'All open (oldest first)'}</option>)}
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {tickets && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th>Subject</th><th>Organisation</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/admin/support/${t.id}`}>{t.subject}</Link></td>
                  <td>{t.org?.name}</td>
                  <td>{CATEGORY_LABEL[t.category ?? 'general']}</td>
                  <td><span className={`badge ${TICKET_STATUS[t.status]?.tone ?? ''}`}>{TICKET_STATUS[t.status]?.label}</span></td>
                  <td>{new Date(t.updatedAt).toLocaleString('en-IN')}</td>
                </tr>
              ))}
              {tickets.length === 0 && <tr><td colSpan={5} className="muted">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
