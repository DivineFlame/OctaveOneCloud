import path from 'node:path';
import type { NextConfig } from 'next';

// The browser talks only to this origin; /api/* is proxied to the private API service, so session
// cookies stay first-party and the API never needs to be exposed on a separate public origin.
const apiInternal = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const dev = process.env.NODE_ENV !== 'production';

// Content-Security-Policy: only this origin, plus Cashfree's hosted-checkout SDK and its endpoints.
// Next.js emits inline bootstrap scripts, so script-src needs 'unsafe-inline' (no third-party inline code is used).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://sdk.cashfree.com${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.cashfree.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.cashfree.com" + (dev ? ' ws: http://localhost:*' : ''),
  'frame-src https://*.cashfree.com',
  "form-action 'self' https://*.cashfree.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Ignored by browsers over plain HTTP (IP:port trial); enforced once the site is on HTTPS.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  // Monorepo root so the standalone server bundles workspace dependencies correctly.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternal}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
