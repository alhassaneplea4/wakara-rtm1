/**
 * Header of the device vault, readable WITHOUT the PIN: who owns the offline data of this browser and how to
 * derive the key that opens them. Kept in localStorage so that the application knows, synchronously and at
 * start-up, that a PIN-protected session exists here. No personal data besides the agent's own name.
 */
export interface VaultHeader {
  v: 1;
  user: { uuid: string; username: string; name: string };
  salt: string; iterations: number; wrapIv: string; wrapped: string;
  fails: number; lockedUntil: number; createdAt: string;
  /** The data key wrapped a second time under a recovery code (see crypto.ts): the server holds the code, the agent never sees it. */
  rec?: { salt: string; iv: string; wrapped: string };
  /** The recovery code, encrypted with the data key, until the server has confirmed it holds it. */
  recPending?: { iv: string; ct: string };
  /** The server holds no readable code for this device: a new one is made at the next unlock. */
  recRenew?: boolean;
}

export const VAULT_KEY = 'wk_vault';
export const VAULT_SESSION_KEY = 'wk_vault_session';
export const DEVICE_KEY = 'wk_device_id';
export const SKIP_KEY = 'wk_offline_skip';

export function readVaultHeader(): VaultHeader | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    const header = raw ? (JSON.parse(raw) as VaultHeader) : null;
    return header && header.v === 1 && header.user?.uuid ? header : null;
  } catch { return null; }
}

export function writeVaultHeader(header: VaultHeader | null) {
  try {
    if (header) localStorage.setItem(VAULT_KEY, JSON.stringify(header));
    else { localStorage.removeItem(VAULT_KEY); localStorage.removeItem(VAULT_SESSION_KEY); }
  } catch { /* storage unavailable: the offline mode cannot be used on this browser */ }
}

/** Changes some fields of the header in place (nothing when there is no vault). */
export function patchVaultHeader(change: (h: VaultHeader) => VaultHeader) {
  const h = readVaultHeader();
  if (h) writeVaultHeader(change(h));
}

/** Offline mode needs IndexedDB, Web Crypto (secure context) and localStorage. */
export function offlineSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle && typeof localStorage !== 'undefined';
  } catch { return false; }
}

/** Identifier of this browser for the server (random, created once, survives a reset of the vault). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16));
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch { return '00000000-0000-4000-8000-000000000000'; }
}
