'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { InvoiceSummary } from '@/lib/invoices';

interface AdminList { sellerConfigured: boolean; ordersAwaitingInvoice: number; invoices: InvoiceSummary[] }

export default function AdminInvoices() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [data, setData] = useState<AdminList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((number: string) => api<AdminList>(`/admin/invoices${number ? `?number=${encodeURIComponent(number)}` : ''}`).then(setData).catch((e) => setError(describeError(e))), []);
  useEffect(() => void load(''), [load]);

  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const orderId = String(new FormData(e.currentTarget).get('orderId') ?? '').trim();
    setError(null);
    try {
      const r = await api<{ invoiceId: string }>(`/admin/invoices/issue/${encodeURIComponent(orderId)}`, { method: 'POST' });
      router.push(`/admin/invoices/${r.invoiceId}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>Invoices</h1>
      {data && !data.sellerConfigured && <p role="alert" className="error">Seller details are not configured (SELLER_LEGAL_NAME, SELLER_ADDRESS, SELLER_STATE_CODE). Paid orders wait without invoices until they are set.</p>}
      {data && <p className="muted">Paid orders awaiting an invoice: {data.ordersAwaitingInvoice} (the worker issues them within a minute).</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void load(q); }}>
        <label>Invoice number contains <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={20} /></label>
        <button className="btn secondary" type="submit">Search</button>
      </form>
      <details style={{ margin: '12px 0' }}>
        <summary>Issue invoice for a paid order now</summary>
        <form className="row" onSubmit={issue}>
          <label>Order ID <input name="orderId" required pattern="[0-9a-fA-F-]{36}" /></label>
          <button className="btn" type="submit">Issue</button>
        </form>
      </details>
      {data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Number</th><th scope="col">Organisation</th><th scope="col">Date</th><th scope="col" className="num">Total</th></tr></thead>
            <tbody>
              {data.invoices.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/admin/invoices/${r.id}`}>{r.number}</Link></td><td>{r.orgName}</td>
                  <td>{new Date(r.issuedAt).toLocaleDateString('en-IN')}</td><td className="num">{formatINR(r.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
