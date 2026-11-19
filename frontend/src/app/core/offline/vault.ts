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
  PBKDF2_ITERATIONS, createDataKeyWithRecovery, decryptJson, deriveKek, encryptJson, fromBase64, normalizeRecoveryCode, randomBytes,
  rewrapDataKey, toBase64, unwrapDataKey, unwrapWithRecovery, wrapDataKey, wrapForRecovery,
} from './crypto';
import { Cipher } from './types';
import { VAULT_SESSION_KEY, VaultHeader, patchVaultHeader, readVaultHeader, writeVaultHeader } from './vault-header';

export const PIN_MIN_LENGTH = 8;
/** A long enough phrase needs no digit: 14 characters or more are accepted as they are. */
export const PASSPHRASE_LENGTH = 14;
const FREE_ATTEMPTS = 5;

export interface VaultSession { access: string | null; refresh: string | null; me: Me; }

export class PinError extends Error {
  constructor(message: string, readonly lockedUntil = 0) { super(message); }
}

/** The recovery code was refused (wrong, malformed, or this device has none). The message is ready to display. */
export class RecoveryError extends Error {}

const COMMON = ['motdepasse', 'password', 'azerty', 'qwerty', 'wakara', 'ratoma', 'conakry', 'guinee', 'guinea', 'admin', 'bienvenue', 'soleil'];

/**
 * Why this code is not acceptable ('' when it is).
 * The code is the ONLY thing protecting the encrypted data of a stolen phone (the attempt counter lives on the
 * device and can be erased by whoever holds it): a code of digits only falls in minutes to a graphics card, so the
 * code must mix letters and digits (8 characters or more) or be a long phrase (14 characters or more).
 */
export function pinProblem(pin: string): string {
  if (pin.length < PIN_MIN_LENGTH) return `Le code doit contenir au moins ${PIN_MIN_LENGTH} caractères, avec des lettres et des chiffres.`;
  if (/^(.)\1+$/.test(pin)) return 'Ce code est trop simple (un seul caractère répété).';
  if ('01234567890123456789'.includes(pin) || '98765432109876543210'.includes(pin) || 'abcdefghijklmnopqrstuvwxyz'.includes(pin.toLowerCase())) return 'Ce code est trop simple (suite de caractères).';
  const lower = pin.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const letters = lower.replace(/[^a-z]/g, ''), digits = lower.replace(/\D/g, '');
  if (pin.length < PASSPHRASE_LENGTH && (!letters || !digits)) return 'Mélangez des lettres et des chiffres (par exemple : Fatou4827), ou choisissez une phrase de 14 caractères.';
  if (pin.length < PASSPHRASE_LENGTH && COMMON.some(w => lower.startsWith(w))) return 'Ce code est trop courant : évitez les mots usuels.';
  if (new Set(pin).size < 4) return 'Ce code est trop simple (trop peu de caractères différents).';
  return '';
}

function lockDelay(fails: number): number {
  return fails < FREE_ATTEMPTS ? 0 : Math.min(30, 2 ** (fails - FREE_ATTEMPTS)) * 60_000;
}

function wrappedOf(h: VaultHeader): Cipher {
  const ct = fromBase64(h.wrapped);
  return { iv: fromBase64(h.wrapIv), ct: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer };
}

/** The `rec` and `recPending` parts of a header for a freshly made recovery code (the agent never sees the code). */
async function recoveryFields(key: CryptoKey, r: { code: string; salt: Uint8Array; wrapped: { iv: Uint8Array; ct: ArrayBuffer } }): Promise<Pick<VaultHeader, 'rec' | 'recPending'>> {
  const sealed = await encryptJson(key, r.code);
  return {
    rec: { salt: toBase64(r.salt), iv: toBase64(r.wrapped.iv), wrapped: toBase64(r.wrapped.ct) },
    recPending: { iv: toBase64(sealed.iv), ct: toBase64(sealed.ct) },
  };
}

export async function createVault(pin: string, user: VaultHeader['user'], iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const salt = randomBytes(16);
  const { wrapped, key, recovery } = await createDataKeyWithRecovery(await deriveKek(pin, salt, iterations));
  writeVaultHeader({
    v: 1, user, salt: toBase64(salt), iterations, wrapIv: toBase64(wrapped.iv), wrapped: toBase64(wrapped.ct),
    fails: 0, lockedUntil: 0, createdAt: new Date().toISOString(), ...(await recoveryFields(key, recovery)),
  });
  return key;
}

/**
 * A vault made before the recovery code existed, or whose code the server lost: while the PIN is at hand a recovery
 * code is made (the data key is unwrapped as extractable for that moment only) and kept, encrypted, until the server has it.
 */
async function withRecovery(header: VaultHeader, pin: string, key: CryptoKey): Promise<VaultHeader> {
  if (header.rec && !header.recRenew) return header;
  try {
    const extractable = await unwrapDataKey(wrappedOf(header), await deriveKek(pin, fromBase64(header.salt), header.iterations), true);
    const { recRenew: _renew, ...rest } = header;
    return { ...rest, ...(await recoveryFields(key, await wrapForRecovery(extractable))) };
  } catch { return header; }   // the recovery code is a safety net: it never prevents an unlock
}

