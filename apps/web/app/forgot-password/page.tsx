'use client';

import { useState } from 'react';
import { api, describeError } from '@/lib/api';

export default function ForgotPassword() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api('/auth/password-reset/request', { method: 'POST', body: { email: String(new FormData(e.currentTarget).get('email')) } });
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    }
  }
  return (
    <>
      <h1>Reset your password</h1>
      {done ? (
        <p role="status">If an account exists for that address, we have emailed a reset link. It expires in one hour.</p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit">Send reset link</button>
        </form>
      )}
    </>
  );
}
