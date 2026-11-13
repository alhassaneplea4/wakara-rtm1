/**
 * The device vault: the PIN that protects the offline data of one agent on one browser.
 *
 * - `createVault` / `openVault` give the data key (see crypto.ts) — the only way to read what is stored.
 * - The session (tokens + profile) is kept encrypted with that key, so reopening the application without
 *   connection asks for the PIN and nothing else.
 * - Wrong PINs are counted in the header: after 5 failures the vault refuses new attempts for a while
 *   (1, 2, 4… up to 30 minutes). This slows a casual guess; the real protection is the key derivation.
 */
import { Me } from '../models';
import {
  PBKDF2_ITERATIONS, createDataKey, decryptJson, deriveKek, encryptJson, fromBase64, randomBytes, rewrapDataKey, toBase64, unwrapDataKey,
} from './crypto';
import { Cipher } from './types';
import { VAULT_SESSION_KEY, VaultHeader, readVaultHeader, writeVaultHeader } from './vault-header';

export const PIN_MIN_LENGTH = 6;
const FREE_ATTEMPTS = 5;

export interface VaultSession { access: string | null; refresh: string | null; me: Me; }

export class PinError extends Error {
  constructor(message: string, readonly lockedUntil = 0) { super(message); }
}

/** Why this PIN is not acceptable ('' when it is). */
export function pinProblem(pin: string): string {
  if (pin.length < PIN_MIN_LENGTH) return `Le code doit contenir au moins ${PIN_MIN_LENGTH} caractères.`;
  if (/^(.)\1+$/.test(pin)) return 'Ce code est trop simple (un seul caractère répété).';
  if ('01234567890123456789'.includes(pin) || '98765432109876543210'.includes(pin)) return 'Ce code est trop simple (suite de chiffres).';
  return '';
}

function lockDelay(fails: number): number {
  return fails < FREE_ATTEMPTS ? 0 : Math.min(30, 2 ** (fails - FREE_ATTEMPTS)) * 60_000;
}

function wrappedOf(h: VaultHeader): Cipher {
  const ct = fromBase64(h.wrapped);
  return { iv: fromBase64(h.wrapIv), ct: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer };
}

export async function createVault(pin: string, user: VaultHeader['user'], iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const salt = randomBytes(16);
  const { wrapped, key } = await createDataKey(await deriveKek(pin, salt, iterations));
  writeVaultHeader({
    v: 1, user, salt: toBase64(salt), iterations, wrapIv: toBase64(wrapped.iv), wrapped: toBase64(wrapped.ct),
    fails: 0, lockedUntil: 0, createdAt: new Date().toISOString(),
  });
  return key;
}

/** Opens the vault with the PIN. Throws PinError (wrong code, or too many attempts for now). */
export async function openVault(pin: string): Promise<CryptoKey> {
  const header = readVaultHeader();
  if (!header) throw new PinError("Aucune session protégée sur cet appareil.");
  if (header.lockedUntil > Date.now()) throw new PinError(lockedMessage(header.lockedUntil), header.lockedUntil);
  try {
    const key = await unwrapDataKey(wrappedOf(header), await deriveKek(pin, fromBase64(header.salt), header.iterations));
    if (header.fails || header.lockedUntil) writeVaultHeader({ ...header, fails: 0, lockedUntil: 0 });
    return key;
  } catch {
    const fails = header.fails + 1;
    const delay = lockDelay(fails);
    const lockedUntil = delay ? Date.now() + delay : 0;
    writeVaultHeader({ ...header, fails, lockedUntil });
    if (lockedUntil) throw new PinError(lockedMessage(lockedUntil), lockedUntil);
    const left = FREE_ATTEMPTS - fails;
    throw new PinError(`Code incorrect. ${left} essai${left > 1 ? 's' : ''} avant le blocage temporaire.`);
  }
}

export function lockedMessage(until: number): string {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Trop de codes incorrects. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`;
}

/** New PIN for the same data: the data key is re-wrapped, nothing stored on the device is re-encrypted. */
export async function changeVaultPin(oldPin: string, newPin: string): Promise<void> {
  const header = readVaultHeader();
  if (!header) throw new PinError("Aucune session protégée sur cet appareil.");
  await openVault(oldPin);  // counts a wrong attempt like an unlock
  const oldKek = await deriveKek(oldPin, fromBase64(header.salt), header.iterations);
  const salt = randomBytes(16);
  const wrapped = await rewrapDataKey(wrappedOf(header), oldKek, await deriveKek(newPin, salt, header.iterations));
  writeVaultHeader({ ...header, salt: toBase64(salt), wrapIv: toBase64(wrapped.iv), wrapped: toBase64(wrapped.ct), fails: 0, lockedUntil: 0 });
}

export async function saveVaultSession(key: CryptoKey, session: VaultSession): Promise<void> {
  const c = await encryptJson(key, session);
  try { localStorage.setItem(VAULT_SESSION_KEY, JSON.stringify({ iv: toBase64(c.iv), ct: toBase64(c.ct) })); } catch { /* ignore */ }
}

export async function loadVaultSession(key: CryptoKey): Promise<VaultSession | null> {
  try {
    const raw = localStorage.getItem(VAULT_SESSION_KEY);
    if (!raw) return null;
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const bytes = fromBase64(ct);
    return await decryptJson<VaultSession>(key, { iv: fromBase64(iv), ct: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  } catch { return null; }
}

export function destroyVault() { writeVaultHeader(null); }
