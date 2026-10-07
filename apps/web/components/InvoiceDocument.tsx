import { formatINR } from '@/lib/format';
import { Invoice, Party, SUPPLY_TYPE, rate } from '@/lib/invoices';

function PartyBlock({ title, p }: { title: string; p: Party }) {
  return (
    <div>
      <h3>{title}</h3>
      <p>
        <strong>{p.legalName}</strong>
        {p.address ? <><br />{p.address}</> : null}
        {p.gstin ? <><br />GSTIN: {p.gstin}</> : <><br />GSTIN: not provided</>}
        {p.stateCode ? <><br />State code: {p.stateCode}</> : null}
      </p>
    </div>
  );
}

const date = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Printable tax invoice. Layout and wording must be confirmed by the accountant before launch. */
export function InvoiceDocument({ invoice: inv }: { invoice: Invoice }) {
  const b = inv.billing;
  return (
    <article className="invoice-doc" aria-label={`Tax invoice ${inv.number}`}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0 }}>Tax invoice</h2>
          <p className="muted" style={{ margin: 0 }}>Original for recipient</p>
        </div>
        <dl className="invoice-meta">
          <dt>Invoice no.</dt><dd>{inv.number}</dd>
          <dt>Date</dt><dd>{date(inv.issuedAt)}</dd>
          <dt>Place of supply</dt><dd>{b.placeOfSupply ?? '—'}</dd>
          <dt>Supply</dt><dd>{SUPPLY_TYPE[b.supplyType] ?? b.supplyType}</dd>
          <dt>Reverse charge</dt><dd>{b.reverseCharge ? 'Yes' : 'No'}</dd>
        </dl>
      </header>
      <div className="grid">
        <PartyBlock title="Supplier" p={b.seller} />
        <PartyBlock title="Bill to" p={b.buyer} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Description</th><th scope="col">SAC</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Taxable value</th><th scope="col" className="num">Tax</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td><td>{l.sacCode ?? '—'}</td><td className="num">{l.quantity}</td>
                <td className="num">{formatINR(l.amountMinor)}</td><td className="num">{formatINR(l.taxMinor)}</td><td className="num">{formatINR(l.amountMinor + l.taxMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row" colSpan={5}>Taxable value</th><td className="num">{formatINR(inv.subtotalMinor)}</td></tr>
            {inv.taxBreakdown.map((t) => (
              <tr key={`${t.name}${t.rateBps}`}><th scope="row" colSpan={5}>{t.name} @ {rate(t.rateBps)}</th><td className="num">{formatINR(t.amountMinor)}</td></tr>
            ))}
            <tr><th scope="row" colSpan={5}>Total ({inv.currency})</th><td className="num"><strong>{formatINR(inv.totalMinor)}</strong></td></tr>
          </tfoot>
        </table>
      </div>
      <p className="muted">Paid on {date(b.paidAt)} · Order {b.orderId}. This is a computer-generated invoice.</p>
      {inv.creditNotes.length > 0 && (
        <section>
          <h3>Credit notes against this invoice</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Reason</th><th scope="col" className="num">Taxable</th><th scope="col" className="num">Tax</th><th scope="col" className="num">Total credit</th></tr></thead>
              <tbody>
                {inv.creditNotes.map((c) => (
                  <tr key={c.id}><td>{c.number}</td><td>{date(c.issuedAt)}</td><td>{c.reason}</td><td className="num">{formatINR(c.amountMinor)}</td><td className="num">{formatINR(c.taxMinor)}</td><td className="num">{formatINR(c.amountMinor + c.taxMinor)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </article>
  );
}
