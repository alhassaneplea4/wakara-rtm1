import Dexie, { Table } from 'dexie';
import { FileRow, LogRow, OpRow, RecordRow } from './types';

/**
 * Local database of ONE agent on this browser (IndexedDB through Dexie). Contents are encrypted with the
 * data key of the vault; only what orders and counts the queue is stored in clear (see types.ts).
 */
export class OfflineDb extends Dexie {
  operations!: Table<OpRow, number>;
  declarations!: Table<RecordRow, string>;
  files!: Table<FileRow, string>;
  kv!: Table<{ key: string; value: any }, string>;
  log!: Table<LogRow, number>;

  constructor(userUuid: string) {
    super(dbName(userUuid));
    this.version(1).stores({
      operations: '++seq, &opId, entity, status',
      declarations: 'uuid',
      files: 'id, entity',
      kv: 'key',
      log: '++id',
    });
  }
}

export function dbName(userUuid: string) { return `wakara-offline-${userUuid}`; }

/** Operations the server has not confirmed yet — countable while the vault is locked. */
export const UNSYNCED = ['pending', 'sending', 'rejected', 'conflict'];

export async function countUnsynced(userUuid: string): Promise<{ waiting: number; problems: number }> {
  if (!(await Dexie.exists(dbName(userUuid)))) return { waiting: 0, problems: 0 };
  const db = new OfflineDb(userUuid);
  try {
    const waiting = await db.operations.where('status').anyOf('pending', 'sending').count();
    const problems = await db.operations.where('status').anyOf('rejected', 'conflict').count();
    return { waiting, problems };
  } finally { db.close(); }
}

export function deleteDb(userUuid: string): Promise<void> { return Dexie.delete(dbName(userUuid)); }
