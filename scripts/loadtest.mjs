#!/usr/bin/env node
/**
 * Small dependency-free load test for the launch gate "measured capacity".
 *
 *   node scripts/loadtest.mjs https://app.example.com [--duration 30] [--concurrency 20] [--login-email E]
 *
 * Scenarios (read-only, safe against production):
 *   home      GET /                         (Next.js page)
 *   pricing   GET /pricing                  (page + catalogue API via server)
 *   catalogue GET /api/v1/catalogue/products (public API through the web proxy)
 *   health    GET /api/health  → falls back to /api/v1/catalogue/products if not exposed
 *   login     POST /api/v1/auth/login with a wrong password at low concurrency (Argon2 cost; expects 401/429).
 *             Only with --login-email, and never against an account you care about: 10 failures lock it
 *             for 15 minutes (that is the protection working).
 *
 * Prints requests/s, p50/p95/p99 latency and error counts per scenario. Record the output (and server size)
 * in docs/evidence/load-test-YYYY-MM-DD.md. Run from a machine near the server; Dokploy monitoring shows CPU/RAM.
 */
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:3000').replace(/\/$/, '');
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const duration = Number(opt('duration', 20)) * 1000;
const concurrency = Number(opt('concurrency', 20));
const loginEmail = opt('login-email', null);

async function run(name, conc, makeRequest, okStatus) {
  const lat = [];
  const statuses = new Map();
  let errors = 0;
  const end = Date.now() + duration;
  const origin = new URL(base).origin;
  async function worker() {
    while (Date.now() < end) {
      const t = performance.now();
      try {
        const { url, init } = makeRequest();
        const res = await fetch(url, { ...init, headers: { origin, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
        await res.arrayBuffer();
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (!okStatus(res.status)) errors++;
      } catch {
        errors++;
        statuses.set('network', (statuses.get('network') ?? 0) + 1);
      }
      lat.push(performance.now() - t);
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const secs = (Date.now() - started) / 1000;
  lat.sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(0) : '-');
  return { scenario: name, concurrency: conc, requests: lat.length, rps: (lat.length / secs).toFixed(1), p50ms: p(0.5), p95ms: p(0.95), p99ms: p(0.99), errors, statuses: Object.fromEntries(statuses) };
}

const ok2xx = (s) => s >= 200 && s < 300;
const results = [];
results.push(await run('home', concurrency, () => ({ url: `${base}/` }), ok2xx));
results.push(await run('pricing', concurrency, () => ({ url: `${base}/pricing` }), ok2xx));
results.push(await run('catalogue', concurrency, () => ({ url: `${base}/api/v1/catalogue/products` }), ok2xx));
if (loginEmail) {
  results.push(
    await run('login(wrong pw)', Math.min(4, concurrency), () => ({
      url: `${base}/api/v1/auth/login`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: loginEmail, password: 'load-test-wrong-password' }) },
    }), (s) => s === 401 || s === 429),
  );
}
console.log(`Target ${base} · ${duration / 1000}s per scenario · ${new Date().toISOString()}`);
console.table(results);
