/**
 * Encryption of everything the offline mode keeps on the device (Web Crypto, nothing home-made).
 *
 *   PIN ──PBKDF2-SHA256──► key-encryption key ──AES-GCM wrap──► data key (random, AES-GCM 256)
 *
 * The data key encrypts operations, dossiers and photos. It only exists in memory, as a NON-extractable
 * CryptoKey, while the session is unlocked; the device stores it wrapped by the key derived from the PIN.
 * A wrong PIN fails the authenticated unwrap: there is nothing else to compare it with.
 */
import { Cipher } from './types';

export const PBKDF2_ITERATIONS = 600_000;
const text = new TextEncoder();
const untext = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Bytes { return crypto.getRandomValues(new Uint8Array(n)); }

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKek(pin: string, salt: Bytes, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', text.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export async function wrapDataKey(key: CryptoKey, kek: CryptoKey): Promise<Cipher> {
  const iv = randomBytes(12);
  return { iv, ct: await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv }) };
}

/** Throws when the PIN (hence the key-encryption key) is wrong. */
export function unwrapDataKey(wrapped: Cipher, kek: CryptoKey, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw', wrapped.ct, kek, { name: 'AES-GCM', iv: wrapped.iv }, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** A fresh data key, returned wrapped (to store) and usable (non-extractable, to keep in memory). */
export async function createDataKey(kek: CryptoKey): Promise<{ wrapped: Cipher; key: CryptoKey }> {
  const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapped = await wrapDataKey(extractable, kek);
  return { wrapped, key: await unwrapDataKey(wrapped, kek) };
}

/** Same data key under a new PIN: unwrapped as extractable for the time of the re-wrap only. */
export async function rewrapDataKey(wrapped: Cipher, oldKek: CryptoKey, newKek: CryptoKey): Promise<Cipher> {
  return wrapDataKey(await unwrapDataKey(wrapped, oldKek, true), newKek);
}

export async function encryptBytes(key: CryptoKey, data: ArrayBuffer | Bytes): Promise<Cipher> {
  const iv = randomBytes(12);
  return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data) };
}
export function decryptBytes(key: CryptoKey, c: Cipher): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.iv }, key, c.ct);
}
export function encryptJson(key: CryptoKey, value: unknown): Promise<Cipher> {
  return encryptBytes(key, text.encode(JSON.stringify(value ?? null)));
}
export async function decryptJson<T>(key: CryptoKey, c: Cipher): Promise<T> {
  return JSON.parse(untext.decode(await decryptBytes(key, c))) as T;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Recovery code ──
 * A second wrapping of the data key, under a random code (120 bits) that the agent never sees: the device gives it to
 * the server, where only the administrator can read it back (audited) to hand it to an agent who forgot the PIN.
 * The code is long and random, so a single HKDF step is enough to turn it into a key. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32: no I, L, O, U
export const RECOVERY_LENGTH = 24;

/** 24 random characters (120 bits), grouped by 4: `ABCD-EFGH-…`. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_LENGTH);
  let chars = '';
  for (const b of bytes) chars += RECOVERY_ALPHABET[b & 31];   // 256 is a multiple of 32: no bias
  return chars.match(/.{4}/g)!.join('-');
}

/** The code as it is stored (`ABCD-EFGH-…`), or '' when `raw` is not a valid recovery code. Same rules as the server. */
export function normalizeRecoveryCode(raw: string): string {
  const text = (raw ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (text.length !== RECOVERY_LENGTH || [...text].some(c => !RECOVERY_ALPHABET.includes(c))) return '';
  return text.match(/.{4}/g)!.join('-');
}

async function deriveRecoveryKek(code: string, salt: Bytes): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', text.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('wakara-recovery-v1') }, material,
    { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export interface RecoveryWrap { code: string; salt: Bytes; wrapped: Cipher; }

/** A new recovery code and the data key wrapped under it (`dataKey` must be extractable). */
export async function wrapForRecovery(dataKey: CryptoKey): Promise<RecoveryWrap> {
  const code = generateRecoveryCode();
  const salt = randomBytes(16);
  return { code, salt, wrapped: await wrapDataKey(dataKey, await deriveRecoveryKek(code, salt)) };
}

/** Throws when the code is not the one that wrapped the key. */
export async function unwrapWithRecovery(wrapped: Cipher, code: string, salt: Bytes): Promise<CryptoKey> {
  return unwrapDataKey(wrapped, await deriveRecoveryKek(code, salt), true);
}

/** A fresh data key: wrapped under the PIN, wrapped under a recovery code, and usable (non-extractable). */
export async function createDataKeyWithRecovery(kek: CryptoKey): Promise<{ wrapped: Cipher; key: CryptoKey; recovery: RecoveryWrap }> {
  const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapped = await wrapDataKey(extractable, kek);
  return { wrapped, key: await unwrapDataKey(wrapped, kek), recovery: await wrapForRecovery(extractable) };
}
