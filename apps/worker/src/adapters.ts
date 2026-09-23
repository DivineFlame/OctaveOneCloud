import { AdapterRegistry, HttpAppAdapter, ReferenceAppAdapter } from '@ooc/integrations';

/**
 * Builds the adapter registry from environment references:
 *   APP_ADAPTER_<NAME>_URL / APP_ADAPTER_<NAME>_SECRET  ->  adapter key "app.<name>"
 * The reference (mock) adapter is only available outside production and only when explicitly enabled.
 */
export function buildAdapterRegistry(env: NodeJS.ProcessEnv = process.env): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const [k, url] of Object.entries(env)) {
    const m = /^APP_ADAPTER_([A-Z0-9_]+)_URL$/.exec(k);
    if (!m || !url) continue;
    const secret = env[`APP_ADAPTER_${m[1]}_SECRET`];
    if (!secret) continue;
    registry.register(new HttpAppAdapter(`app.${m[1]!.toLowerCase()}`, url, secret));
  }
  if (env.NODE_ENV !== 'production' && env.OOC_ENABLE_REFERENCE_ADAPTERS) {
    for (const key of env.OOC_ENABLE_REFERENCE_ADAPTERS.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!registry.get(key)) registry.register(new ReferenceAppAdapter(key, env.NODE_ENV));
    }
  }
  return registry;
}
