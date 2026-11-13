import { DeclarationDetail, DeclarationListItem, SupportingDocument } from '../models';

/** Where a dossier stands between this device and the server (shown next to every declaration). */
export type SyncState = 'synced' | 'local' | 'pending' | 'sending' | 'error' | 'conflict';

export const SYNC_LABELS: Record<SyncState, string> = {
  synced: 'En ligne', local: 'Sur cet appareil', pending: 'Modifications à envoyer', sending: 'Envoi en cours',
  error: 'Refusée par le serveur', conflict: 'Conflit à résoudre',
};
export const SYNC_HELP: Record<SyncState, string> = {
  synced: 'Ce dossier est enregistré sur le serveur.',
  local: "Ce dossier n'existe que sur cet appareil. Il sera envoyé au serveur dès le retour de la connexion.",
  pending: 'Des modifications faites sur cet appareil ne sont pas encore envoyées au serveur.',
  sending: 'Envoi au serveur en cours…',
  error: 'Le serveur a refusé une opération de ce dossier. Corrigez-le puis synchronisez de nouveau.',
  conflict: 'Ce dossier a changé sur le serveur pendant que vous travailliez hors connexion.',
};

export type OpType = 'declaration.create' | 'declaration.update' | 'declaration.transmit' | 'document.upload';
export type OpStatus = 'pending' | 'sending' | 'applied' | 'rejected' | 'conflict';

export const OP_LABELS: Record<OpType, string> = {
  'declaration.create': 'Création de la déclaration', 'declaration.update': 'Modification',
  'declaration.transmit': 'Transmission au secrétariat', 'document.upload': "Ajout d'une photo ou d'une pièce",
};
export const OP_STATUS_LABELS: Record<OpStatus, string> = {
  pending: 'En attente', sending: 'Envoi en cours', applied: 'Envoyée', rejected: 'Refusée', conflict: 'Conflit',
};

/** AES-GCM output as stored in IndexedDB (binary, never base64). */
export interface Cipher { iv: Uint8Array; ct: ArrayBuffer; }

/** One queued operation. Only what is needed to order and count the queue is readable without the key. */
export interface OpRow {
  seq?: number; opId: string; entity: string; type: OpType; status: OpStatus; attempts: number;
  deviceTime: string; createdAt: string; updatedAt: string; appliedAt?: string | null;
  fileId?: string | null; baseVersion?: number | null; errorCode?: string;
  /** encrypted OpSecret */
  enc: Cipher | null;
}
export interface OpError { code?: string; detail?: string; fields?: unknown; }
export interface OpSecret { payload?: Record<string, any>; error?: OpError | null; }
export interface Op extends Omit<OpRow, 'enc' | 'seq'>, OpSecret { seq: number; }

export interface RecordRow { uuid: string; onServer: 0 | 1; updatedAt: string; enc: Cipher; }
export interface FileRow { id: string; entity: string; kind: string; size: number; createdAt: string; meta: Cipher; data: Cipher; }
export interface FileMeta { name: string; mime: string; sha256: string; }
export interface LogRow { id?: number; at: string; kind: 'push' | 'pull' | 'error' | 'info'; message: string; }

export interface HospitalRef { uuid: string; code: string; name: string; }
export interface SyncRules { required_for_transmission: string[]; max_upload_size: number; max_batch: number; }
export const DEFAULT_RULES: SyncRules = {
  required_for_transmission: ['birth_date', 'birth_time', 'birth_place', 'child.gender'], max_upload_size: 4 * 1024 * 1024, max_batch: 20,
};

export interface SyncInfo { sync_state: SyncState; sync_error?: OpError | null; }
export type LocalDeclaration = DeclarationDetail & SyncInfo & { sync_version?: number; is_archived?: boolean };
export type LocalListItem = DeclarationListItem & SyncInfo;
export type LocalDocument = SupportingDocument & { sync_state?: SyncState };

/** Answer of the server for one pushed operation (see backend sync.services). */
export interface PushResult {
  op_id: string; type: OpType; status: 'applied' | 'duplicate' | 'rejected' | 'conflict' | 'skipped';
  entity_uuid: string; date_anomaly: string; error: OpError | null;
  declaration: LocalDeclaration | null; document?: unknown;
}

/** One line of the synchronisation screen. */
export interface OpView {
  seq: number; opId: string; entity: string; type: OpType; status: OpStatus; attempts: number; deviceTime: string;
  updatedAt: string; appliedAt?: string | null; error: string; errorCode: string; reference: string; childName: string;
  fileName: string;
}
