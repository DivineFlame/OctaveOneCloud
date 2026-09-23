'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { formatINR, formatInterval } from '@/lib/format';
import { useMe } from '@/components/useMe';

interface QuoteLine { id: string; description: string; quantity: number; unitAmountMinor: number; setupFeeMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; billingInterval: string }
interface Quote { id: string; status: string; subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; expiresAt: string; supplyType: string; lines: QuoteLine[] }

function Buy() {
  const params = useSearchParams();
  const priceId = params.get('price');
  const router = useRouter();
  const { me } = useMe();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const billingOrgs = me?.organizations.filter((o) => o.role === 'owner' || o.role === 'billing') ?? [];

  async function requestQuote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const org = String(f.get('org'));
    setOrgId(org);
    setBusy(true);
    setError(null);
    try {
      setQuote(await api<Quote>(`/orgs/${org}/quotes`, { method: 'POST', body: { lines: [{ priceVersionId: priceId, quantity: Number(f.get('quantity')) }] } }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function pay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quote) return;
    const phone = String(new FormData(e.currentTarget).get('phone'));
    setBusy(true);
    setError(null);
    try {
      if (quote.status === 'draft') await api(`/orgs/${orgId}/quotes/${quote.id}/accept`, { method: 'POST' });
      const order = await api<{ id: string }>(`/orgs/${orgId}/quotes/${quote.id}/checkout`, { method: 'POST', body: { idempotencyKey: `quote-${quote.id}`, phone } });
      router.push(`/dashboard/orders/${order.id}?org=${orgId}`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  if (!priceId) return <p>Choose a product on the <a href="/pricing">pricing page</a> first.</p>;
  if (!me) return <p aria-busy="true">Loading…</p>;
  if (billingOrgs.length === 0) return <div className="notice">You need an organisation where you are an owner or billing member. <a href="/dashboard">Create one on your dashboard</a>.</div>;

  return (
    <>
      <h1>Request a quote</h1>
      {!quote && (
        <form className="stack" onSubmit={requestQuote}>
          <label>Organisation
            <select name="org" required>{billingOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </label>
          <label>Quantity <span className="hint">(seats or units)</span><input name="quantity" type="number" min={1} max={10000} defaultValue={1} required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? 'Calculating…' : 'Calculate price'}</button>
        </form>
      )}
      {quote && (
        <>
          <div className="table-wrap card">
            <table>
              <caption className="muted" style={{ textAlign: 'left', paddingBottom: 8 }}>Quote valid until {new Date(quote.expiresAt).toLocaleString('en-IN')}</caption>
              <thead><tr><th scope="col">Item</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Price</th><th scope="col" className="num">Tax</th><th scope="col" className="num">Total</th></tr></thead>
              <tbody>
                {quote.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}<div className="hint">Billed every {formatInterval(l.billingInterval)}. Renews at the same price unless you are notified of a change before renewal.</div></td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{formatINR(l.unitAmountMinor * l.quantity + l.setupFeeMinor - l.discountMinor)}</td>
                    <td className="num">{formatINR(l.taxMinor)}</td>
                    <td className="num">{formatINR(l.totalMinor)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row" colSpan={4}>Total payable now (incl. {quote.supplyType === 'intra_state' ? 'CGST + SGST' : quote.supplyType === 'inter_state' ? 'IGST' : 'tax'})</th><td className="num"><strong>{formatINR(quote.totalMinor)}</strong></td></tr>
              </tfoot>
            </table>
          </div>
          <form className="stack" onSubmit={pay} style={{ marginTop: 16 }}>
            <label>Mobile number for payment<input name="phone" type="tel" inputMode="tel" pattern="\+?[0-9]{10,15}" autoComplete="tel" required /></label>
            <p className="hint">This is a one-time payment for the first term. Automatic renewal requires a separate mandate authorisation, which you can set up later.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn" disabled={busy}>{busy ? 'Starting checkout…' : `Pay ${formatINR(quote.totalMinor)}`}</button>
          </form>
        </>
      )}
    </>
  );
}

export default function BuyPage() {
  return (
    <Suspense>
      <Buy />
    </Suspense>
  );
}
