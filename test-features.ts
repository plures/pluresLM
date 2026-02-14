#!/usr/bin/env npx tsx
/**
 * Unit tests for time-decay and semantic dedup features
 * These tests don't require OpenAI/Ollama API access
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-feature-test.db";
const PASS = "✅";
const FAIL = "❌";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${FAIL} ${msg}`);
    failed++;
  }
}

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log("\n=== 1. Database Schema Migration ===\n");

  const db = new MemoryDB(TEST_DB, 1536, 30);

  // Check that new columns exist
  const columns = db["db"].prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const columnNames = columns.map(c => c.name);
  
  assert(columnNames.includes("last_accessed_at"), `last_accessed_at column exists`);
  assert(columnNames.includes("merge_count"), `merge_count column exists`);
  assert(columnNames.includes("created_at"), `created_at column exists (existing)`);

  console.log("\n=== 2. Time-Decay Configuration ===\n");

  const db7day = new MemoryDB("/tmp/test-7day.db", 1536, 7);
  assert(db7day["decayHalfLifeDays"] === 7, `Custom decay half-life set (7 days)`);
  
  const db30day = new MemoryDB("/tmp/test-30day.db", 1536, 30);
  assert(db30day["decayHalfLifeDays"] === 30, `Default decay half-life set (30 days)`);
  
  db7day.close();
  db30day.close();

  console.log("\n=== 3. Storage with New Fields ===\n");

  // Create a fake embedding
  const fakeEmbedding = Array(1536).fill(0).map((_, i) => Math.random());
  
  const stored = await db.store("Test memory content", fakeEmbedding, {
    source: "test",
    tags: ["test"],
    category: "test",
  });

  assert(!stored.isDuplicate, `First store is not duplicate`);
  assert(stored.entry.merge_count === 0, `New memory has merge_count = 0`);
  assert(stored.entry.last_accessed_at === undefined, `New memory has no last_accessed_at initially`);

  console.log("\n=== 4. Last Accessed At Update ===\n");

  // Search should update last_accessed_at
  const results = await db.vectorSearch(fakeEmbedding, 5, 0.0);
  assert(results.length > 0, `Search finds the memory`);
  assert(results[0].entry.last_accessed_at !== undefined, `last_accessed_at set after search`);
  assert(typeof results[0].entry.last_accessed_at === "number", `last_accessed_at is a number`);

  console.log("\n=== 5. Helper Method for Testing ===\n");

  const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
  db.updateLastAccessedAt(stored.entry.id, tenDaysAgo);
  
  // Verify it was updated
  const row = db["db"].prepare("SELECT last_accessed_at FROM memories WHERE id = ?").get(stored.entry.id) as { last_accessed_at: number };
  assert(Math.abs(row.last_accessed_at - tenDaysAgo) < 1000, `updateLastAccessedAt works correctly`);

  console.log("\n=== 6. Permanent Tag Handling ===\n");

  const permanentEmbedding = Array(1536).fill(0).map((_, i) => Math.random());
  const permanent = await db.store("Permanent memory", permanentEmbedding, {
    source: "test",
    tags: ["permanent", "important"],
    category: "principle",
  });

  assert(permanent.entry.tags.includes("permanent"), `Permanent tag stored`);

  console.log("\n=== 7. Dedup Command ===\n");

  // Test dry run
  const dryRun = await db.findDuplicates(true);
  assert(Array.isArray(dryRun), `findDuplicates returns array`);
  console.log(`   Found ${dryRun.length} duplicate cluster(s) in dry run`);

  console.log("\n=== 8. Semantic Dedup Store Option ===\n");

  const content1 = "Test content for dedup";
  const embedding1 = Array(1536).fill(0).map((_, i) => Math.random());
  
  const result1 = await db.store(content1, embedding1, {
    tags: ["dedup-test"],
    useSemanticDedup: false, // Disable for this test
  });
  
  assert(!result1.merged, `Store with useSemanticDedup=false doesn't merge`);

  console.log("\n=== 9. Merge Count Tracking ===\n");

  // Verify merge_count is tracked
  const allMemories = db["db"].prepare("SELECT id, merge_count FROM memories").all() as Array<{ id: string; merge_count: number }>;
  assert(allMemories.length > 0, `Memories stored in database`);
  assert(allMemories.every(m => typeof m.merge_count === "number"), `All memories have merge_count field`);

  // Cleanup
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm", "/tmp/test-7day.db", "/tmp/test-30day.db", 
                   "/tmp/test-7day.db-wal", "/tmp/test-7day.db-shm", "/tmp/test-30day.db-wal", "/tmp/test-30day.db-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
