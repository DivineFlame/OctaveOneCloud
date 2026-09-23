'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { useMe } from '@/components/useMe';

function Accept() {
  const token = useSearchParams().get('token');
  const { me } = useMe();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    try {
      const m = await api<{ orgId: string }>('/orgs/invitations/accept', { method: 'POST', body: { token } });
      router.push(`/dashboard/orgs/${m.orgId}`);
    } catch (e) {
      setError(describeError(e));
    }
  }
  if (!me) return <p aria-busy="true">Loading…</p>;
  return (
    <>
      <p>You are signed in as <strong>{me.email}</strong>. Invitations can only be accepted by the address they were sent to.</p>
      <button className="btn" onClick={accept} disabled={!token}>Accept invitation</button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

export default function Page() {
  return (<><h1>Join organisation</h1><Suspense><Accept /></Suspense></>);
}
