/** Redaction for logs, traces and stored request journals. */
const SENSITIVE_KEY = /(api[-_]?key|auth[-_]?userid|password|passwd|secret|token|authorization|cookie|x-client-secret|x-client-id|signature|otp|cvv|card)/i;
export const REDACTED = '[REDACTED]';

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) u.searchParams.set(key, REDACTED);
    }
    return u.toString();
  } catch {
    return url.replace(/([?&])([^=&]+)=([^&]*)/g, (m, sep: string, k: string) => (SENSITIVE_KEY.test(k) ? `${sep}${k}=${REDACTED}` : m));
  }
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') return (/^https?:\/\//.test(value) ? redactUrl(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
