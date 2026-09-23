'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (needsMfa) {
        await api('/auth/mfa/verify', { method: 'POST', body: { code: String(form.get('code')) } });
      } else {
        const body = { email: String(form.get('email')), password: String(form.get('password')) };
        if (mode === 'register') await api('/auth/register', { method: 'POST', body: { ...body, name: String(form.get('name') || '') || undefined } });
        const r = await api<{ mfaRequired: boolean }>('/auth/login', { method: 'POST', body });
        if (r.mfaRequired) {
          setNeedsMfa(true);
          return;
        }
      }
      const next = params.get('next');
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate={false}>
      {needsMfa ? (
        <label>
          Authentication code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required aria-describedby="code-hint" />
          <span id="code-hint" className="hint">Enter the 6-digit code from your authenticator app.</span>
        </label>
      ) : (
        <>
          {mode === 'register' && (
            <label>
              Your name <span className="hint">(optional)</span>
              <input name="name" autoComplete="name" maxLength={120} />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} required aria-describedby="pw-hint" />
            {mode === 'register' && <span id="pw-hint" className="hint">At least 12 characters.</span>}
          </label>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Please wait…' : needsMfa ? 'Verify' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <p className="muted">
        {mode === 'login' ? <>New here? <Link href="/register">Create an account</Link> · <Link href="/forgot-password">Forgot password?</Link></> : <>Already have an account? <Link href="/login">Sign in</Link></>}
      </p>
    </form>
  );
}
