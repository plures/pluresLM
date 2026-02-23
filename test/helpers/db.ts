/**
 * Test database setup / teardown helpers.
 *
 * Uses a unique temp file per test to avoid cross-test state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../../src/memory-db.js";

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
