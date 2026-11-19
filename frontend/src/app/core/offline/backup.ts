/**
 * Emergency backup of what this device has not sent yet.
 *
 * A browser may erase its data without warning (« clear site data », low storage, iPhone after a week without use):
 * the unsent operations and photos would be lost with it. The backup is a file kept elsewhere (e-mail to oneself,
 * another phone, a computer). It holds the operations and photos AS THEY ARE STORED — still encrypted with the data
 * key — and the vault header that wraps that key under the PIN: restoring it brings the same data back, and only the
 * code chosen on the device opens it. The session (tokens) is never part of it: after a restore the user signs in again.
 */
import { Dexie } from 'dexie';
import { fromBase64, toBase64 } from './crypto';
import { OfflineDb, dbName } from './db';
import { Cipher, FileRow, OpRow } from './types';
import { VaultHeader, readVaultHeader, writeVaultHeader } from './vault-header';

const KIND = 'wakara-device-backup';

interface BackupCipher { iv: string; ct: string; }
interface BackupFile {
  kind: typeof KIND; v: 1; createdAt: string; header: VaultHeader;
  operations: (Omit<OpRow, 'enc' | 'seq'> & { enc: BackupCipher | null })[];
  files: (Omit<FileRow, 'meta' | 'data'> & { meta: BackupCipher; data: BackupCipher })[];
}

const out = (c: Cipher): BackupCipher => ({ iv: toBase64(c.iv), ct: toBase64(c.ct) });
const back = (c: BackupCipher): Cipher => {
  const bytes = fromBase64(c.ct);
  return { iv: fromBase64(c.iv), ct: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
};

export class BackupError extends Error {}

/** The operations not confirmed by the server and their photos, as a downloadable file. */
export async function exportBackup(db: OfflineDb): Promise<Blob> {
  const header = readVaultHeader();
  if (!header) throw new BackupError("Aucune session protégée sur cet appareil.");
  const rows = (await db.operations.orderBy('seq').toArray()).filter(o => o.status !== 'applied');
  const wanted = new Set(rows.map(r => r.fileId).filter((id): id is string => !!id));
  const files = (await db.files.toArray()).filter(f => wanted.has(f.id));
  const body: BackupFile = {
    kind: KIND, v: 1, createdAt: new Date().toISOString(), header,
    operations: rows.map(({ seq: _seq, enc, ...row }) => ({ ...row, status: row.status === 'sending' ? 'pending' : row.status, enc: enc ? out(enc) : null })),
    files: files.map(f => ({ ...f, meta: out(f.meta), data: out(f.data) })),
  };
  return new Blob([JSON.stringify(body)], { type: 'application/json' });
}

export function backupFileName(now = new Date()): string {
  return `wakara-sauvegarde-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.wkr`;
}

/**
 * Puts a backup back on a device that has no vault (data erased): the vault header and the stored operations and
 * photos are written again; the owner then signs in and unlocks with the code he chose on the original device.
 * Refused on a device that already holds a vault: its data key is not the one of the backup.
 */
export async function restoreBackup(text: string): Promise<VaultHeader> {
  let file: BackupFile;
  try { file = JSON.parse(text) as BackupFile; } catch { throw new BackupError("Ce fichier n'est pas une sauvegarde Wakara."); }
  if (file?.kind !== KIND || file.v !== 1 || !file.header?.user?.uuid || !Array.isArray(file.operations) || !Array.isArray(file.files)) {
    throw new BackupError("Ce fichier n'est pas une sauvegarde Wakara.");
  }
  if (readVaultHeader()) {
    throw new BackupError("Cet appareil est déjà protégé par un code : une sauvegarde ne se restaure que sur un appareil dont les données ont été effacées.");
  }
  const uuid = file.header.user.uuid;
  await Dexie.delete(dbName(uuid));
  const db = new OfflineDb(uuid);
  try {
    await db.open();
    for (const row of file.operations) await db.operations.add({ ...row, enc: row.enc ? back(row.enc) : null } as OpRow);
    for (const f of file.files) await db.files.put({ ...f, meta: back(f.meta), data: back(f.data) } as FileRow);
  } finally { db.close(); }
  // the recovery code of the original device may have been replaced since: the restored device makes a new one at its first unlock
  const { rec: _rec, recPending: _pending, recRenew: _renew, ...header } = file.header;
  writeVaultHeader({ ...header, fails: 0, lockedUntil: 0 });
  return file.header;
}
