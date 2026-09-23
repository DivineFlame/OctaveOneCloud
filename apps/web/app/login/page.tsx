import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function Login() {
  return (
    <>
      <h1>Sign in</h1>
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </>
  );
}
