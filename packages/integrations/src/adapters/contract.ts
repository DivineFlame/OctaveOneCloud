import { randomUUID } from 'node:crypto';
import { signAdapterPayload } from '@ooc/shared';

/**
 * Versioned contract between OctaveOneCloud and a hosted business app.
 * The app MUST enforce entitlements itself; hiding a portal button is not access control.
 */
export const ADAPTER_CONTRACT_VERSION = '2026-09';

export type AdapterOutcome = 'succeeded' | 'pending' | 'failed' | 'unknown';

export interface AdapterResult<T = Record<string, unknown>> {
  outcome: AdapterOutcome;
  /** Proof from the app (its tenant id, timestamps, request id). Required for `succeeded`. */
  evidence?: T;
  externalRef?: string;
  error?: string;
}

export interface AdapterRequestBase {
  orgId: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface EntitlementPayload {
  featureKey: string;
  limit: number | null;
}

export interface AppAdapter {
  readonly key: string;
  readonly contractVersion: string;
  provisionTenant(req: AdapterRequestBase & { planVersionId: string; entitlements: EntitlementPayload[]; configuration?: unknown }): Promise<AdapterResult>;
  grantEntitlements(req: AdapterRequestBase & { entitlements: EntitlementPayload[] }): Promise<AdapterResult>;
  changePlan(req: AdapterRequestBase & { planVersionId: string; entitlements: EntitlementPayload[] }): Promise<AdapterResult>;
  suspendAccess(req: AdapterRequestBase & { reason: string }): Promise<AdapterResult>;
  resumeAccess(req: AdapterRequestBase): Promise<AdapterResult>;
  getStatus(req: AdapterRequestBase): Promise<AdapterResult<{ state: string }>>;
  requestDeletion(req: AdapterRequestBase & { retentionDays: number }): Promise<AdapterResult>;
}

/**
 * HTTP implementation of the contract. Each request is signed:
 *   x-ooc-signature = hex(HMAC-SHA256(secret, `${timestamp}.${body}`))
 * with x-ooc-timestamp, x-ooc-idempotency-key, x-ooc-correlation-id and x-ooc-contract-version headers.
 * Network failures and 5xx responses are reported as `unknown` so callers reconcile via getStatus.
 */
export class HttpAppAdapter implements AppAdapter {
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  constructor(
    readonly key: string,
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+)(:\d+)?(\/|$)/.test(baseUrl)) {
      throw new Error('Adapter base URL must be https, or http on a private service hostname');
    }
  }

  private async call(operation: string, req: AdapterRequestBase): Promise<AdapterResult> {
    const body = JSON.stringify(req);
    const timestamp = Date.now().toString();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/ooc/${ADAPTER_CONTRACT_VERSION}/${operation}`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-ooc-timestamp': timestamp,
          'x-ooc-signature': signAdapterPayload(this.secret, timestamp, body),
          'x-ooc-idempotency-key': req.idempotencyKey,
          'x-ooc-correlation-id': req.correlationId,
          'x-ooc-contract-version': ADAPTER_CONTRACT_VERSION,
          'x-ooc-request-id': randomUUID(),
        },
        body,
      });
    } catch (e) {
      return { outcome: 'unknown', error: `no_response:${(e as Error).name}` };
    }
    if (res.status >= 500) return { outcome: 'unknown', error: `http_${res.status}` };
    let json: AdapterResult;
    try {
      json = (await res.json()) as AdapterResult;
    } catch {
      return { outcome: 'unknown', error: 'invalid_json' };
    }
    if (!res.ok) return { outcome: 'failed', error: json.error ?? `http_${res.status}` };
    if (json.outcome === 'succeeded' && !json.evidence) return { outcome: 'unknown', error: 'success_without_evidence' };
    return json;
  }

  provisionTenant(req: Parameters<AppAdapter['provisionTenant']>[0]) { return this.call('provisionTenant', req); }
  grantEntitlements(req: Parameters<AppAdapter['grantEntitlements']>[0]) { return this.call('grantEntitlements', req); }
  changePlan(req: Parameters<AppAdapter['changePlan']>[0]) { return this.call('changePlan', req); }
  suspendAccess(req: Parameters<AppAdapter['suspendAccess']>[0]) { return this.call('suspendAccess', req); }
  resumeAccess(req: AdapterRequestBase) { return this.call('resumeAccess', { ...req }); }
  getStatus(req: AdapterRequestBase) { return this.call('getStatus', { ...req }) as Promise<AdapterResult<{ state: string }>>; }
  requestDeletion(req: Parameters<AppAdapter['requestDeletion']>[0]) { return this.call('requestDeletion', req); }
}

/**
 * In-memory reference adapter for contract tests and local development ONLY.
 * It refuses to construct in production so a mock can never count as real fulfilment.
 */
export class ReferenceAppAdapter implements AppAdapter {
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  readonly tenants = new Map<string, { state: 'active' | 'suspended' | 'deletion_requested'; planVersionId: string; entitlements: EntitlementPayload[] }>();
  private readonly seen = new Map<string, AdapterResult>();
  failNext: AdapterOutcome | null = null;

  constructor(readonly key: string, nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') throw new Error('ReferenceAppAdapter is not permitted in production');
  }

  private once(key: string, fn: () => AdapterResult): Promise<AdapterResult> {
    if (this.failNext) {
      const outcome = this.failNext;
      this.failNext = null;
      return Promise.resolve({ outcome, error: 'injected' });
    }
    const prior = this.seen.get(key);
    if (prior) return Promise.resolve(prior);
    const r = fn();
    this.seen.set(key, r);
    return Promise.resolve(r);
  }

  provisionTenant(req: Parameters<AppAdapter['provisionTenant']>[0]) {
    return this.once(req.idempotencyKey, () => {
      this.tenants.set(req.orgId, { state: 'active', planVersionId: req.planVersionId, entitlements: req.entitlements });
      return { outcome: 'succeeded', externalRef: `ref-${req.orgId}`, evidence: { tenantId: `ref-${req.orgId}`, at: new Date().toISOString() } };
    });
  }
  grantEntitlements(req: Parameters<AppAdapter['grantEntitlements']>[0]) {
    return this.once(req.idempotencyKey, () => {
      const t = this.tenants.get(req.orgId);
      if (!t) return { outcome: 'failed', error: 'tenant_not_found' };
      t.entitlements = req.entitlements;
      return { outcome: 'succeeded', evidence: { count: req.entitlements.length } };
    });
  }
  changePlan(req: Parameters<AppAdapter['changePlan']>[0]) {
    return this.once(req.idempotencyKey, () => {
      const t = this.tenants.get(req.orgId);
      if (!t) return { outcome: 'failed', error: 'tenant_not_found' };
      Object.assign(t, { planVersionId: req.planVersionId, entitlements: req.entitlements });
      return { outcome: 'succeeded', evidence: { planVersionId: req.planVersionId } };
    });
  }
  suspendAccess(req: Parameters<AppAdapter['suspendAccess']>[0]) {
    return this.once(req.idempotencyKey, () => this.setState(req.orgId, 'suspended'));
  }
  resumeAccess(req: AdapterRequestBase) {
    return this.once(req.idempotencyKey, () => this.setState(req.orgId, 'active'));
  }
  getStatus(req: AdapterRequestBase) {
    const t = this.tenants.get(req.orgId);
    return Promise.resolve(t ? { outcome: 'succeeded' as const, evidence: { state: t.state } } : { outcome: 'failed' as const, error: 'tenant_not_found' });
  }
  requestDeletion(req: Parameters<AppAdapter['requestDeletion']>[0]) {
    return this.once(req.idempotencyKey, () => this.setState(req.orgId, 'deletion_requested'));
  }
  private setState(orgId: string, state: 'active' | 'suspended' | 'deletion_requested'): AdapterResult {
    const t = this.tenants.get(orgId);
    if (!t) return { outcome: 'failed', error: 'tenant_not_found' };
    t.state = state;
    return { outcome: 'succeeded', evidence: { state } };
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AppAdapter>();
  register(adapter: AppAdapter) {
    this.adapters.set(adapter.key, adapter);
    return this;
  }
  get(key: string): AppAdapter | undefined {
    return this.adapters.get(key);
  }
}
