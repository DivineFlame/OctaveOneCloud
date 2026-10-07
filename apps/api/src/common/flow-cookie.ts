import type { Request, Response } from 'express';
import { CredentialCipher } from '@ooc/shared';

/**
 * Short-lived, encrypted and authenticated (AES-256-GCM) HttpOnly cookie for redirect flows (OIDC sign-in,
 * OAuth connectors): holds state, nonce and PKCE verifier between the redirect and the callback, so nothing
 * guessable or reusable is kept server-side. Bound to a purpose via the cipher's associated data.
 */
export class FlowCookie<T extends object> {
  constructor(
    private readonly name: string,
    private readonly purpose: string,
    private readonly cipher: CredentialCipher,
    private readonly secure: boolean,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  set(res: Response, value: T) {
    const enc = this.cipher.encrypt(JSON.stringify({ v: value, exp: Date.now() + this.ttlMs }), this.purpose);
    res.cookie(this.name, enc.ciphertext, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/', maxAge: this.ttlMs });
  }

  /** Reads and always clears the cookie (single use). Returns null if missing, tampered or expired. */
  take(req: Request, res: Response): T | null {
    const raw = (req.cookies as Record<string, string> | undefined)?.[this.name];
    res.clearCookie(this.name, { path: '/' });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(this.cipher.decrypt(raw, this.purpose)) as { v: T; exp: number };
      return parsed.exp > Date.now() ? parsed.v : null;
    } catch {
      return null;
    }
  }
}
