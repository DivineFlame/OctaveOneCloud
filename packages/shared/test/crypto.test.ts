import { describe, expect, it } from 'vitest';
import { CredentialCipher, base32Decode, base32Encode, canonicalHash, totpCode, verifyTotp } from '../src/crypto';

describe('credential cipher', () => {
  const k1 = 'a'.repeat(64);
  const k2 = 'b'.repeat(64);
  it('round-trips and supports rotation', () => {
    const old = new CredentialCipher('k1', { k1 });
    const env = old.encrypt('oauth-token', 'org-1');
    const rotated = new CredentialCipher('k2', { k1, k2 });
    expect(rotated.decrypt(env.ciphertext, 'org-1')).toBe('oauth-token');
    expect(rotated.encrypt('x').keyId).toBe('k2');
  });
  it('binds ciphertext to its tenant via AAD', () => {
    const c = new CredentialCipher('k1', { k1 });
    const env = c.encrypt('oauth-token', 'org-1');
    expect(() => c.decrypt(env.ciphertext, 'org-2')).toThrow();
  });
});

describe('totp', () => {
  it('matches RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238 T=59s -> 94287082 (8 digits); 6-digit truncation -> 287082
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });
});

describe('canonical hash', () => {
  it('is key-order independent and input sensitive', () => {
    expect(canonicalHash({ a: 1, b: [1, 2] })).toBe(canonicalHash({ b: [1, 2], a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
