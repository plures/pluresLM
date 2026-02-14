#!/usr/bin/env npx tsx
/**
 * Manual test for CLI dedup command
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/dedup-cli-test.db";

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 1536);

  // Create similar memories with different embeddings that are close enough
  const base = Array(1536).fill(0).map((_, i) => 0.1 + i * 0.001);
  
  // These should be similar (cosine similarity > 0.85)
  const similar1 = base.map((v, i) => v + (Math.sin(i) * 0.01));
  const similar2 = base.map((v, i) => v + (Math.cos(i) * 0.01));
  const similar3 = base.map((v, i) => v + (Math.sin(i + 1) * 0.01));

  console.log("\nStoring 3 similar memories (semantic dedup disabled)...");

  await db.store("TypeScript is a programming language", similar1, {
    tags: ["typescript", "language"],
    category: "tech",
    useSemanticDedup: false,
  });

  await db.store("TypeScript is a typed programming language", similar2, {
    tags: ["typescript", "types"],
    category: "tech",
    useSemanticDedup: false,
  });

  await db.store("TypeScript adds types to JavaScript", similar3, {
    tags: ["typescript", "javascript"],
    category: "tech",
    useSemanticDedup: false,
  });

  console.log(`Created ${db.count()} memories\n`);

  // Test dry run
  console.log("=== Dry Run ===\n");
  const dryRun = await db.findDuplicates(true);
  console.log(`Found ${dryRun.length} duplicate cluster(s):\n`);
  
  if (dryRun.length > 0) {
    for (let i = 0; i < dryRun.length; i++) {
      const dup = dryRun[i];
      console.log(`Cluster ${i + 1}:`);
      console.log(`  Target: ${dup.targetId}`);
      console.log(`  Content: "${dup.targetContent}..."`);
      console.log(`  Duplicates (${dup.duplicates.length}):`);
      dup.duplicates.forEach(d => {
        console.log(`    - ${d.id} (similarity: ${(d.similarity * 100).toFixed(1)}%)`);
      });
      console.log(`  Merged tags: ${dup.mergedTags.join(", ")}`);
      console.log();
    }
  } else {
    console.log("  (No clusters found - embeddings may not be similar enough)");
  }

  const beforeCount = db.count();
  console.log(`Count before dedup: ${beforeCount}`);

  // Test actual dedup
  console.log("\n=== Actual Dedup ===\n");
  const actual = await db.findDuplicates(false);
  const afterCount = db.count();
  console.log(`Merged ${actual.length} cluster(s)`);
  console.log(`Count after dedup: ${afterCount}`);
  console.log(`Memories removed: ${beforeCount - afterCount}\n`);

  db.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