/** Opens the vault with the PIN. Throws PinError (wrong code, or too many attempts for now). */
export async function openVault(pin: string): Promise<CryptoKey> {
  const header = readVaultHeader();
  if (!header) throw new PinError("Aucune session protégée sur cet appareil.");
  if (header.lockedUntil > Date.now()) throw new PinError(lockedMessage(header.lockedUntil), header.lockedUntil);
  let key: CryptoKey;
  try {
    key = await unwrapDataKey(wrappedOf(header), await deriveKek(pin, fromBase64(header.salt), header.iterations));
  } catch {
    const fails = header.fails + 1;
    const delay = lockDelay(fails);
    const lockedUntil = delay ? Date.now() + delay : 0;
    writeVaultHeader({ ...header, fails, lockedUntil });
    if (lockedUntil) throw new PinError(lockedMessage(lockedUntil), lockedUntil);
    const left = FREE_ATTEMPTS - fails;
    throw new PinError(`Code incorrect. ${left} essai${left > 1 ? 's' : ''} avant le blocage temporaire.`);
  }
  const reset = { ...header, fails: 0, lockedUntil: 0 };
  const next = await withRecovery(reset, pin, key);
  if (next !== reset || header.fails || header.lockedUntil) writeVaultHeader(next);
  return key;
}

/**
 * The agent forgot the PIN: the recovery code given by the administrator opens the vault, a new PIN replaces the old
 * one and a NEW recovery code is made (the one the administrator read is of no use any more). Nothing stored on the
 * device is re-encrypted. Throws RecoveryError when the code is wrong.
 */
export async function recoverVault(rawCode: string, newPin: string, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const header = readVaultHeader();
  if (!header) throw new RecoveryError("Aucune session protégée sur cet appareil.");
  if (!header.rec) throw new RecoveryError("Cet appareil n'a pas de code de récupération : il ne peut pas être ouvert sans son code de verrouillage.");
  const code = normalizeRecoveryCode(rawCode);
  if (!code) throw new RecoveryError('Code de récupération invalide : il comporte 24 caractères (lettres et chiffres), par groupes de 4.');
  const rec = header.rec;
  let extractable: CryptoKey;
  try {
    const ct = fromBase64(rec.wrapped);
    extractable = await unwrapWithRecovery({ iv: fromBase64(rec.iv), ct: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer }, code, fromBase64(rec.salt));
  } catch { throw new RecoveryError("Ce code de récupération n'est pas le bon. Vérifiez-le auprès de l'administrateur (le code change à chaque fois qu'il est utilisé)."); }
  const salt = randomBytes(16);
  const kek = await deriveKek(newPin, salt, iterations);
  const wrapped = await wrapDataKey(extractable, kek);
  const key = await unwrapDataKey(wrapped, kek);
  const { recRenew: _renew, ...rest } = header;
  writeVaultHeader({
    ...rest, iterations, salt: toBase64(salt), wrapIv: toBase64(wrapped.iv), wrapped: toBase64(wrapped.ct), fails: 0, lockedUntil: 0,
    ...(await recoveryFields(key, await wrapForRecovery(extractable))),
  });
  return key;
}

/** The recovery code waiting for the server (decrypted with the data key), or null. */
export async function pendingRecoveryCode(key: CryptoKey): Promise<string | null> {
  const p = readVaultHeader()?.recPending;
  if (!p) return null;
  try {
    const ct = fromBase64(p.ct);
    return await decryptJson<string>(key, { iv: fromBase64(p.iv), ct: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer });
  } catch { return null; }
}

/** The server confirmed it holds the code: nothing waits any more. */
export function recoveryRegistered() { patchVaultHeader(({ recPending: _p, recRenew: _r, ...h }) => h); }

/** The server holds no readable code (and none is waiting): a new one is made at the next unlock. */
export function recoveryMissing() { patchVaultHeader(h => h.recPending || h.recRenew ? h : { ...h, recRenew: true }); }

export function lockedMessage(until: number): string {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Trop de codes incorrects. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`;
}

/** New PIN for the same data: the data key is re-wrapped, nothing stored on the device is re-encrypted. */
export async function changeVaultPin(oldPin: string, newPin: string): Promise<void> {
  if (!readVaultHeader()) throw new PinError("Aucune session protégée sur cet appareil.");
  await openVault(oldPin);  // counts a wrong attempt like an unlock (and may add the recovery code)
  const header = readVaultHeader()!;
  const oldKek = await deriveKek(oldPin, fromBase64(header.salt), header.iterations);
  const salt = randomBytes(16);
  const iterations = Math.max(header.iterations, PBKDF2_ITERATIONS);   // a new code also brings the key derivation up to the current cost
  const wrapped = await rewrapDataKey(wrappedOf(header), oldKek, await deriveKek(newPin, salt, iterations));
  writeVaultHeader({ ...header, iterations, salt: toBase64(salt), wrapIv: toBase64(wrapped.iv), wrapped: toBase64(wrapped.ct), fails: 0, lockedUntil: 0 });
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

/** Sign-out: the saved session (tokens) is removed; the vault, the local data and the queue stay. */
export function clearVaultSession() { try { localStorage.removeItem(VAULT_SESSION_KEY); } catch { /* ignore */ } }
