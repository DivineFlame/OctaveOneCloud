import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Create account' };

export default function Register() {
  return (
    <>
      <h1>Create your account</h1>
      <p className="lead">After signing up, create an organisation for your business and invite your team.</p>
      <Suspense>
        <AuthForm mode="register" />
      </Suspense>
    </>
  );
}
