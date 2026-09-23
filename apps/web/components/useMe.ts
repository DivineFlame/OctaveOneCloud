'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';

export interface Me {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  operatorRole: string | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  organizations: { id: string; name: string; slug: string; role: string }[];
}

/** Loads the current user; redirects to sign-in when the session is missing. */
export function useMe() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      });
  }, [router, reloadKey]);
  return { me, reload: () => setReloadKey((k) => k + 1) };
}
