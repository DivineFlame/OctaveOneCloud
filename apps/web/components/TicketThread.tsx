'use client';

import { Ticket } from '@/lib/tickets';

export function TicketThread({ ticket, showInternal = false }: { ticket: Ticket; showInternal?: boolean }) {
  return (
    <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }} aria-label="Conversation">
      {ticket.messages
        .filter((m) => showInternal || !m.internal)
        .map((m) => (
          <li key={m.id} className="card" style={m.internal ? { borderStyle: 'dashed' } : m.author.isStaff ? { borderLeft: '4px solid var(--accent)' } : undefined}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{m.author.name}{m.internal && <span className="badge warn" style={{ marginLeft: 8 }}>Internal note</span>}</strong>
              <time className="hint" dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('en-IN')}</time>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{m.body}</p>
          </li>
        ))}
    </ol>
  );
}
