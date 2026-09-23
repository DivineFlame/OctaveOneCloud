import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cashfree webhook signature (Payment Gateway and Subscriptions, per official docs reviewed 2026-09-23):
 *   signature = base64( HMAC-SHA256( secret, x-webhook-timestamp + rawBody ) )
 * The raw request bytes must be used unmodified. Timestamp tolerance is optional and
 * disabled unless configured, because the timestamp unit must be confirmed in sandbox.
 */
export interface VerifyCashfreeSignatureInput {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
}

export function computeCashfreeSignature(rawBody: Buffer, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody])).digest('base64');
}

export function verifyCashfreeSignature(input: VerifyCashfreeSignatureInput): boolean {
  const { rawBody, timestamp, signature, secret } = input;
  if (!secret || !timestamp || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = Buffer.from(computeCashfreeSignature(rawBody, timestamp, secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** HMAC used for OctaveOneCloud app-adapter callbacks (our own contract, not a provider scheme). */
export function signAdapterPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyAdapterPayload(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signAdapterPayload(secret, timestamp, body), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
