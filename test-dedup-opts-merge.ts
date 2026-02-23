#!/usr/bin/env npx tsx
/**
 * Test: opts metadata is preserved (not lost) on dedup merge.
 * Covers both the simple dedup path (>= dedupeThreshold cosine similarity)
 * and the semantic dedup path (useSemanticDedup: true) for MemoryDB,
 * verifying the merge rules:
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

  // ── Semantic dedup path (useSemanticDedup: true, default) ─────────────────
  // The semantic path merges when >=2 existing memories are >0.85 similar to
  // the new one. We pre-seed 2 memories with identical vectors so the cluster
  // condition is always satisfied.

  console.log("\n=== Testing opts metadata merge via semantic dedup (default path) ===\n");

  const db2 = new MemoryDB(TEST_DB, 8);
  // Vectors similar enough for semantic dedup cluster (cosine ~0.91) but
  // below the simple dedup threshold (0.95), so both seeds survive as
  // separate entries and the cluster condition (>=2 similar) is satisfied.
  const sv1 = [0.95, 0.31, 0, 0, 0, 0, 0, 0];   // cosine(sv1,sv3) ~0.91
  const sv2 = [0.95, -0.31, 0, 0, 0, 0, 0, 0];  // cosine(sv2,sv3) ~0.91
  const sv3 = [1, 0, 0, 0, 0, 0, 0, 0];          // query vector

  // Seed two existing memories so the cluster threshold (>=2 similar) is met
  await db2.store("TypeScript adds types to JavaScript", sv1, {
    source: "docs",
    tags: ["typescript", "types"],
    category: "tech",
    useSemanticDedup: false,
  });
  await db2.store("TypeScript is a typed superset of JavaScript", sv2, {
    source: "wiki",
    tags: ["typescript", "superset"],
    category: "tech",
    useSemanticDedup: false,
  });

  // Third store with useSemanticDedup: true (default) — should merge and preserve opts
  const sr = await db2.store("TypeScript brings static typing to JavaScript projects", sv3, {
    source: "blog",
    tags: ["typescript", "static-typing"],
    category: "tech",
    importanceScore: 1.8,
    useSemanticDedup: true,
  });

  assert(sr.isDuplicate, "Semantic dedup: third store triggers a merge");
  assert(sr.merged === true, "Semantic dedup: result is flagged as merged");

  const stags = sr.entry.tags;
  assert(stags.includes("types"), `Semantic merge tags include 'types' (got: ${JSON.stringify(stags)})`);
  assert(stags.includes("superset"), `Semantic merge tags include 'superset' (got: ${JSON.stringify(stags)})`);
  assert(stags.includes("static-typing"), `Semantic merge tags include 'static-typing' (got: ${JSON.stringify(stags)})`);
  assert(stags.filter((t) => t === "typescript").length === 1, "No duplicate 'typescript' tags after semantic merge");

  assert(
    (sr.entry.importance_score ?? 1.0) === 1.8,
    `Semantic merge importanceScore is 1.8 (got ${sr.entry.importance_score})`,
  );

  assert(sr.entry.source === "blog", `Semantic merge source is most recent 'blog' (got '${sr.entry.source}')`);
  assert(sr.entry.category === "tech", `Semantic merge category preserved as 'tech' (got '${sr.entry.category}')`);

  db2.close();

  // Final cleanup
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
