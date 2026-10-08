'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { formatINR } from '@/lib/format';

interface SnapshotMeta { id: string; environment: string; fetchedAt: string; checkedAt: string; itemCount: number; skippedCount: number; changedCount: number | null; currency: string }
interface Drift { priceVersionId: string; product: string; plan: string; ref: string; recordedCostMinor: number; currentCostMinor: number | null; sellingMinor: number; marginBps: number | null }
interface Status { enabled: boolean; environment: string; currency: string; syncEveryHours: number; cost: SnapshotMeta | null; customer: SnapshotMeta | null; costChangesOnSale: Drift[] }
interface Item { ref: string; productKey: string; category: string; plan: string | null; action: string | null; term: number | null; termUnit: string | null; costMinor: number | null; sellingMinor: number | null; marginBps: number | null }
interface List { basis?: string; environment?: string; currency?: string; total: number; items: Item[] }

const CATS = ['', 'domain', 'hosting', 'server', 'email', 'certificate', 'addon', 'other'];
const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(1)}%`);
const when = (s: string) => new Date(s).toLocaleString('en-IN');

export default function SupplierPrices() {
  const [status, setStatus] = useState<Status | null>(null);
  const [list, setList] = useState<List | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('domain');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ take: '300' });
      if (q.trim()) params.set('q', q.trim().toLowerCase());
      if (cat) params.set('category', cat);
      const [s, l] = await Promise.all([api<Status>('/admin/supplier-prices/status'), api<List>(`/admin/supplier-prices?${params}`)]);
      setStatus(s);
      setList(l);
    } catch (e) {
      setError(describeError(e));
    }
  }, [q, cat]);
  useEffect(() => void load(), [load]);

  async function sync() {
    setMsg(null);
    try {
      await api('/admin/supplier-prices/sync', { method: 'POST', body: { kind: 'both' } });
      setMsg('Fetching both price lists from ResellerClub in the background — this can take a minute or two. Reload to see the result.');
    } catch (e) {
      setMsg(describeError(e));
    }
  }

  const fmt = (m: number | null) => (m === null ? '—' : status && status.currency !== 'INR' ? `${(m / 100).toFixed(2)} ${status.currency}` : formatINR(m));
  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>ResellerClub prices</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {status && (
        <>
          {!status.enabled && <p className="notice" role="status">ResellerClub is disabled (RESELLERCLUB_ENV). Set demo or live credentials to fetch prices{status.cost ? `; showing the last ${status.cost.environment} snapshot` : ''}.</p>}
          <div className="grid">
            <div className="card"><h3>Your cost</h3><p>{status.cost ? <>{status.cost.itemCount.toLocaleString('en-IN')} prices · fetched {when(status.cost.fetchedAt)} · checked {when(status.cost.checkedAt)}{status.cost.changedCount ? ` · ${status.cost.changedCount} changed` : ''}</> : 'Not fetched yet'}</p></div>
            <div className="card"><h3>Your selling prices</h3><p>{status.customer ? <>{status.customer.itemCount.toLocaleString('en-IN')} prices · fetched {when(status.customer.fetchedAt)} · checked {when(status.customer.checkedAt)}</> : 'Not fetched yet'}</p></div>
            <div className="card"><h3>Settings</h3><p>Environment {status.environment} · currency {status.currency} · refresh {status.syncEveryHours ? `every ${status.syncEveryHours} h` : 'on demand only'}</p></div>
          </div>
          <p className="row"><button type="button" className="btn" onClick={sync} disabled={!status.enabled}>Fetch prices now</button></p>
          {msg && <p role="status" className="notice info">{msg}</p>}
          {status.costChangesOnSale.length > 0 && (
            <section>
              <h2>Cost changes behind prices on sale</h2>
              <p className="muted">ResellerClub's cost changed after these selling prices were set. Selling prices are never changed automatically — add a new price version in the catalogue if needed.</p>
              <div className="table-wrap"><table>
                <thead><tr><th scope="col">Product / plan</th><th scope="col">Item</th><th scope="col" className="num">Recorded cost</th><th scope="col" className="num">Current cost</th><th scope="col" className="num">Selling</th><th scope="col" className="num">Margin now</th></tr></thead>
                <tbody>{status.costChangesOnSale.map((d) => (
                  <tr key={d.priceVersionId}><td>{d.product} — {d.plan}</td><td><code>{d.ref}</code></td><td className="num">{fmt(d.recordedCostMinor)}</td><td className="num">{d.currentCostMinor === null ? 'no longer offered' : fmt(d.currentCostMinor)}</td><td className="num">{fmt(d.sellingMinor)}</td><td className={`num ${d.marginBps !== null && d.marginBps < 1000 ? 'error' : ''}`}>{pct(d.marginBps)}</td></tr>
                ))}</tbody>
              </table></div>
            </section>
          )}
        </>
      )}
      <h2>Price list</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label>Search product key<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. dotin, hosting" maxLength={60} /></label>
        <label>Category<select value={cat} onChange={(e) => setCat(e.target.value)}>{CATS.map((c) => <option key={c} value={c}>{c || 'All'}</option>)}</select></label>
        <button className="btn secondary" type="submit">Show</button>
      </form>
      {list && (
        <>
          <p className="muted">{list.total.toLocaleString('en-IN')} matching{list.total > list.items.length ? `, first ${list.items.length} shown` : ''}{list.environment ? ` · ${list.environment} data` : ''}. Use the item reference as “supplier cost ref” when adding a catalogue price to record its cost basis.</p>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Product key</th><th scope="col">Plan / range</th><th scope="col">Action</th><th scope="col">Term</th><th scope="col" className="num">Your cost</th><th scope="col" className="num">Your selling price</th><th scope="col" className="num">Margin</th><th scope="col">Reference</th></tr></thead>
            <tbody>{list.items.map((i) => (
              <tr key={i.ref}>
                <td>{i.productKey}<div className="hint">{i.category}</div></td>
                <td>{i.plan ?? '—'}</td>
                <td>{i.action ?? '—'}</td>
                <td>{i.term ? `${i.term} ${i.termUnit === 'years' ? (i.term === 1 ? 'year' : 'years') : i.termUnit === 'months' ? (i.term === 1 ? 'month' : 'months') : ''}` : '—'}</td>
                <td className="num">{fmt(i.costMinor)}</td>
                <td className="num">{fmt(i.sellingMinor)}</td>
                <td className={`num ${i.marginBps !== null && i.marginBps < 0 ? 'error' : ''}`}>{pct(i.marginBps)}</td>
                <td><code style={{ fontSize: '0.8rem' }}>{i.ref}</code></td>
              </tr>
            ))}</tbody>
          </table></div>
          {list.items.length === 0 && <p className="muted">No prices yet — fetch them first.</p>}
        </>
      )}
    </>
  );
}
