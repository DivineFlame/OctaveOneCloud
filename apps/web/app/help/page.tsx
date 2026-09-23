import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Help' };

const ARTICLES = [
  { q: 'When is my service ready?', a: 'After your payment is confirmed by our payment provider, we start provisioning. Your dashboard shows the real status: awaiting payment, paid, provisioning, active, delayed or needs attention. If something needs attention our team is notified automatically.' },
  { q: 'I paid but the order still says awaiting payment.', a: 'Returning to our site after paying is not treated as proof of payment. We wait for confirmation from the payment provider, which is usually quick. You can use “Check payment status” on the order page; if it stays unchanged, contact support with your order ID.' },
  { q: 'How are renewals charged?', a: 'Renewal prices and the full term charge are shown before checkout. Domain and other supplier terms follow the supplier’s registration period and may differ from monthly app subscriptions.' },
  { q: 'How do I add team members?', a: 'Owners and admins can invite teammates by email from the organisation page. Each person signs in with their own account; invitations only work for the email address they were sent to.' },
  { q: 'How do I get a GST invoice?', a: 'Add your legal name, GSTIN and billing state on the organisation page before purchasing. Invoices use the details on file at the time of purchase.' },
];

export default function Help() {
  return (
    <>
      <h1>Help</h1>
      <p className="lead">Answers to common questions. Can’t find what you need? Contact our support team with your order ID.</p>
      {ARTICLES.map((a) => (
        <details key={a.q} className="card" style={{ marginBottom: 12 }}>
          <summary><strong>{a.q}</strong></summary>
          <p>{a.a}</p>
        </details>
      ))}
    </>
  );
}
