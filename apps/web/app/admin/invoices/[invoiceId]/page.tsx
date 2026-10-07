'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { Invoice } from '@/lib/invoices';
import { InvoiceDocument } from '@/components/InvoiceDocument';

export default function AdminInvoice({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = use(params);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Invoice>(`/admin/invoices/${invoiceId}`).then(setInv).catch((e) => setError(describeError(e))), [invoiceId]);
  useEffect(() => void load(), [load]);

  const credited = inv?.creditNotes.reduce((a, c) => a + c.amountMinor, 0) ?? 0;
  const remaining = inv ? inv.subtotalMinor - credited : 0;

  async function credit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const rupees = Number(f.get('amount'));
    const taxableMinor = Math.round(rupees * 100);
    if (!window.confirm(`Issue credit note for taxable value ${formatINR(taxableMinor)} (plus proportional GST)? Credit notes cannot be edited or deleted.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/invoices/${invoiceId}/credit-notes`, { method: 'POST', body: { taxableMinor, reason: f.get('reason') } });
      form.reset();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="row no-print"><Link href="/admin/invoices">← Invoices</Link><button type="button" className="btn secondary" onClick={() => window.print()} disabled={!inv}>Print</button></p>
      {error && <p role="alert" className="error">{error}</p>}
      {inv ? <InvoiceDocument invoice={inv} /> : !error && <p aria-busy="true">Loading…</p>}
      {inv && (
        <section className="no-print card" style={{ marginTop: 24 }}>
          <h2>Issue credit note</h2>
          <p className="muted">Finance operators only. Remaining creditable taxable value: {formatINR(remaining)}. GST is credited in the same proportion as the invoice. A credit note does not move money — refunds are handled separately.</p>
          {remaining > 0 ? (
            <form onSubmit={credit} className="stack">
              <label>Taxable amount to credit (₹)<input name="amount" type="number" min="0.01" step="0.01" max={(remaining / 100).toFixed(2)} required /></label>
              <label>Reason<input name="reason" minLength={3} maxLength={500} required /></label>
              <button className="btn" type="submit" disabled={busy}>Issue credit note</button>
            </form>
          ) : <p>This invoice is fully credited.</p>}
        </section>
      )}
    </>
  );
}
