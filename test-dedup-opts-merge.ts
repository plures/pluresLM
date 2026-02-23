#!/usr/bin/env npx tsx
/**
 * Test: opts metadata is preserved (not lost) on dedup merge.
 * Covers both the simple dedup path (>= dedupeThreshold cosine similarity)
 * for MemoryDB, and verifies the merge rules:
 *   - tags: union (no duplicates)
 *   - importanceScore: higher value wins
 *   - source: most recent (opts.source) preferred
 *   - category: most recent (opts.category) preferred
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/dedup-opts-merge-test.db";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`✅ ${msg}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 8);

  // Use identical unit vectors so cosine similarity = 1.0 exactly, which
  // ensures dedup triggers regardless of importance-score multiplier.
  const vec = [1, 0, 0, 0, 0, 0, 0, 0];

  console.log("\n=== Testing opts metadata merge on dedup ===\n");

  // First store: rich opts (importance_score defaults to 1.0 so the
  // boosted score in vectorSearch stays at ~1.0, reliably above 0.95).
  const r1 = await db.store("A meeting about project roadmap", vec, {
    source: "email",
    tags: ["work", "roadmap"],
    category: "meeting",
    useSemanticDedup: false,
  });
  assert(!r1.isDuplicate, "First store is not a duplicate");
  assert(r1.entry.tags.includes("work"), "First store has tag 'work'");
  assert(r1.entry.tags.includes("roadmap"), "First store has tag 'roadmap'");
  assert(r1.entry.source === "email", "First store source is 'email'");
  assert((r1.entry.importance_score ?? 1.0) === 1.0, `First store importanceScore is 1.0 (got ${r1.entry.importance_score})`);

  // Second store: identical embedding → dedup; different opts
  const r2 = await db.store("A meeting discussing project roadmap plans", vec, {
    source: "slack",
    tags: ["urgent", "roadmap"],       // 'roadmap' already in first; 'urgent' is new
    category: "meeting",
    importanceScore: 0.7,              // lower than existing 1.0 → should keep 1.0
    useSemanticDedup: false,
    dedupeThreshold: 0.95,
  });
  assert(r2.isDuplicate, "Second store is a duplicate (dedup triggered)");
  assert(r2.updatedId === r1.entry.id, "Dedup updated the first entry's id");

  // Tags must be the union: work, roadmap, urgent (no duplicates)
  const tags = r2.entry.tags;
  assert(tags.includes("work"), `Merged tags include 'work' (got: ${JSON.stringify(tags)})`);
  assert(tags.includes("roadmap"), `Merged tags include 'roadmap' (got: ${JSON.stringify(tags)})`);
  assert(tags.includes("urgent"), `Merged tags include 'urgent' (got: ${JSON.stringify(tags)})`);
  assert(tags.filter((t) => t === "roadmap").length === 1, "No duplicate 'roadmap' tags");

  // importanceScore: max(1.0, 0.7) = 1.0
  assert(
    r2.entry.importance_score === 1.0,
    `importanceScore keeps higher value 1.0 (got ${r2.entry.importance_score})`,
  );

  // source: most recent (opts.source = "slack") wins
  assert(r2.entry.source === "slack", `Source updated to most recent 'slack' (got '${r2.entry.source}')`);

  // category: most recent wins
  assert(r2.entry.category === "meeting", `Category preserved as 'meeting' (got '${r2.entry.category}')`);

  // ── Third test: higher importance in new store should win ──
  const r3 = await db.store("Meeting about roadmap and plans", vec, {
    source: "calendar",
    tags: ["calendar-invite"],
    category: "meeting",
    importanceScore: 1.5,              // higher than persisted 1.0 → should become 1.5
    useSemanticDedup: false,
    dedupeThreshold: 0.95,
  });
  assert(r3.isDuplicate, "Third store is also a duplicate");
  assert(
    r3.entry.importance_score === 1.5,
    `importanceScore raised to 1.5 when new value is higher (got ${r3.entry.importance_score})`,
  );
  assert(r3.entry.tags.includes("calendar-invite"), "Third store tags include new 'calendar-invite'");
  assert(r3.entry.tags.includes("work"), "Third store tags still include original 'work'");

  db.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
