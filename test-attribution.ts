#!/usr/bin/env npx tsx
/**
 * Test: memory attribution fields for multi-agent coordination
 */
import Database from "better-sqlite3";
import { MemoryDB } from "./src/memory-db.js";
import { existsSync, unlinkSync } from "node:fs";

const TEST_DB = "/tmp/pluresLM-attribution-test.db";
let passed = 0, failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`✅ ${msg}`); passed++; }
  else { console.log(`❌ ${msg}`); failed++; }
}

// Orthogonal fake embeddings for testing
function fakeEmbed(seed: number): number[] {
  const arr = new Array(16).fill(0);
  arr[seed % 16] = 1.0;
  return arr;
}

async function main() {
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 16);

  console.log("\n=== 1. Store with attribution ===\n");

  const r1 = await db.store("I will review PR plures/pluresLM#67", fakeEmbed(0), {
    source: "test",
    category: "decision",
    originator_id: "desktop-agent",
    originator_name: "Desktop",
    status: "claimed",
    assigned_to: "desktop-agent",
    useSemanticDedup: false,
  });

  assert(!r1.isDuplicate, "First store is not duplicate");
  assert(r1.entry.originator_id === "desktop-agent", `originator_id preserved: ${r1.entry.originator_id}`);
  assert(r1.entry.originator_name === "Desktop", `originator_name preserved: ${r1.entry.originator_name}`);
  assert(r1.entry.status === "claimed", `status preserved: ${r1.entry.status}`);
  assert(r1.entry.assigned_to === "desktop-agent", `assigned_to preserved: ${r1.entry.assigned_to}`);

  console.log("\n=== 2. Store with destination and due_at ===\n");

  const due = Date.now() + 3600000; // 1 hour from now
  const r2 = await db.store("Deploy the new service by end of day", fakeEmbed(1), {
    source: "test",
    category: "work-in-progress",
    originator_id: "surface-agent",
    originator_name: "Surface",
    destination: "desktop-agent",
    due_at: due,
    useSemanticDedup: false,
  });

  assert(!r2.isDuplicate, "Second store is not duplicate");
  assert(r2.entry.destination === "desktop-agent", `destination preserved: ${r2.entry.destination}`);
  assert(r2.entry.due_at === due, `due_at preserved: ${r2.entry.due_at}`);
  assert(r2.entry.originator_id === "surface-agent", `originator_id for surface: ${r2.entry.originator_id}`);

  console.log("\n=== 3. vectorSearch returns attribution ===\n");

  const results = await db.vectorSearch(fakeEmbed(0), 5, 0.01);
  assert(results.length > 0, `vectorSearch returns results`);
  const firstResult = results.find(r => r.entry.originator_id === "desktop-agent");
  assert(firstResult !== undefined, `Attribution preserved in vectorSearch result`);
  if (firstResult) {
    assert(firstResult.entry.status === "claimed", `Status visible in search result: ${firstResult.entry.status}`);
    assert(firstResult.entry.assigned_to === "desktop-agent", `assigned_to visible in search result`);
  }

  console.log("\n=== 4. updateAttribution ===\n");

  const updated = await db.updateAttribution(r1.entry.id, {
    status: "completed",
    last_checkin: Date.now(),
  });
  assert(updated, `updateAttribution returns true`);

  // Verify by searching again
  const afterUpdate = await db.vectorSearch(fakeEmbed(0), 5, 0.01);
  const updatedEntry = afterUpdate.find(r => r.entry.id === r1.entry.id);
  assert(updatedEntry !== undefined, `Entry still found after update`);
  if (updatedEntry) {
    assert(updatedEntry.entry.status === "completed", `Status updated to completed: ${updatedEntry.entry.status}`);
  }

  console.log("\n=== 5. storeRaw with attribution (sync) ===\n");

  const rawEntry = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    content: "Surface agent synced this memory",
    created_at: Date.now(),
    source: "sync",
    tags: [],
    category: "explicit",
    originator_id: "surface-agent",
    originator_name: "Surface",
    status: "in-progress",
    assigned_to: "surface-agent",
    destination: "desktop-agent",
  };

  const stored = await db.storeRaw(rawEntry);
  assert(stored, `storeRaw returns true for new entry`);

  // Verify the raw entry's attribution is preserved
  const rawResults = await db.getMemoriesByIds([rawEntry.id]);
  assert(rawResults.length === 1, `getMemoriesByIds finds raw entry`);
  if (rawResults.length > 0) {
    assert(rawResults[0].originator_id === "surface-agent", `originator_id in raw entry: ${rawResults[0].originator_id}`);
    assert(rawResults[0].originator_name === "Surface", `originator_name in raw entry: ${rawResults[0].originator_name}`);
    assert(rawResults[0].status === "in-progress", `status in raw entry: ${rawResults[0].status}`);
    assert(rawResults[0].destination === "desktop-agent", `destination in raw entry: ${rawResults[0].destination}`);
    assert(rawResults[0].assigned_to === "surface-agent", `assigned_to in raw entry: ${rawResults[0].assigned_to}`);
  }

  console.log("\n=== 6. storeRaw update preserves attribution ===\n");

  const rawEntryUpdate = { ...rawEntry, status: "completed" };
  const updatedRaw = await db.storeRaw(rawEntryUpdate);
  assert(updatedRaw, `storeRaw update returns true`);

  const afterRawUpdate = await db.getMemoriesByIds([rawEntry.id]);
  assert(afterRawUpdate.length === 1, `Entry found after update`);
  if (afterRawUpdate.length > 0) {
    assert(afterRawUpdate[0].status === "completed", `storeRaw update preserves new status: ${afterRawUpdate[0].status}`);
    assert(afterRawUpdate[0].originator_id === "surface-agent", `originator_id preserved after update`);
  }

  console.log("\n=== 7. getMemoriesSince with attribution ===\n");

  const since = await db.getMemoriesSince(0);
  assert(since.length > 0, `getMemoriesSince returns entries`);
  const withAttribution = since.filter(m => m.originator_id);
  assert(withAttribution.length > 0, `getMemoriesSince includes attribution fields`);

  console.log("\n=== 8. Schema columns exist ===\n");

  const columns = (db as any).db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const colNames = columns.map((c: { name: string }) => c.name);
  assert(colNames.includes("originator_id"), `originator_id column exists`);
  assert(colNames.includes("originator_name"), `originator_name column exists`);
  assert(colNames.includes("destination"), `destination column exists`);
  assert(colNames.includes("status"), `status column exists`);
  assert(colNames.includes("assigned_to"), `assigned_to column exists`);
  assert(colNames.includes("due_at"), `due_at column exists`);
  assert(colNames.includes("last_checkin"), `last_checkin column exists`);

  await db.close();

  console.log("\n=== 9. Schema migration from old DB ===\n");

  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  // Create an "old" DB without the new columns
  const oldDb = new Database(TEST_DB);
  oldDb.exec(`
    CREATE TABLE IF NOT EXISTS memories (
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
  `);
  oldDb.prepare(`INSERT INTO memories (id, content, created_at) VALUES (?, ?, ?)`).run("test-id", "Old memory without attribution", Date.now());
  oldDb.close();

  // Open with new MemoryDB - should auto-migrate
  const migratedDb = new MemoryDB(TEST_DB, 16);
  const migratedColumns = (migratedDb as any).db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const migratedColNames = migratedColumns.map((c: { name: string }) => c.name);
  assert(migratedColNames.includes("originator_id"), `Migration added originator_id`);
  assert(migratedColNames.includes("status"), `Migration added status`);
  assert(migratedColNames.includes("assigned_to"), `Migration added assigned_to`);

  // Old data should still be accessible
  const oldMemory = (migratedDb as any).db.prepare("SELECT * FROM memories WHERE id = 'test-id'").get() as { originator_id: string } | undefined;
  assert(oldMemory !== undefined, `Old memory still accessible after migration`);
  assert(oldMemory?.originator_id === "", `Old memory has default empty originator_id: "${oldMemory?.originator_id}"`);

  await migratedDb.close();

  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
