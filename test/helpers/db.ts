/**
 * Test database setup / teardown helpers.
 *
 * Uses a unique temp file per test to avoid cross-test state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../../src/memory-db.js";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";

/**
 * Create a temporary directory for a test database.
 * Returns the directory path and a cleanup function.
 */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pluresLM-test-"));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Create a MemoryDB backed by a temp file.
 * Returns the db, its path, and a cleanup function.
 */
export function makeTestDB(
  decayHalfLifeDays: number = 30,
): { db: MemoryDB; dbPath: string; cleanup: () => void } {
  const { dir, cleanup } = makeTempDir();
  const dbPath = join(dir, "test.db");
  const db = new MemoryDB(dbPath, 8, decayHalfLifeDays);
  return {
    db,
    dbPath,
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed
      }
      cleanup();
    },
  };
}

/**
 * Remove all DB-related files for a given path (main, WAL, SHM).
 * Useful for tests that manage their own DB file lifecycle outside of makeTestDB.
 */
export function removeDbFiles(dbPath: string): void {
  // Use the parent-directory cleanup from makeTempDir when possible.
  // This helper is retained for cases where a test creates a DB at an
  // arbitrary path rather than via makeTestDB.
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

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
