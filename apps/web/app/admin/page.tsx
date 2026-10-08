'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, describeError } from '@/lib/api';

interface Integrations {
  resellerclub: { env: string; liveMutationsAllowed: boolean; capabilities: { adapterKey: string; operation: string; verified: boolean; fallback: string }[] };
  cashfree: { env: string; apiVersion: string; webhookSecretConfigured: boolean; subscriptionsEnabled: boolean };
  smtpConfigured: boolean;
  adapters: { key: string; name: string; status: string }[];
}
interface Product { id: string; key: string; name: string; family: string; status: string; verificationNote: string | null }

export default function Admin() {
  const [data, setData] = useState<Integrations | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [blockers, setBlockers] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<Integrations>('/admin/integrations'), api<Product[]>('/admin/catalogue/products')])
      .then(([i, p]) => {
        setData(i);
        setProducts(p);
      })
      .catch((e) => setError(e instanceof ApiError && e.body.error === 'mfa_required' ? 'Two-factor authentication is required for the operations console. Enable it and sign in again.' : describeError(e)));
  }, []);

  const [adapterMsg, setAdapterMsg] = useState<string | null>(null);

  async function setAdapterStatus(key: string, status: string) {
    const note = window.prompt(`Reason for setting ${key} to ${status} (recorded in the audit log):`);
    if (!note || note.trim().length < 3) return;
    setAdapterMsg(null);
    try {
      await api(`/admin/adapters/${encodeURIComponent(key)}/status`, { method: 'POST', body: { status, note: note.trim() } });
      setData(await api<Integrations>('/admin/integrations'));
      setAdapterMsg(`${key} is now ${status}.`);
    } catch (e) {
      setAdapterMsg(describeError(e));
    }
  }

  async function check(id: string) {
    const r = await api<{ blockers: string[] }>(`/admin/catalogue/products/${id}/activation-blockers`);
    setBlockers((b) => ({ ...b, [id]: r.blockers }));
  }

  if (error) return <div className="notice" role="alert">{error}</div>;
  if (!data) return <p aria-busy="true">Loading…</p>;
  return (
    <>
      <h1>Operations console</h1>
      <p className="row"><a className="btn" href="/admin/readiness">Launch readiness</a><a className="btn secondary" href="/admin/support">Support queue</a><a className="btn secondary" href="/admin/invoices">Invoices</a><a className="btn secondary" href="/admin/subscriptions">Subscriptions</a><a className="btn secondary" href="/admin/refunds">Refunds</a><a className="btn secondary" href="/admin/supplier-prices">ResellerClub prices</a></p>
      <h2>Integrations</h2>
      <div className="grid">
        <div className="card"><h3>Cashfree</h3><p>Environment: {data.cashfree.env} · API {data.cashfree.apiVersion}</p><p>Webhook secret: {data.cashfree.webhookSecretConfigured ? 'configured' : 'missing'} · Subscriptions: {data.cashfree.subscriptionsEnabled ? 'enabled' : 'disabled'}</p></div>
        <div className="card"><h3>ResellerClub</h3><p>Environment: {data.resellerclub.env} · Live mutations: {data.resellerclub.liveMutationsAllowed ? 'ALLOWED' : 'blocked'}</p><p>Verified capabilities: {data.resellerclub.capabilities.filter((c) => c.verified).length} / {data.resellerclub.capabilities.length}</p></div>
        <div className="card"><h3>Email</h3><p>SMTP: {data.smtpConfigured ? 'configured' : 'not configured'}</p></div>
      </div>
      <h2>App adapters</h2>
      {adapterMsg && <p role="status" className="notice">{adapterMsg}</p>}
      <p className="hint">Set APP_ADAPTER_&lt;NAME&gt;_URL and _SECRET in the environment first. Use <em>sandbox</em> while testing, <em>active</em> only after the app passed its contract tests.</p>
      <div className="table-wrap"><table><thead><tr><th>Adapter</th><th>Status</th><th>Change</th></tr></thead><tbody>{data.adapters.map((a) => (
        <tr key={a.key}>
          <td>{a.name} <span className="hint">{a.key}</span></td>
          <td>{a.status}</td>
          <td>
            <select aria-label={`New status for ${a.name}`} defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) void setAdapterStatus(a.key, v); }}>
              <option value="" disabled>Set status…</option>
              {['unconfigured', 'sandbox', 'active', 'disabled'].filter((s) => s !== a.status).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </td>
        </tr>
      ))}</tbody></table></div>
      <h2>Catalogue</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}<div className="hint">{p.family}</div></td>
                <td>{p.status}</td>
                <td>{p.verificationNote}{blockers[p.id] && <ul>{blockers[p.id]!.map((b) => <li key={b}>{b}</li>)}</ul>}</td>
                <td><button className="btn secondary" onClick={() => void check(p.id)}>Check sale readiness</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
