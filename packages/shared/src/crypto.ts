import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token for sessions, invitations and one-time links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * AES-256-GCM envelope: "v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>".
 * The key id allows rotation: decrypt with any known key, encrypt with the current one.
 */
export class CredentialCipher {
  private readonly keys: Map<string, Buffer>;
  constructor(private readonly currentKeyId: string, keys: Record<string, string>) {
    this.keys = new Map(Object.entries(keys).map(([id, hex]) => [id, Buffer.from(hex, 'hex')]));
    const current = this.keys.get(currentKeyId);
    if (!current || current.length !== 32) throw new Error('Current credential encryption key must be 32 bytes');
  }

  encrypt(plaintext: string, aad = ''): { ciphertext: string; keyId: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentKeyId)!, iv);
    cipher.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ['v1', this.currentKeyId, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':'),
      keyId: this.currentKeyId,
    };
  }

  decrypt(envelope: string, aad = ''): string {
    const [version, keyId, iv, tag, data] = envelope.split(':');
    if (version !== 'v1' || !keyId || !iv || !tag || data === undefined) throw new Error('Malformed credential envelope');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown credential key id ${keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

// ── TOTP (RFC 6238, SHA-1, 30s, 6 digits) for operator MFA ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, timeMs = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return (bin % 1_000_000).toString().padStart(6, '0');
}

export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(totpCode(secretBase32, timeMs + w * 30_000));
    if (timingSafeEqual(expected, Buffer.from(code))) return true;
  }
  return false;
}

/** Canonical JSON (sorted keys) hashed with SHA-256; used to bind approvals to exact action inputs. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
