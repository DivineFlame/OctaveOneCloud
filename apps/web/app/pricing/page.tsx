import Link from 'next/link';
import type { Metadata } from 'next';
import { fetchCatalogue } from '@/lib/server';
import { formatINR, formatInterval } from '@/lib/format';

export const metadata: Metadata = { title: 'Products & pricing' };
export const dynamic = 'force-dynamic';

const FAMILY_NAMES: Record<string, string> = {
  domains: 'Domains',
  web_infrastructure: 'Web infrastructure',
  business_essentials: 'Business essentials',
  hosted_apps: 'Hosted business apps',
  agentic_bundles: 'Agentic bundles',
  managed_services: 'Managed services',
};

export default async function Pricing() {
  const catalogue = await fetchCatalogue();
  return (
    <>
      <h1>Products &amp; pricing</h1>
      <p className="lead">Prices are in Indian rupees, before GST. Taxes, renewal prices and the full term charge are shown before checkout.</p>
      {catalogue === null && <div className="notice" role="status">The catalogue is temporarily unavailable. Please try again shortly.</div>}
      {catalogue !== null && catalogue.length === 0 && (
        <div className="notice info" role="status">
          Our plans are being finalised and are not yet on sale. <Link href="/register">Create an account</Link> and we will let you know when they are available.
        </div>
      )}
      {catalogue?.map((p) => (
        <section key={p.key} aria-labelledby={`p-${p.key}`}>
          <h2 id={`p-${p.key}`}>{p.name} <span className="badge">{FAMILY_NAMES[p.family] ?? p.family}</span></h2>
          {p.description && <p className="muted">{p.description}</p>}
          <div className="grid">
            {p.plans.map((plan) => (
              <article className="card" key={plan.key}>
                <h3>{plan.name}</h3>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f.key}>{f.name}{f.limit !== null ? `: ${f.limit}${f.unit ? ` ${f.unit}` : ''}` : ''}</li>
                  ))}
                </ul>
                {plan.prices.map((pr) => (
                  <div key={pr.id} className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                    <span>
                      <strong>{formatINR(pr.amountMinor)}</strong> / {formatInterval(pr.billingInterval)}
                      {pr.setupFeeMinor > 0 && <span className="hint"> + {formatINR(pr.setupFeeMinor)} setup</span>}
                    </span>
                    <Link className="btn" href={`/dashboard/buy?price=${pr.id}`}>Get quote</Link>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
