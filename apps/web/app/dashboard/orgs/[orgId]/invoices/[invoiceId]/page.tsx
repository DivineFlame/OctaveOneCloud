'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { Invoice } from '@/lib/invoices';
import { InvoiceDocument } from '@/components/InvoiceDocument';

export default function InvoiceView({ params }: { params: Promise<{ orgId: string; invoiceId: string }> }) {
  const { orgId, invoiceId } = use(params);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<Invoice>(`/orgs/${orgId}/invoices/${invoiceId}`).then(setInv).catch((e) => setError(describeError(e))), [orgId, invoiceId]);

  return (
    <>
      <p className="row no-print"><Link href={`/dashboard/orgs/${orgId}/invoices`}>← Invoices</Link><button type="button" className="btn secondary" onClick={() => window.print()} disabled={!inv}>Print / save as PDF</button></p>
      {error && <p role="alert" className="error">{error}</p>}
      {inv ? <InvoiceDocument invoice={inv} /> : !error && <p aria-busy="true">Loading…</p>}
    </>
  );
}
