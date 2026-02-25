/**
 * Test database setup / teardown helpers.
 *
 * Uses PluresDBBackend with an in-memory mock NAPI store so tests work
 * without a native binary or better-sqlite3 installed.
 */

import { rmSync } from "node:fs";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";

// ---------------------------------------------------------------------------
// PluresDBBackend in-memory test factory
// ---------------------------------------------------------------------------

function mockCosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Create a PluresDBBackend backed by a fully in-memory mock NAPI store.
 * No native binary required — suitable for unit tests without @plures/pluresdb.
 *
 * The mock provides real cosine-similarity vector search so tests that rely
 * on score ordering and importance-score multiplication work correctly.
 */
export function makePluresTestDB(): { db: PluresDBBackend; cleanup: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, Record<string, unknown>>();
  // Separate map to preserve embeddings even when put() overwrites the data node
  const vectors = new Map<string, number[]>();

  const mockNapiDb = {
    list: () => Array.from(store.entries()).map(([id, data]) => ({ id, data })),
    get: (id: string) => store.get(id) ?? null,
    put: (id: string, data: Record<string, unknown>) => {
      store.set(id, data);
      return id;
    },
    putWithEmbedding: (id: string, data: Record<string, unknown>, embedding: number[]) => {
      store.set(id, { ...data, vector: embedding });
      vectors.set(id, embedding);
      return id;
    },
    delete: (id: string) => {
      store.delete(id);
      vectors.delete(id);
    },
    vectorSearch: (query: number[], limit: number, minScore: number) => {
      const results: Array<{ id: string; data: Record<string, unknown>; score: number }> = [];
      for (const [id, data] of store) {
        // Use vectors Map first; fall back to data.vector for entries updated via put()
        const vec = vectors.get(id) ?? (Array.isArray(data.vector) ? (data.vector as number[]) : null);
        if (!vec || vec.length === 0) continue;
        const score = mockCosineSimilarity(query, vec);
        if (score >= minScore) results.push({ id, data, score });
      }
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    listByType: (prefix: string) =>
      Array.from(store.entries())
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, data]) => ({ id, data })),
    search: () => [] as Array<{ id: string; data: Record<string, unknown>; score: number }>,
    stats: () => ({} as Record<string, unknown>),
    getActorId: () => "test",
    execDsl: (_query: string): never => { throw new Error("DSL not available in test stub"); },
    execIr: (_steps: unknown[]): never => { throw new Error("IR not available in test stub"); },
  };

  const db = new PluresDBBackend("/tmp/plures-test-stub", 8);
  // Inject stub, bypassing native-binding initialisation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db = mockNapiDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).initPromise = Promise.resolve();

  return {
    db,
    cleanup: () => { /* in-memory store, nothing to clean */ },
  };
}

/**
 * Alias for makePluresTestDB().
 *
 * All tests previously using makeTestDB() now receive a PluresDBBackend
 * backed by an in-memory store — no file I/O or better-sqlite3 required.
 * The `decayHalfLifeDays` parameter is accepted for API compatibility but
 * has no effect since PluresDBBackend does not implement time-decay.
 */
export function makeTestDB(
  _decayHalfLifeDays: number = 30,
): { db: PluresDBBackend; cleanup: () => void } {
  return makePluresTestDB();
}

/**
 * Remove DB-related files for a given path (main, WAL, SHM).
 * Retained for migration-script tests that manage their own file lifecycle.
 */
export function removeDbFiles(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}
