'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { CATEGORY_LABEL, TICKET_STATUS, Ticket } from '@/lib/tickets';
import { TicketThread } from '@/components/TicketThread';

export default function AdminTicket({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = use(params);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Ticket>(`/admin/tickets/${ticketId}`).then(setTicket).catch((e) => setError(describeError(e)));
  }, [ticketId]);

  async function reply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      setTicket(await api<Ticket>(`/admin/tickets/${ticketId}/messages`, { method: 'POST', body: { body: f.get('body'), internal: f.get('internal') === 'on' } }));
      form.reset();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function setStatus(status: string) {
    try {
      setTicket(await api<Ticket>(`/admin/tickets/${ticketId}/status`, { method: 'POST', body: { status } }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (!ticket) return <p aria-busy="true">{error ?? 'Loading…'}</p>;
  return (
    <>
      <p><Link href="/admin/support">← Support queue</Link></p>
      <h1>{ticket.subject}</h1>
      <p className="row">
        <span className={`badge ${TICKET_STATUS[ticket.status]?.tone ?? ''}`}>{TICKET_STATUS[ticket.status]?.label}</span>
        <span className="muted">{CATEGORY_LABEL[ticket.category ?? 'general']} · {ticket.org?.name}</span>
      </p>
      <TicketThread ticket={ticket} showInternal />
      <form className="stack" onSubmit={reply} style={{ marginTop: 16 }}>
        <label>Message
          <textarea name="body" required rows={4} maxLength={10000} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit' }} />
        </label>
        <label className="row" style={{ display: 'flex', fontWeight: 400 }}><input type="checkbox" name="internal" style={{ minHeight: 'auto' }} /> Internal note (not visible to the customer)</label>
        <button className="btn" type="submit">Send</button>
      </form>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn secondary" onClick={() => setStatus('resolved')}>Mark resolved</button>
        <button className="btn secondary" onClick={() => setStatus('closed')}>Close</button>
        <button className="btn secondary" onClick={() => setStatus('open')}>Reopen</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
