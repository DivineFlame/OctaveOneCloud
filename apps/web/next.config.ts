import path from 'node:path';
import type { NextConfig } from 'next';

// The browser talks only to this origin; /api/* is proxied to the private API service, so session
// cookies stay first-party and the API never needs to be exposed on a separate public origin.
const apiInternal = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const securityHeaders = [
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
