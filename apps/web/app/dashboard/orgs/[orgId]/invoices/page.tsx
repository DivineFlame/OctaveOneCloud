'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { InvoiceSummary } from '@/lib/invoices';

export default function InvoiceList({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [rows, setRows] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<InvoiceSummary[]>(`/orgs/${orgId}/invoices`).then(setRows).catch((e) => setError(describeError(e))), [orgId]);

  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}`}>← Organisation</Link></p>
      <h1>Invoices</h1>
      <p className="muted">A GST tax invoice is issued automatically once a payment is confirmed. Corrections and refunds appear as credit notes on the invoice.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {rows === null && !error ? (
        <p aria-busy="true">Loading…</p>
      ) : rows && rows.length === 0 ? (
        <p className="muted">No invoices yet.</p>
      ) : rows ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col" className="num">Taxable</th><th scope="col" className="num">GST</th><th scope="col" className="num">Total</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/dashboard/orgs/${orgId}/invoices/${r.id}`}>{r.number}</Link></td>
                  <td>{new Date(r.issuedAt).toLocaleDateString('en-IN')}</td>
                  <td className="num">{formatINR(r.subtotalMinor)}</td><td className="num">{formatINR(r.taxMinor)}</td><td className="num">{formatINR(r.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
