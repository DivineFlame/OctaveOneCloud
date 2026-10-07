'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { Invoice } from '@/lib/invoices';

interface PaymentSummary { paidMinor: number; refundableMinor: number; refunds: { id: string; amountMinor: number; status: string; reason: string; lastError: string | null; creditNote: boolean; createdAt: string }[] }
import { InvoiceDocument } from '@/components/InvoiceDocument';

export default function AdminInvoice({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = use(params);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<PaymentSummary | null>(null);
  const load = useCallback(async () => {
    try {
      const i = await api<Invoice>(`/admin/invoices/${invoiceId}`);
      setInv(i);
      if (i.orderId) setPay(await api<PaymentSummary>(`/admin/orders/${i.orderId}/payments`).catch(() => null));
    } catch (e) {
      setError(describeError(e));
    }
  }, [invoiceId]);
  useEffect(() => void load(), [load]);

  async function refund(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!inv?.orderId) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const amountMinor = Math.round(Number(f.get('amount')) * 100);
    const creditNote = f.get('creditNote') === 'on';
    if (!window.confirm(`Refund ${formatINR(amountMinor)} to the customer through Cashfree?${creditNote ? ' A credit note will be issued once the refund is confirmed.' : ''}`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/orders/${inv.orderId}/refunds`, { method: 'POST', body: { amountMinor, reason: f.get('reason'), creditNote } });
      form.reset();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

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
          <h2>Refund payment</h2>
          {!pay ? <p className="muted">Payment details are available to finance operators.</p> : (
            <>
              <p className="muted">Paid {formatINR(pay.paidMinor)} · refundable {formatINR(pay.refundableMinor)}. The refund is final only when Cashfree confirms it; status updates automatically.</p>
              {pay.refunds.length > 0 && (
                <ul>
                  {pay.refunds.map((r) => (
                    <li key={r.id}>{formatINR(r.amountMinor)} — <span className="badge">{r.status}</span> {r.reason}{r.creditNote ? ' (credit note on confirmation)' : ''}{r.lastError ? <span className="error"> {r.lastError}</span> : null}</li>
                  ))}
                </ul>
              )}
              {pay.refundableMinor > 0 && (
                <form onSubmit={refund} className="stack">
                  <label>Amount to refund incl. GST (₹)<input name="amount" type="number" min="0.01" step="0.01" max={(pay.refundableMinor / 100).toFixed(2)} required /></label>
                  <label>Reason<input name="reason" minLength={3} maxLength={200} required /></label>
                  <label className="row"><input name="creditNote" type="checkbox" defaultChecked style={{ minHeight: 0 }} /> Issue a GST credit note when the refund is confirmed</label>
                  <button className="btn" type="submit" disabled={busy}>Refund</button>
                </form>
              )}
            </>
          )}
        </section>
      )}
      {inv && (
        <section className="no-print card" style={{ marginTop: 24 }}>
          <h2>Issue credit note</h2>
          <p className="muted">Finance operators only. Remaining creditable taxable value: {formatINR(remaining)}. GST is credited in the same proportion as the invoice. A credit note on its own does not move money — use Refund payment above to return money.</p>
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
