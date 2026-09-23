import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OctaveOneCloud', template: '%s · OctaveOneCloud' },
  description: 'Business cloud subscriptions: domains, web infrastructure, business essentials, hosted apps and agentic bundles for Indian businesses.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site">
          <div className="container bar">
            <Link href="/" className="brand">OctaveOneCloud</Link>
            <nav className="primary" aria-label="Primary">
              <Link href="/pricing">Products &amp; pricing</Link>
              <Link href="/help">Help</Link>
              <Link href="/dashboard">Dashboard</Link>
            </nav>
          </div>
        </header>
        <main id="main" className="container">{children}</main>
        <footer className="site">
          <div className="container row" style={{ justifyContent: 'space-between' }}>
            <span>© {new Date().getFullYear()} OctaveOneCloud</span>
            <span>Prices are listed before GST. Taxes, renewal prices and the full term charge are shown before you pay.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
