/**
 * DB adapter layer for the sync protocol.
 *
 * Defines the minimal `SyncDBAdapter` interface that the sync protocol needs
 * and provides `createSyncDBAdapter()` to wrap any `IMemoryBackend` into it.
 *
 * This decouples sync.ts from the concrete backend type, making the sync
 * layer straightforward to test with lightweight stubs.
 */

import type { IMemoryBackend } from "./backend-factory.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

/**
 * Minimal DB surface required by the sync protocol.
 *
 * Maps to PluresDB equivalents:
 *   getAllMemoryIds()               → list() filtered to memory: prefix
 *   getMemoriesByIds(ids)           → get(id) for each id
 *   getMemoriesSince(since)         → list() filtered by created_at
 *   getLastSyncTime(peerId)         → get('sync:' + peerId)
 *   setLastSyncTime(peerId, ts)     → put('sync:' + peerId, { last_sync_at: ts })
 *   storeRaw(entry)                 → put(entry.id, entry)
 *   setEmbedding(id, embedding)     → putWithEmbedding(id, data, embedding)
 *   vectorSearch(emb, lim, thresh)  → vectorSearch(emb, lim, thresh)
 *   delete(id)                      → delete(id)
 */
export interface SyncDBAdapter {
  getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>>;
  getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>>;
  getMemoriesSince(since: number): Promise<Array<Omit<MemoryEntry, "embedding">>>;
  getLastSyncTime(peerId: string): Promise<number>;
  setLastSyncTime(peerId: string, timestamp: number): Promise<void>;
  storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  vectorSearch(embedding: number[], limit: number, threshold: number): Promise<MemorySearchResult[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * Wraps an `IMemoryBackend` (PluresDB) into the minimal `SyncDBAdapter`
 * interface required by the sync protocol.
 */
export function createSyncDBAdapter(db: IMemoryBackend): SyncDBAdapter {
  return {
    getAllMemoryIds: () => db.getAllMemoryIds(),
    getMemoriesByIds: (ids) => db.getMemoriesByIds(ids),
    getMemoriesSince: (since) => db.getMemoriesSince(since),
    getLastSyncTime: (peerId) => db.getLastSyncTime(peerId),
    setLastSyncTime: (peerId, ts) => db.setLastSyncTime(peerId, ts),
    storeRaw: (entry) => db.storeRaw(entry),
    setEmbedding: (id, embedding) => db.setEmbedding(id, embedding),
    vectorSearch: (embedding, limit, threshold) => db.vectorSearch(embedding, limit, threshold),
    delete: (id) => db.delete(id),
  };
}
