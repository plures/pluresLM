#!/usr/bin/env npx tsx
/**
 * Tests for scripts/migrate-to-pluresdb.ts
 *
 * Validates the migration logic using two better-sqlite3 databases
 * (source and target) so no PluresDB installation is required.
 *
 * Run with:
 *   npx tsx test-sqlite-to-pluresdb.ts
 */

import { migrate } from "./scripts/migrate-to-pluresdb.js";
import Database from "better-sqlite3";
import { existsSync, unlinkSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const TEST_DIR = path.join(os.tmpdir(), "pluresLM-migrate-test");
const SOURCE_DB = path.join(TEST_DIR, "source.db");
const TARGET_DB = path.join(TEST_DIR, "target.db");

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${FAIL} ${msg}`);
    failed++;
  }
}

function cleanup(): void {
  const files = [
    SOURCE_DB,
    `${SOURCE_DB}-wal`,
    `${SOURCE_DB}-shm`,
    TARGET_DB,
    `${TARGET_DB}-wal`,
    `${TARGET_DB}-shm`,
  ];
  for (const f of files) {
    if (existsSync(f)) unlinkSync(f);
  }
  // Remove any backup files
  try {
    const entries = readdirSync(TEST_DIR);
    for (const entry of entries) {
      if (entry.startsWith("source.db.bak.")) {
        unlinkSync(path.join(TEST_DIR, entry));
      }
    }
  } catch {
    // ignore
  }
}

function encodeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float64Array(vec).buffer);
}

function makeTestEmbedding(seed: number, dim: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < dim; i++) {
    arr.push(Math.sin((seed + i) * 0.1));
  }
  // Normalize
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  return arr.map((v) => v / norm);
}

/**
 * Create a source SQLite database with test data.
 */
function createSourceDb(variant: "full" | "no-embeddings" | "legacy-schema"): void {
  const db = new Database(SOURCE_DB);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (variant === "legacy-schema") {
    // Older schema without priority, last_accessed_at, merge_count, importance_score
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        source TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        category TEXT DEFAULT 'other'
      );
      CREATE TABLE memory_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE profile (
        id TEXT PRIMARY KEY DEFAULT 'user_profile',
        summary TEXT DEFAULT '',
        facts TEXT DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        capture_count INTEGER DEFAULT 0
      );
    `);
  } else {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        source TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        category TEXT DEFAULT 'other',
        priority TEXT DEFAULT 'normal',
        last_accessed_at INTEGER,
        merge_count INTEGER DEFAULT 0,
        importance_score REAL DEFAULT 1.0
      );
      CREATE TABLE memory_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE profile (
        id TEXT PRIMARY KEY DEFAULT 'user_profile',
        summary TEXT DEFAULT '',
        facts TEXT DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        capture_count INTEGER DEFAULT 0
      );
    `);
  }

  const insertMem = db.prepare(
    variant === "legacy-schema"
      ? "INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)"
      : "INSERT INTO memories (id, content, embedding, created_at, source, tags, category, priority, last_accessed_at, merge_count, importance_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const ids: string[] = [];

  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    ids.push(id);
    const emb = variant === "no-embeddings" ? null : encodeEmbedding(makeTestEmbedding(i, 384));
    const now = Date.now() - i * 1000;

    if (variant === "legacy-schema") {
      insertMem.run(id, `Test memory content number ${i + 1}`, emb, now, "test", "[]", "conversation");
    } else {
      insertMem.run(
        id,
        `Test memory content number ${i + 1}`,
        emb,
        now,
        "test",
        JSON.stringify([`tag${i}`]),
        i === 0 ? "decision" : "conversation",
        i === 0 ? "high" : "normal",
        null,
        i,
        1.0 + i * 0.1,
      );
    }
  }

  // Add one memory without embedding (like a daily summary)
  const noEmbId = randomUUID();
  ids.push(noEmbId);
  if (variant === "legacy-schema") {
    insertMem.run(noEmbId, "Daily summary content", null, Date.now(), "daily", "[]", "daily-summary");
  } else {
    insertMem.run(noEmbId, "Daily summary content", null, Date.now(), "daily", '["daily-summary:2024-01-01"]', "daily-summary", "normal", null, 0, 1.0);
  }

  // Add an edge between first two memories
  if (ids.length >= 2) {
    db.prepare(
      "INSERT INTO memory_edges (id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), ids[0], ids[1], "related", Date.now());
  }

  // Add profile
  db.prepare(
    "INSERT INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', ?, ?, ?, ?)",
  ).run("Test user profile summary", JSON.stringify(["Prefers TypeScript"]), Date.now(), 42);

  db.close();
}

async function main(): Promise<void> {
  mkdirSync(TEST_DIR, { recursive: true });

  // ---- Test 1: Basic migration ----
  console.log("\n=== 1. Basic Migration ===\n");

  cleanup();
  createSourceDb("full");

  const result = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: false,
    skipBackup: false,
  });

  assert(result.memoriesTotal === 6, `Source has 6 memories (got ${result.memoriesTotal})`);
  assert(result.memoriesMigrated === 6, `All 6 memories migrated (got ${result.memoriesMigrated})`);
  assert(result.memoriesWithEmbedding === 5, `5 memories have embeddings (got ${result.memoriesWithEmbedding})`);
  assert(result.edgesTotal === 1, `Source has 1 edge (got ${result.edgesTotal})`);
  assert(result.edgesMigrated === 1, `1 edge migrated (got ${result.edgesMigrated})`);
  assert(result.profileMigrated, "Profile was migrated");
  assert(result.backupPath !== null, "Backup was created");
  assert(result.backupPath !== null && existsSync(result.backupPath), "Backup file exists on disk");
  assert(result.errors.length === 0, `No errors (got: ${result.errors.join(", ")})`);
  assert(result.verification.countMatch, "Count verification passed");
  assert(
    result.verification.sampleVerified === result.verification.sampleTotal,
    `Sample verification: ${result.verification.sampleVerified}/${result.verification.sampleTotal}`,
  );
  assert(result.verification.embeddingSearchMatch, "Embedding search verification passed");

  // Verify target DB has correct data
  const tgtDb = new Database(TARGET_DB, { readonly: true });
  const tgtCount = (tgtDb.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number }).cnt;
  assert(tgtCount === 6, `Target DB has 6 memories (got ${tgtCount})`);

  const tgtEdgeCount = (tgtDb.prepare("SELECT COUNT(*) as cnt FROM memory_edges").get() as { cnt: number }).cnt;
  assert(tgtEdgeCount === 1, `Target DB has 1 edge (got ${tgtEdgeCount})`);

  const tgtProfile = tgtDb.prepare("SELECT * FROM profile WHERE id = 'user_profile'").get() as Record<string, unknown> | undefined;
  assert(tgtProfile !== undefined, "Profile exists in target DB");
  assert(tgtProfile?.capture_count === 42, `Profile capture_count preserved (got ${tgtProfile?.capture_count})`);
  assert(tgtProfile?.summary === "Test user profile summary", "Profile summary preserved");

  // Verify priority is preserved
  const highPrio = tgtDb.prepare("SELECT priority FROM memories WHERE priority = 'high'").get() as { priority: string } | undefined;
  assert(highPrio !== undefined, "Priority 'high' preserved in target");

  // Verify importance_score is preserved
  const impScore = tgtDb.prepare("SELECT importance_score FROM memories WHERE importance_score > 1.0 LIMIT 1").get() as { importance_score: number } | undefined;
  assert(impScore !== undefined, "importance_score > 1.0 preserved in target");

  tgtDb.close();

  // ---- Test 2: Dry-run ----
  console.log("\n=== 2. Dry-run ===\n");

  cleanup();
  createSourceDb("full");

  const dryResult = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: true,
    skipBackup: false,
  });

  assert(dryResult.memoriesTotal === 6, `Dry-run reports 6 memories (got ${dryResult.memoriesTotal})`);
  assert(!existsSync(TARGET_DB), "Target DB was NOT created during dry-run");
  assert(dryResult.backupPath === null, "No backup created during dry-run");

  // ---- Test 3: Skip backup ----
  console.log("\n=== 3. Skip Backup ===\n");

  cleanup();
  createSourceDb("full");

  const noBackupResult = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: false,
    skipBackup: true,
  });

  assert(noBackupResult.backupPath === null, "No backup when --skip-backup is used");
  assert(noBackupResult.memoriesMigrated === 6, "Migration still succeeded without backup");

  // ---- Test 4: Legacy schema (v0.12.x–v0.14.x without newer columns) ----
  console.log("\n=== 4. Legacy Schema Compatibility ===\n");

  cleanup();
  createSourceDb("legacy-schema");

  const legacyResult = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: false,
    skipBackup: true,
  });

  assert(legacyResult.errors.length === 0, `No errors migrating legacy schema (got: ${legacyResult.errors.join(", ")})`);
  assert(legacyResult.memoriesMigrated === 6, `All 6 legacy memories migrated (got ${legacyResult.memoriesMigrated})`);
  assert(legacyResult.verification.countMatch, "Count match for legacy migration");

  // ---- Test 5: No embeddings ----
  console.log("\n=== 5. Migration Without Embeddings ===\n");

  cleanup();
  createSourceDb("no-embeddings");

  const noEmbResult = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: false,
    skipBackup: true,
  });

  assert(noEmbResult.memoriesMigrated === 6, `Migrated 6 memories without embeddings (got ${noEmbResult.memoriesMigrated})`);
  assert(noEmbResult.memoriesWithEmbedding === 0, `0 embeddings migrated (got ${noEmbResult.memoriesWithEmbedding})`);
  assert(noEmbResult.verification.embeddingSearchMatch, "Embedding search skipped (returns true) when no embeddings");

  // ---- Test 6: Rollback on failure ----
  console.log("\n=== 6. Rollback on Failure ===\n");

  cleanup();
  // Create a source with a non-DB file to trigger failure
  writeFileSync(SOURCE_DB, "this is not a sqlite database");

  let didThrow = false;
  try {
    await migrate({
      sourcePath: SOURCE_DB,
      targetPath: TARGET_DB,
      dryRun: false,
      skipBackup: true,
    });
  } catch {
    didThrow = true;
  }

  assert(didThrow, "Migration throws on invalid source database");
  assert(!existsSync(TARGET_DB), "Target DB cleaned up after failure (rollback)");

  // ---- Test 7: Source not found ----
  console.log("\n=== 7. Source Not Found ===\n");

  cleanup();

  let notFoundThrow = false;
  try {
    await migrate({
      sourcePath: path.join(TEST_DIR, "nonexistent.db"),
      targetPath: TARGET_DB,
      dryRun: false,
      skipBackup: true,
    });
  } catch (err) {
    notFoundThrow = err instanceof Error && err.message.includes("Source database not found");
  }

  assert(notFoundThrow, "Throws meaningful error when source not found");

  // ---- Test 8: Empty source ----
  console.log("\n=== 8. Empty Source Database ===\n");

  cleanup();
  // Create empty but valid DB
  const emptyDb = new Database(SOURCE_DB);
  emptyDb.exec(`
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding BLOB,
      created_at INTEGER NOT NULL, source TEXT DEFAULT '', tags TEXT DEFAULT '[]',
      category TEXT DEFAULT 'other');
  `);
  emptyDb.close();

  const emptyResult = await migrate({
    sourcePath: SOURCE_DB,
    targetPath: TARGET_DB,
    dryRun: false,
    skipBackup: true,
  });

  assert(emptyResult.memoriesTotal === 0, "Empty source reports 0 memories");
  assert(emptyResult.memoriesMigrated === 0, "0 memories migrated from empty source");

  // ---- Cleanup ----
  cleanup();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed with unexpected error:", err);
  process.exit(1);
});
