import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verifyAdapterPayload } from '@ooc/shared';
import { AuthedRequest } from '../auth/decorators';

export type AppRequest = AuthedRequest & { appKey?: string };

const MAX_SKEW_S = 300;

/** Secrets per adapter key from APP_ADAPTER_<NAME>_SECRET (adapter key "app.<name>"), same as outbound calls. */
export function adapterSecrets(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    const m = /^APP_ADAPTER_([A-Z0-9_]+)_SECRET$/.exec(k);
    if (m && v && v.length >= 32) out.set(`app.${m[1]!.toLowerCase()}`, v);
  }
  return out;
}

/**
 * Authenticates hosted apps calling OctaveOneCloud:
 *   x-ooc-app: app.<name>
 *   x-ooc-timestamp: unix seconds (±5 minutes)
 *   x-ooc-signature: hex(HMAC-SHA256(APP_ADAPTER_<NAME>_SECRET, "<timestamp>.<raw body>"))
 * Only POST with a JSON body is accepted, so every request is covered by the signature.
 */
@Injectable()
export class AppSignatureGuard implements CanActivate {
  private readonly secrets = adapterSecrets();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const app = String(req.headers['x-ooc-app'] ?? '');
    const ts = String(req.headers['x-ooc-timestamp'] ?? '');
    const sig = String(req.headers['x-ooc-signature'] ?? '');
    const secret = this.secrets.get(app);
    const raw = req.rawBody;
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (req.method !== 'POST' || !secret || !raw || !/^\d{10}$/.test(ts) || !(skew <= MAX_SKEW_S) || !verifyAdapterPayload(secret, ts, raw.toString('utf8'), sig)) {
      throw new UnauthorizedException({ error: 'invalid_app_signature' });
    }
    req.appKey = app;
    return true;
  }
}
