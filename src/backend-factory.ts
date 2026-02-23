/**
 * Backend factory for creating database instances
 * 
 * Supports both PluresDB (preferred) and better-sqlite3 (legacy fallback) backends
 */

import { MemoryDB } from "./memory-db.js";
import { PluresDBBackend } from "./pluresdb-backend.js";

export type BackendType = "better-sqlite3" | "pluresdb";

export interface BackendConfig {
  type: BackendType;
  dbPath: string;
  vectorDimension: number;
  decayHalfLifeDays?: number;
}

import type { MemoryEntry, MemorySearchResult, ProfileData, DailySummary, MemoryPriority } from "./memory-db.js";

export interface IMemoryBackend {
  store(content: string, embedding: number[], opts: { source?: string; tags?: string[]; category?: string; priority?: MemoryPriority; dedupeThreshold?: number }): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }>;
  vectorSearch(queryEmbedding: number[], limit?: number, minScore?: number): Promise<MemorySearchResult[]>;
  vectorSearchBoosted(queryEmbedding: number[], limit?: number, minScore?: number, boostCategories?: Record<string, number>): Promise<MemorySearchResult[]>;
  addEdge(fromId: string, toId: string, relation: string): Promise<void>;
  getRelated(memoryId: string, relation?: string): Promise<MemoryEntry[]>;
  delete(id: string): Promise<boolean>;
  deleteBySource(source: string): Promise<number>;
  deleteByQuery(embedding: number[], threshold?: number): Promise<number>;
  count(): Promise<number>;
  getAllContent(limit?: number): Promise<string[]>;
  getLastCaptureTime(): Promise<number | null>;
  getProfile(): Promise<ProfileData | null>;
  setProfile(profile: ProfileData): Promise<void>;
  incrementCaptureCount(): Promise<number>;
  stats(): Promise<{ totalMemories: number; categories: Record<string, number>; edgeCount: number; lastCaptureTime: number | null }>;
  getMemoriesByCategories(categories: string[], limit: number, recencyBias: number): Promise<MemoryEntry[]>;
  getMemoriesSince(timestamp: number): Promise<Array<Omit<MemoryEntry, "embedding">>>;
  getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>>;
  getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>>;
  storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  getLastSyncTime(peerId: string): Promise<number>;
  setLastSyncTime(peerId: string, timestamp: number): Promise<void>;
  generateDailySummary(date: string): Promise<DailySummary>;
  getDailySummaries(days: number): Promise<DailySummary[]>;
  isOpen(): Promise<boolean>;
  reopen(): Promise<void>;
  close(): Promise<void>;
  /** Returns the byte length of the first stored embedding, or null if no embeddings exist. */
  getEmbeddingByteLength(): Promise<number | null>;
}

/**
 * Create a database backend based on configuration
 */
export function createBackend(config: BackendConfig): IMemoryBackend {
  switch (config.type) {
    case "pluresdb":
      return new PluresDBBackend(config.dbPath, config.vectorDimension);
    
    case "better-sqlite3":
    default:
      return new MemoryDB(config.dbPath, config.vectorDimension, config.decayHalfLifeDays ?? 30);
  }
}

/**
 * Create a backend whose type is resolved asynchronously on first use.
 *
 * Use this when the backend type is not yet known synchronously (e.g. auto-detection).
 * The `factory` is called once and its result is cached for all subsequent calls.
 * If `factory` rejects, the rejection propagates to every method call on the returned object.
 */
export function createLazyBackend(factory: () => Promise<IMemoryBackend>): IMemoryBackend {
  const pending = factory();
  return new Proxy({} as IMemoryBackend, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        const backend = await pending;
        const value = (backend as unknown as Record<string, unknown>)[prop];
        if (typeof value !== "function") {
          throw new TypeError(`IMemoryBackend.${prop} is not a function`);
        }
        return (value as (...a: unknown[]) => unknown).apply(backend, args);
      };
    },
  });
}

/**
 * Check if a backend type is available
 */
export async function isBackendAvailable(type: BackendType): Promise<boolean> {
  switch (type) {
    case "pluresdb": {
      // Require both the @plures/pluresdb package AND its legacy Deno entry point
      try {
        const { createRequire } = await import("node:module");
        const { existsSync } = await import("node:fs");
        const { dirname, join } = await import("node:path");
        const require = createRequire(import.meta.url);
        const pkgJson = require.resolve("@plures/pluresdb/package.json");
        const legacyMain = join(dirname(pkgJson), "legacy", "main.ts");
        return existsSync(legacyMain);
      } catch {
        return false;
      }
    }

    case "better-sqlite3":
      try {
        await import("better-sqlite3");
        return true;
      } catch {
        return false;
      }
    
    default:
      return false;
  }
}

/**
 * Get the default backend type based on what's available.
 * 
 * Prefers PluresDB when available; falls back to better-sqlite3 for legacy compatibility.
 */
export async function getDefaultBackendType(): Promise<BackendType> {
  // Prefer PluresDB — fall back to better-sqlite3 for legacy compatibility
  if (await isBackendAvailable("pluresdb")) {
    return "pluresdb";
  }
  if (await isBackendAvailable("better-sqlite3")) {
    return "better-sqlite3";
  }
  // If neither backend is actually available at runtime, default to better-sqlite3
  // to maintain the declared legacy type. The caller is expected to handle failures.
  return "better-sqlite3";
}
