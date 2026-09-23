'use client';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: { error?: string; message?: string; blockers?: string[]; issues?: { path: string; message: string }[] }) {
    super(body?.message ?? body?.error ?? `Request failed (${status})`);
  }
}

/** Same-origin API call through the Next.js /api proxy; the session cookie is httpOnly. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data ?? {});
  return data as T;
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.body.issues?.length) return e.body.issues.map((i) => `${i.path || 'input'}: ${i.message}`).join('; ');
    const map: Record<string, string> = {
      invalid_credentials: 'Email or password is incorrect.',
      email_in_use: 'An account with this email already exists.',
      authentication_required: 'Please sign in to continue.',
      billing_details_required: 'Add your organisation’s billing state before requesting a quote.',
      payments_unavailable: 'Online payment is not available yet. Please contact support.',
      product_not_available: 'This product is not available for purchase right now.',
      mixed_terms_require_separate_checkout: 'Items with different billing terms must be purchased separately.',
      quote_expired: 'This quote has expired. Please request a new one.',
    };
    return map[e.body.error ?? ''] ?? e.message;
  }
  return 'Something went wrong. Please try again.';
}
