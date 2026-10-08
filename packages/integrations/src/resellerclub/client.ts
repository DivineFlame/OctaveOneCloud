import { PrismaClient, Prisma } from '@ooc/db';
import { AppConfig, redact, redactUrl } from '@ooc/shared';

export class SupplierError extends Error {
  constructor(
    public readonly kind: 'disabled' | 'live_mutation_blocked' | 'validation' | 'business' | 'rate_limited' | 'insufficient_funds' | 'unknown_outcome' | 'http' | 'reconcile_required',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | (string | number)[] | undefined>;

export interface MutationOptions {
  /** Stable key for this business operation (e.g. `domain-register:<orderItemId>`). */
  operationKey: string;
  action: string;
  chargeable: boolean;
}

/**
 * ResellerClub HTTP API client.
 * - Credentials are sent as the documented auth-userid / api-key parameters and redacted everywhere.
 * - HTTP 200 is not treated as business success; error bodies are detected and classified.
 * - Every mutation is journaled in SupplierOperation. A timeout becomes `unknown` and must be
 *   reconciled against supplier records before any retry — chargeable calls are never blindly repeated.
 * - Live mutations require RESELLERCLUB_ENV=live AND RESELLERCLUB_ALLOW_LIVE_MUTATIONS=true.
 *   Demo credentials must be used for tests: the demo host does not protect against live credentials.
 */
export class ResellerClubClient {
  constructor(
    private readonly config: Pick<AppConfig, 'RESELLERCLUB_ENV' | 'RESELLERCLUB_BASE_URL' | 'RESELLERCLUB_AUTH_USERID' | 'RESELLERCLUB_API_KEY' | 'RESELLERCLUB_ALLOW_LIVE_MUTATIONS'>,
    private readonly db: PrismaClient,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  get enabled() {
    return this.config.RESELLERCLUB_ENV !== 'disabled';
  }

  private buildUrl(path: string, params: Params): URL {
    if (!this.enabled || !this.config.RESELLERCLUB_BASE_URL) throw new SupplierError('disabled', 'ResellerClub integration is disabled');
    const url = new URL(this.config.RESELLERCLUB_BASE_URL.replace(/\/$/, '') + path);
    if (url.protocol !== 'https:') throw new SupplierError('disabled', 'ResellerClub base URL must use https');
    url.searchParams.set('auth-userid', this.config.RESELLERCLUB_AUTH_USERID ?? '');
    url.searchParams.set('api-key', this.config.RESELLERCLUB_API_KEY ?? '');
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async send(method: 'GET' | 'POST', path: string, params: Params, timeoutMs = this.timeoutMs): Promise<unknown> {
    const url = this.buildUrl(path, params);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      throw new SupplierError('unknown_outcome', `No response from ResellerClub (${(e as Error).name})`, { url: redactUrl(url.toString()) });
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body kept as text */
    }
    if (res.status === 429) throw new SupplierError('rate_limited', 'ResellerClub rate limit', { status: res.status });
    if (res.status >= 500) throw new SupplierError('unknown_outcome', `ResellerClub HTTP ${res.status}`, { status: res.status });
    if (!res.ok) throw new SupplierError('http', `ResellerClub HTTP ${res.status}`, redact(body));
    classifyBusinessError(body);
    return body;
  }

  /** Read-only call; safe to retry. Large responses (price lists) may pass a longer timeout. */
  query(path: string, params: Params = {}, opts: { timeoutMs?: number } = {}) {
    return this.send('GET', path, params, opts.timeoutMs);
  }

  /** Reseller cost price — GET /products/reseller-cost-price.json (help article "Get Reseller Cost Pricing Details Using the API"). */
  resellerCostPrice() {
    return this.query('/products/reseller-cost-price.json', {}, { timeoutMs: 120_000 });
  }

  /** Generic customer (selling) price — GET /products/customer-price.json ("How to Fetch Customer Pricing Using the Products Pricing API"). */
  customerPrice(customerId?: number) {
    return this.query('/products/customer-price.json', { 'customer-id': customerId }, { timeoutMs: 120_000 });
  }

  get environment() {
    return this.config.RESELLERCLUB_ENV;
  }

  /** Journaled mutation with reconcile-before-retry semantics. */
  async mutate(path: string, params: Params, opts: MutationOptions): Promise<unknown> {
    if (this.config.RESELLERCLUB_ENV === 'live' && !this.config.RESELLERCLUB_ALLOW_LIVE_MUTATIONS) {
      throw new SupplierError('live_mutation_blocked', 'Live supplier mutations are not authorised (RESELLERCLUB_ALLOW_LIVE_MUTATIONS=false)');
    }
    const requestRedacted = redact({ path, params }) as Prisma.InputJsonValue;
    const existing = await this.db.supplierOperation.findUnique({ where: { operationKey: opts.operationKey } });
    if (existing) {
      if (existing.status === 'succeeded' || existing.status === 'reconciled') return existing.responseRedacted;
      if (existing.status === 'unknown' || existing.status === 'sent') {
        throw new SupplierError('reconcile_required', `Operation ${opts.operationKey} has an unknown outcome; reconcile with supplier records before retrying`);
      }
      if (existing.status === 'failed' && opts.chargeable) {
        throw new SupplierError('reconcile_required', `Chargeable operation ${opts.operationKey} previously failed; operator must confirm before retry`);
      }
    }
    const op = existing
      ? await this.db.supplierOperation.update({ where: { id: existing.id }, data: { status: 'sent', attempts: { increment: 1 } } })
      : await this.db.supplierOperation.create({
          data: { operationKey: opts.operationKey, provider: 'resellerclub', action: opts.action, chargeable: opts.chargeable, status: 'sent', attempts: 1, requestRedacted },
        });
    try {
      const body = await this.send('POST', path, params);
      await this.db.supplierOperation.update({ where: { id: op.id }, data: { status: 'succeeded', responseRedacted: redact(body) as Prisma.InputJsonValue } });
      return body;
    } catch (e) {
      const err = e as SupplierError;
      const status = err.kind === 'unknown_outcome' ? 'unknown' : 'failed';
      await this.db.supplierOperation.update({ where: { id: op.id }, data: { status, lastError: `${err.kind}: ${err.message}`.slice(0, 1000) } });
      throw e;
    }
  }

  /** Domain availability (read-only). Endpoint shape must be confirmed in docs/provider-capabilities.md before enabling. */
  checkDomainAvailability(domainNames: string[], tlds: string[]) {
    return this.query('/domains/available.json', { 'domain-name': domainNames, tlds });
  }
}

function classifyBusinessError(body: unknown) {
  if (!body || typeof body !== 'object') return;
  const b = body as Record<string, unknown>;
  const status = typeof b.status === 'string' ? b.status.toLowerCase() : undefined;
  if (status !== 'error' && status !== 'failed') return;
  const message = String(b.message ?? b.error ?? 'Supplier reported an error');
  if (/insufficient|balance|funds/i.test(message)) throw new SupplierError('insufficient_funds', message);
  if (/invalid|required|must/i.test(message)) throw new SupplierError('validation', message);
  throw new SupplierError('business', message);
}
