/**
 * Backend factory for pluresLM
 *
 * PluresDB native NAPI is the only supported backend.
 * better-sqlite3 has been removed — use the migration script to convert old databases.
 */

import { PluresDBBackend } from "./pluresdb-backend.js";

export type BackendType = "pluresdb";

/** Backend interface — PluresDBBackend is the sole implementation. */
export type IMemoryBackend = PluresDBBackend;

export interface BackendConfig {
  dbPath: string;
  vectorDimension: number;
  embeddingModel?: string;
  actorId?: string;
}

/**
 * Create a PluresDB backend instance.
 */
export function createBackend(config: BackendConfig): PluresDBBackend {
  return new PluresDBBackend(config.dbPath, config.vectorDimension, {
    embeddingModel: config.embeddingModel,
    actorId: config.actorId,
  });
}

/**
 * Detect available backend. Always returns "pluresdb".
 */
export async function detectBackend(): Promise<BackendType> {
  return "pluresdb";
}

/**
 * Check if the PluresDB native backend is available.
 */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    require("@plures/pluresdb/embedded");
    return true;
  } catch {
    // Try workspace path
    try {
      const path = await import("node:path");
      const require = (await import("node:module")).createRequire(import.meta.url);
      const workspacePath = path.resolve(
        import.meta.url.replace("file://", ""),
        "..", "..", "..", "..", "pluresdb", "embedded.js",
      );
      require(workspacePath);
      return true;
    } catch {
      return false;
    }
  }
}
