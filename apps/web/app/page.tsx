import Link from 'next/link';

const FAMILIES = [
  { title: 'Domains', body: 'Search, registration, transfer, renewals and DNS.' },
  { title: 'Web infrastructure', body: 'Hosting and servers for your websites and applications.' },
  { title: 'Business essentials', body: 'Business email, SSL certificates, backup and security.' },
  { title: 'Hosted business apps', body: 'CRM, marketing workspace, support desk, workflow automation and a knowledge assistant.' },
  { title: 'Agentic bundles', body: 'Sales, marketing, support and operations desks that combine apps with supervised AI agents and human approval.' },
  { title: 'Managed services', body: 'Setup, migration, workflow configuration and managed support.' },
];

export default function Home() {
  return (
    <>
      <h1>Business cloud, in one account</h1>
      <p className="lead">
        Buy and manage the cloud services your business runs on — with one team account, clear renewal prices,
        GST-ready invoices and honest provisioning status.
      </p>
      <div className="row" style={{ margin: '20px 0 8px' }}>
        <Link className="btn" href="/pricing">See products &amp; pricing</Link>
        <Link className="btn secondary" href="/register">Create an account</Link>
      </div>
      <div className="notice info" role="note">
        We are finalising our catalogue. Only products that are fully operational are offered for sale; others are listed as coming soon.
      </div>
      <h2>What you can manage here</h2>
      <div className="grid">
        {FAMILIES.map((f) => (
          <section className="card" key={f.title} aria-labelledby={`f-${f.title}`}>
            <h3 id={`f-${f.title}`}>{f.title}</h3>
            <p>{f.body}</p>
          </section>
        ))}
      </div>
    </>
  );
}
