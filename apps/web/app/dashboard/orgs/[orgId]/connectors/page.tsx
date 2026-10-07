'use client';

import { Suspense, use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';

interface Provider { key: string; label: string; scopes: string[] }
interface Grant { id: string; provider: string; label: string; scopes: string[]; accountLabel: string | null; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; lastError: string | null }

const ERRORS: Record<string, string> = {
  expired: 'The connection attempt expired. Please try again.',
  access_denied: 'Access was not granted at the provider.',
  connector_token_failed: 'The provider did not issue access. Please try again or check the account.',
  insufficient_role: 'Only owners and admins can connect accounts.',
};

function Connectors({ orgId }: { orgId: string }) {
  const params = useSearchParams();
  const [data, setData] = useState<{ providers: Provider[]; grants: Grant[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ providers: Provider[]; grants: Grant[] }>(`/orgs/${orgId}/connectors`).then(setData).catch((e) => setError(describeError(e))), [orgId]);
  useEffect(() => void load(), [load]);

  async function connect(provider: string) {
    setError(null);
    try {
      const r = await api<{ authorizeUrl: string }>(`/orgs/${orgId}/connectors/${provider}/start`, { method: 'POST' });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function revoke(g: Grant) {
    if (!window.confirm(`Disconnect ${g.label}${g.accountLabel ? ` (${g.accountLabel})` : ''}? Apps will lose access immediately. Also remove the app's access in your ${g.label} account settings.`)) return;
    try {
      await api(`/orgs/${orgId}/connectors/grants/${g.id}/revoke`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  }

  const connected = params.get('connected');
  const failed = params.get('connector_error');
  const active = data?.grants.filter((g) => !g.revokedAt) ?? [];
  return (
    <>
      <p><Link href={`/dashboard/orgs/${orgId}`}>← Organisation</Link></p>
      <h1>Connected accounts</h1>
      <p className="muted">Connect accounts your apps and assistants may use on your behalf (for example to send email). Access tokens are stored encrypted and only released to the apps listed for each connection. Actions like sending messages still need your approval.</p>
      {connected && <p className="notice info" role="status">Connected {data?.providers.find((p) => p.key === connected)?.label ?? connected}.</p>}
      {failed && <p className="error" role="alert">{ERRORS[failed] ?? 'The connection did not complete.'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && data.providers.length === 0 && <p className="muted">No connections are available yet.</p>}
      <div className="stack-list">
        {data?.providers.map((p) => {
          const g = active.find((x) => x.provider === p.key);
          return (
            <section key={p.key} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{p.label}</h2>
                <span className={`badge ${g ? (g.lastError ? 'warn' : 'good') : ''}`}>{g ? (g.lastError ? 'Needs reconnecting' : 'Connected') : 'Not connected'}</span>
              </div>
              <p className="muted">Permissions requested: {p.scopes.join(', ')}</p>
              {g && <p className="muted">Connected {new Date(g.createdAt).toLocaleDateString('en-IN')}{g.accountLabel ? ` as ${g.accountLabel}` : ''}{g.lastUsedAt ? ` · last used ${new Date(g.lastUsedAt).toLocaleString('en-IN')}` : ''}</p>}
              <div className="row">
                <button type="button" className={g ? 'btn secondary' : 'btn'} onClick={() => connect(p.key)}>{g ? 'Reconnect' : 'Connect'}</button>
                {g && <button type="button" className="btn secondary" onClick={() => revoke(g)}>Disconnect</button>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  return (
    <Suspense>
      <Connectors orgId={orgId} />
    </Suspense>
  );
}
