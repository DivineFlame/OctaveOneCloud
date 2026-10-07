'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { CATEGORY_LABEL, TICKET_STATUS, Ticket } from '@/lib/tickets';
import { TicketThread } from '@/components/TicketThread';

export default function TicketPage({ params }: { params: Promise<{ orgId: string; ticketId: string }> }) {
  const { orgId, ticketId } = use(params);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Ticket>(`/orgs/${orgId}/tickets/${ticketId}`).then(setTicket).catch((e) => setError(describeError(e))), [orgId, ticketId]);
  useEffect(() => void load(), [load]);

  async function reply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      setTicket(await api<Ticket>(`/orgs/${orgId}/tickets/${ticketId}/messages`, { method: 'POST', body: { body: new FormData(form).get('body') } }));
      form.reset();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function close() {
    try {
      setTicket(await api<Ticket>(`/orgs/${orgId}/tickets/${ticketId}/close`, { method: 'POST' }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (!ticket) return <p aria-busy="true">{error ?? 'Loading…'}</p>;
  const st = TICKET_STATUS[ticket.status];
  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}/support`}>← Support</Link></p>
      <h1>{ticket.subject}</h1>
      <p className="row"><span className={`badge ${st?.tone ?? ''}`}>{st?.label ?? ticket.status}</span><span className="muted">{CATEGORY_LABEL[ticket.category ?? 'general']}</span></p>
      <TicketThread ticket={ticket} />
      {ticket.status !== 'closed' ? (
        <form className="stack" onSubmit={reply} style={{ marginTop: 16 }}>
          <label>Reply
            <textarea name="body" required rows={4} maxLength={10000} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit' }} />
          </label>
          <div className="row">
            <button className="btn" type="submit">Send reply</button>
            <button className="btn secondary" type="button" onClick={close}>Close request</button>
          </div>
        </form>
      ) : (
        <p className="muted">This request is closed. <Link href={`/dashboard/orgs/${orgId}/support`}>Open a new one</Link> if you need more help.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
