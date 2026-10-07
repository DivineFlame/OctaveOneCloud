/**
 * OAuth connector definitions from environment variables (operator-configured, nothing hard-coded):
 *   CONNECTOR_<NAME>_AUTHORIZE_URL, CONNECTOR_<NAME>_TOKEN_URL   provider endpoints from the provider's docs
 *   CONNECTOR_<NAME>_CLIENT_ID, CONNECTOR_<NAME>_CLIENT_SECRET   OAuth client registered with the provider
 *   CONNECTOR_<NAME>_SCOPES                                      space-separated scopes requested
 *   CONNECTOR_<NAME>_APPS                                        comma-separated adapter keys allowed to use tokens
 *   CONNECTOR_<NAME>_LABEL (optional)                            name shown to customers
 *   CONNECTOR_<NAME>_EXTRA_AUTH_PARAMS (optional)                e.g. "access_type=offline&prompt=consent"
 */
export interface ConnectorDef {
  key: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  apps: string[];
  extraAuthParams: URLSearchParams;
}

export function loadConnectors(env: NodeJS.ProcessEnv = process.env, production = env.NODE_ENV === 'production'): Map<string, ConnectorDef> {
  const out = new Map<string, ConnectorDef>();
  for (const k of Object.keys(env)) {
    const m = /^CONNECTOR_([A-Z0-9_]+)_AUTHORIZE_URL$/.exec(k);
    if (!m) continue;
    const n = m[1]!;
    const get = (s: string) => env[`CONNECTOR_${n}_${s}`]?.trim() || undefined;
    const def = { authorizeUrl: get('AUTHORIZE_URL'), tokenUrl: get('TOKEN_URL'), clientId: get('CLIENT_ID'), clientSecret: get('CLIENT_SECRET'), scopes: get('SCOPES') };
    const missing = Object.entries(def).filter(([, v]) => !v).map(([f]) => f);
    if (missing.length) throw new Error(`Connector ${n} is missing ${missing.join(', ')}`);
    for (const u of [def.authorizeUrl!, def.tokenUrl!]) {
      if (production && !u.startsWith('https://')) throw new Error(`Connector ${n} endpoints must use https`);
    }
    out.set(n.toLowerCase(), {
      key: n.toLowerCase(),
      label: get('LABEL') ?? n.charAt(0) + n.slice(1).toLowerCase(),
      authorizeUrl: def.authorizeUrl!,
      tokenUrl: def.tokenUrl!,
      clientId: def.clientId!,
      clientSecret: def.clientSecret!,
      scopes: def.scopes!.split(/\s+/).filter(Boolean),
      apps: (get('APPS') ?? '').split(',').map((a) => a.trim()).filter(Boolean),
      extraAuthParams: new URLSearchParams(get('EXTRA_AUTH_PARAMS') ?? ''),
    });
  }
  return out;
}
