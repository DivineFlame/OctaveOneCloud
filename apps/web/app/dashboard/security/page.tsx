'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { useMe } from '@/components/useMe';

export default function Security() {
  const { me, reload } = useMe();
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  async function begin() {
    try {
      const r = await api<{ otpauthUri: string }>('/auth/mfa/setup', { method: 'POST' });
      setUri(r.otpauthUri);
      setSecret(new URL(r.otpauthUri).searchParams.get('secret'));
    } catch (e) {
      setMsg({ text: describeError(e), error: true });
    }
  }

  async function enable(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api('/auth/mfa/enable', { method: 'POST', body: { code: String(new FormData(e.currentTarget).get('code')) } });
      setMsg({ text: 'Two-factor authentication is enabled.' });
      setSecret(null);
      reload();
    } catch (err) {
      setMsg({ text: describeError(err), error: true });
    }
  }

  if (!me) return <p aria-busy="true">Loading…</p>;
  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Security</h1>
      <h2>Two-factor authentication</h2>
      {me.mfaEnabled ? (
        <p><span className="badge good">Enabled</span></p>
      ) : !secret ? (
        <>
          <p className="muted">Use an authenticator app (TOTP). Required for operator accounts.</p>
          <button className="btn" onClick={begin}>Set up two-factor authentication</button>
        </>
      ) : (
        <form className="stack" onSubmit={enable}>
          <p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
          <p><code style={{ wordBreak: 'break-all' }}>{secret}</code></p>
          {uri && <p className="hint">Or open <a href={uri}>this setup link</a> on a device with an authenticator app.</p>}
          <label>Code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required /></label>
          <button className="btn" type="submit">Enable</button>
        </form>
      )}
      {msg && <p className={msg.error ? 'error' : 'muted'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
    </>
  );
}
