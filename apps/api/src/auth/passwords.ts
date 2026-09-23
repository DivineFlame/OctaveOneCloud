import * as argon2 from 'argon2';

export const PASSWORD_MIN = 12;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    // Equalise timing for unknown users.
    await argon2.hash(password, { type: argon2.argon2id }).catch(() => undefined);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
