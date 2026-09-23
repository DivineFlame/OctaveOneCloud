'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { useMe } from '@/components/useMe';

export default function Dashboard() {
  const { me, reload } = useMe();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function createOrg(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name'));
    try {
      const org = await api<{ id: string }>('/orgs', { method: 'POST', body: { name } });
      router.push(`/dashboard/orgs/${org.id}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.push('/');
  }

  if (!me) return <p aria-busy="true">Loading…</p>;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Welcome{me.name ? `, ${me.name}` : ''}</h1>
        <div className="row"><Link className="btn secondary" href="/dashboard/security">Security</Link><button className="btn secondary" onClick={logout}>Sign out</button></div>
      </div>
      {!me.emailVerified && <div className="notice" role="status">Please verify your email address using the link we sent you.</div>}
      {me.operatorRole && (
        <div className="notice info">
          Operator account. <Link href="/admin">Open the operations console</Link>{!me.mfaEnabled && ' — two-factor authentication must be enabled first.'}
        </div>
      )}
      <h2>Your organisations</h2>
      {me.organizations.length === 0 && <p className="muted">You are not a member of any organisation yet.</p>}
      <div className="grid">
        {me.organizations.map((o) => (
          <Link key={o.id} href={`/dashboard/orgs/${o.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h3>{o.name}</h3>
            <p>Role: {o.role}</p>
          </Link>
        ))}
      </div>
      <h2>Create an organisation</h2>
      <form className="stack" onSubmit={createOrg}>
        <label>
          Organisation name
          <input name="name" required minLength={2} maxLength={120} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn" type="submit">Create</button>
      </form>
      <p style={{ marginTop: 24 }}><button className="btn secondary" onClick={reload}>Refresh</button></p>
    </>
  );
}
