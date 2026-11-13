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

export function randomBytes(n: number): Uint8Array { return crypto.getRandomValues(new Uint8Array(n)); }

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
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKek(pin: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', text.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function wrapDataKey(key: CryptoKey, kek: CryptoKey): Promise<Cipher> {
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

export async function encryptBytes(key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<Cipher> {
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
