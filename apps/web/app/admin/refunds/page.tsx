'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';

interface RefundRow { id: string; orderId: string; org: { id: string; name: string }; amountMinor: number; status: string; reason: string; lastError: string | null; creditNote: boolean; createdAt: string; updatedAt: string }
const FILTERS = ['', 'requested', 'pending', 'success', 'failed', 'cancelled'];

export default function AdminRefunds() {
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<RefundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api<RefundRow[]>(`/admin/refunds${status ? `?status=${status}` : ''}`).then(setRows).catch((e) => setError(describeError(e)));
  }, [status]);

  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>Refunds</h1>
      <p className="muted">Start refunds from an invoice (Admin → Invoices). Requested and pending refunds are checked with Cashfree every few minutes.</p>
      <label style={{ maxWidth: 320 }}>Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map((f) => <option key={f} value={f}>{f || 'All (latest 200)'}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      {rows && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th scope="col">Requested</th><th scope="col">Organisation</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                  <td>{r.org.name}</td>
                  <td className="num">{formatINR(r.amountMinor)}</td>
                  <td><span className={`badge ${r.status === 'success' ? 'good' : r.status === 'failed' ? 'warn' : 'progress'}`}>{r.status}</span>{r.lastError && <div className="error">{r.lastError}</div>}</td>
                  <td>{r.reason}{r.creditNote ? ' · credit note' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="muted">No refunds.</p>}
        </div>
      )}
    </>
  );
}
