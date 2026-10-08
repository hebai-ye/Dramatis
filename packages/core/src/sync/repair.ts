import type { LocalSyncRecord } from './types.js';

/** Tombstones are different versions even when updatedAt ties (legacy writers). */
export function syncVersionKey(record: Pick<LocalSyncRecord, 'collection' | 'id' | 'updatedAt' | 'deletedAt'>): string {
  return JSON.stringify([record.collection, record.id, record.updatedAt, record.deletedAt !== null]);
}

export interface SyncRepairScope {
  spaceHandle: string;
  epoch: string | null;
}

export interface SyncRepairMarker extends SyncRepairScope {
  version: 1;
  collection: LocalSyncRecord['collection'];
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** CAS token: a new observation must not be cleared by an older request. */
  token: string;
}

export function syncRepairPrefix(scope: SyncRepairScope): string {
  return `sync.repair.v1:${JSON.stringify([scope.spaceHandle, scope.epoch])}:`;
}

export function syncRepairKey(scope: SyncRepairScope, record: Pick<LocalSyncRecord, 'collection' | 'id'>): string {
  return `${syncRepairPrefix(scope)}${JSON.stringify([record.collection, record.id])}`;
}

export function syncReconciliationKey(scope: SyncRepairScope): string {
  return `sync.reconciliation.v1:${JSON.stringify([scope.spaceHandle, scope.epoch])}`;
}

export interface SyncReconciliationState extends SyncRepairScope {
  version: 1;
  cursor: number;
  complete: boolean;
}
