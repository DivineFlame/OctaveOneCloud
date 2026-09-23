import { describe, expect, it } from 'vitest';
import { HttpAppAdapter, ReferenceAppAdapter } from '@ooc/integrations';
import { buildAdapterRegistry } from '../src/adapters';

describe('adapter registry', () => {
  it('builds HTTP adapters from env references and ignores those without a secret', () => {
    const r = buildAdapterRegistry({ NODE_ENV: 'development', APP_ADAPTER_CRM_URL: 'https://crm.internal', APP_ADAPTER_CRM_SECRET: 's', APP_ADAPTER_SUPPORT_URL: 'https://support.internal' });
    expect(r.get('app.crm')).toBeInstanceOf(HttpAppAdapter);
    expect(r.get('app.support')).toBeUndefined();
  });
  it('never registers reference adapters in production', () => {
    const r = buildAdapterRegistry({ NODE_ENV: 'production', OOC_ENABLE_REFERENCE_ADAPTERS: 'app.crm' });
    expect(r.get('app.crm')).toBeUndefined();
    const dev = buildAdapterRegistry({ NODE_ENV: 'development', OOC_ENABLE_REFERENCE_ADAPTERS: 'app.crm' });
    expect(dev.get('app.crm')).toBeInstanceOf(ReferenceAppAdapter);
  });
});
