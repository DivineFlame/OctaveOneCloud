'use client';

import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { api, describeError } from '@/lib/api';
import { ORDER_STATUS_TEXT, formatINR } from '@/lib/format';

interface OrderView {
  id: string;
  kind?: string;
  status: string;
  totalMinor: number;
  paidAt: string | null;
  payment: { status: string; paymentSessionId: string | null; mode: string } | null;
  items: { id: string; quantity: number; totalMinor: number; provisioning: { id: string; status: string; adapterKey: string }[] }[];
}

declare global {
  interface Window {
    Cashfree?: (opts: { mode: 'sandbox' | 'production' }) => { checkout: (o: { paymentSessionId: string; redirectTarget?: string }) => Promise<unknown> };
  }
}

function Order({ orderId }: { orderId: string }) {
  const orgId = useSearchParams().get('org') ?? '';
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderView>(`/orgs/${orgId}/orders/${orderId}`));
    } catch (e) {
      setError(describeError(e));
    }
  }, [orgId, orderId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function pay() {
    if (!order?.payment?.paymentSessionId || !window.Cashfree) return;
    const cashfree = window.Cashfree({ mode: order.payment.mode === 'production' ? 'production' : 'sandbox' });
    await cashfree.checkout({ paymentSessionId: order.payment.paymentSessionId, redirectTarget: '_self' });
  }

  async function checkStatus() {
    await api(`/orgs/${orgId}/orders/${orderId}/reconcile`, { method: 'POST' }).catch((e) => setError(describeError(e)));
    setTimeout(() => void load(), 3000);
  }

  if (!order) return <p aria-busy="true">{error ?? 'Loading…'}</p>;
  const status = ORDER_STATUS_TEXT[order.status] ?? { label: order.status, tone: 'neutral' };
  return (
    <>
      <Script src="https://sdk.cashfree.com/js/v3/cashfree.js" strategy="afterInteractive" onLoad={() => setSdkReady(true)} />
      <h1>{order.kind === 'renewal' ? 'Renewal payment' : 'Order'}</h1>
      <p className="muted">Order ID: <code>{order.id}</code></p>
      <p aria-live="polite"><span className={`badge ${status.tone}`}>{status.label}</span></p>
      <p>Total: <strong>{formatINR(order.totalMinor)}</strong></p>
      {order.status === 'awaiting_payment' && order.payment?.paymentSessionId && (
        <div className="row">
          <button className="btn" onClick={pay} disabled={!sdkReady}>Pay securely with Cashfree</button>
          <button className="btn secondary" onClick={checkStatus}>I have paid — check payment status</button>
        </div>
      )}
      {order.status === 'awaiting_payment' && (
        <p className="hint">We only mark an order as paid after confirmation from the payment provider. This page refreshes automatically.</p>
      )}
      <h2>Items</h2>
      <ul>
        {order.items.map((i) => (
          <li key={i.id}>
            Qty {i.quantity} — {formatINR(i.totalMinor)}
            {i.provisioning.map((p) => <span key={p.id} className="badge" style={{ marginLeft: 8 }}>{p.status.replace('_', ' ')}</span>)}
          </li>
        ))}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

export default function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  return (
    <Suspense>
      <Order orderId={orderId} />
    </Suspense>
  );
}
