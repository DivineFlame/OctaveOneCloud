'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<string>('Verifying…');
  useEffect(() => {
    if (!token) return setState('Missing verification token.');
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('Your email address is verified. You can close this page.'))
      .catch((e) => setState(describeError(e)));
  }, [token]);
  return <p role="status">{state}</p>;
}

export default function Page() {
  return (<><h1>Email verification</h1><Suspense><Verify /></Suspense></>);
}
