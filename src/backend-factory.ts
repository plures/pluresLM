/**
 * Backend factory for creating database instances
 * 
 * Supports both better-sqlite3 (default) and PluresDB backends
 */

import { MemoryDB } from "./memory-db.js";
import { PluresDBBackend } from "./pluresdb-backend.js";

export type BackendType = "better-sqlite3" | "pluresdb";

export interface BackendConfig {
  type: BackendType;
  dbPath: string;
  vectorDimension: number;
}

export interface IMemoryBackend {
  store(content: string, embedding: number[], opts: { source?: string; tags?: string[]; category?: string; dedupeThreshold?: number }): Promise<{ entry: any; isDuplicate: boolean; updatedId?: string }>;
  vectorSearch(queryEmbedding: number[], limit?: number, minScore?: number): Promise<any[]>;
  vectorSearchBoosted(queryEmbedding: number[], limit?: number, minScore?: number, boostCategories?: Record<string, number>): Promise<any[]>;
  addEdge(fromId: string, toId: string, relation: string): Promise<void>;
  getRelated(memoryId: string, relation?: string): Promise<any[]>;
  delete(id: string): Promise<boolean>;
  deleteBySource(source: string): Promise<number>;
  deleteByQuery(embedding: number[], threshold?: number): Promise<number>;
  count(): Promise<number>;
  getAllContent(limit?: number): Promise<string[]>;
  getLastCaptureTime(): Promise<number | null>;
  getProfile(): Promise<any>;
  setProfile(profile: any): Promise<void>;
  incrementCaptureCount(): Promise<number>;
  stats(): Promise<{ totalMemories: number; categories: Record<string, number>; edgeCount: number; lastCaptureTime: number | null }>;
  getMemoriesSince(timestamp: number): Promise<any[]>;
  getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>>;
  getMemoriesByIds(ids: string[]): Promise<any[]>;
  storeRaw(entry: any): Promise<boolean>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  getLastSyncTime(peerId: string): Promise<number>;
  setLastSyncTime(peerId: string, timestamp: number): Promise<void>;
  isOpen(): Promise<boolean>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a database backend based on configuration
 */
export function createBackend(config: BackendConfig): IMemoryBackend {
  switch (config.type) {
    case "pluresdb":
      console.log(`[Backend] Using PluresDB backend at ${config.dbPath}`);
      return new PluresDBBackend(config.dbPath, config.vectorDimension);
    
    case "better-sqlite3":
    default:
      console.log(`[Backend] Using better-sqlite3 backend at ${config.dbPath}`);
      return new MemoryDB(config.dbPath, config.vectorDimension);
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
 * Get the default backend type based on what's available
 */
export async function getDefaultBackendType(): Promise<BackendType> {
  // Prefer PluresDB if available, fall back to better-sqlite3
  if (await isBackendAvailable("pluresdb")) {
    return "pluresdb";
  }
  return "better-sqlite3";
}
