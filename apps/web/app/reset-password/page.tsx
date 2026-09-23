'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';

function Reset() {
  const token = useSearchParams().get('token');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) return setError('Passwords do not match.');
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password: String(f.get('password')) } });
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    }
  }
  if (!token) return <p className="error">This reset link is incomplete. <Link href="/forgot-password">Request a new one</Link>.</p>;
  if (done) return <p role="status">Your password has been changed and other sessions were signed out. <Link href="/login">Sign in</Link>.</p>;
  return (
    <form className="stack" onSubmit={submit}>
      <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} required aria-describedby="pw" /><span id="pw" className="hint">At least 12 characters.</span></label>
      <label>Confirm new password<input name="confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" type="submit">Set new password</button>
    </form>
  );
}

export default function Page() {
  return (<><h1>Choose a new password</h1><Suspense><Reset /></Suspense></>);
}
