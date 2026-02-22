/**
 * Backend factory for creating database instances
 * 
 * Supports both better-sqlite3 (default) and PluresDB backends
 */

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
export async function createBackend(config: BackendConfig): Promise<IMemoryBackend> {
  switch (config.type) {
    case "pluresdb":
      return new PluresDBBackend(config.dbPath, config.vectorDimension);
    
    case "better-sqlite3":
    default: {
      let MemoryDB: typeof import("./memory-db.js").MemoryDB;
      try {
        ({ MemoryDB } = await import("./memory-db.js"));
      } catch {
        throw new Error(
          "better-sqlite3 is not available. Install it with: npm install better-sqlite3\n" +
          "Alternatively, use the PluresDB backend by setting backendType: \"pluresdb\" and installing @plures/pluresdb."
        );
      }
      return new MemoryDB(config.dbPath, config.vectorDimension, config.decayHalfLifeDays ?? 30);
    }
  }
}

/**
 * Check if a backend type is available
 */
export async function isBackendAvailable(type: BackendType): Promise<boolean> {
  switch (type) {
    case "pluresdb":
      try {
        // Try to import PluresDB
        // @ts-ignore - optional peer dependency
        await import("@plures/pluresdb/better-sqlite3");
        return true;
      } catch {
        return false;
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
 * Prefer better-sqlite3 for backward compatibility, fall back to PluresDB.
 */
export async function getDefaultBackendType(): Promise<BackendType> {
  // Prefer better-sqlite3 if available, fall back to PluresDB
  if (await isBackendAvailable("better-sqlite3")) {
    return "better-sqlite3";
  }
  if (await isBackendAvailable("pluresdb")) {
    return "pluresdb";
  }
  // If neither backend is actually available at runtime, default to better-sqlite3
  // to maintain the declared default type. The caller is expected to handle failures.
  return "better-sqlite3";
}
