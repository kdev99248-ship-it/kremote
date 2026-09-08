import { createHash, randomBytes, randomUUID } from 'node:crypto';

// ACCESS_KEYs are short-lived and one-time; a browser redeems one for a
// session token. DEVICE_KEYs are long-lived, stored hashed.

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function deviceKeyHash(deviceKey: string): string {
  return sha256('kremote:device:' + deviceKey);
}

export function accessKeyHash(accessKey: string): string {
  return sha256('kremote:access:' + accessKey);
}

export function sessionTokenHash(token: string): string {
  return sha256('kremote:session:' + token);
}

/** 32 hex chars. Agent stores the plaintext; relay stores only the hash. */
export function genDeviceKey(): string {
  return randomBytes(16).toString('hex');
}

/** Human-typeable, unambiguous alphabet (no 0/O/1/l/I). */
const ACCESS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function genAccessKey(len = 8): string {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += ACCESS_ALPHABET[b % ACCESS_ALPHABET.length];
  return s;
}

export function genSessionToken(): string {
  return randomUUID().replace(/-/g, '') + randomBytes(16).toString('hex');
}

/** Timing-safe-ish equality for hex digests (constant length). */
export function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
