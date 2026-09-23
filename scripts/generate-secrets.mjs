#!/usr/bin/env node
// Prints fresh random secrets for a new environment. Hex only, so they are safe inside connection URLs.
import { randomBytes } from 'node:crypto';
const hex = (n) => randomBytes(n).toString('hex');
process.stdout.write(
  [
    `POSTGRES_PASSWORD=${hex(24)}`,
    `REDIS_PASSWORD=${hex(24)}`,
    `CREDENTIAL_ENCRYPTION_KEY=${hex(32)}`,
    'CREDENTIAL_ENCRYPTION_KEY_ID=k1',
    '',
  ].join('\n'),
);
