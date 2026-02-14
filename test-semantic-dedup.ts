#!/usr/bin/env npx tsx
/**
 * Test semantic dedup during store
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/dedup-store-test.db";

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 1536);

  // Create embeddings that are similar but not identical (0.85-0.94 range)
  const base = Array(1536).fill(0).map((_, i) => Math.sin(i * 0.01));
  const similar1 = base.map((v, i) => v + (Math.random() * 0.15 - 0.075));
  const similar2 = base.map((v, i) => v + (Math.random() * 0.15 - 0.075));
  const similar3 = base.map((v, i) => v + (Math.random() * 0.15 - 0.075));
  const different = Array(1536).fill(0).map((_, i) => Math.cos(i * 0.01) * 2);

  console.log("\n=== Testing Semantic Dedup During Store ===\n");

  // Store first memory (with semantic dedup enabled)
  const r1 = await db.store("TypeScript is a programming language with types", similar1, {
    tags: ["typescript"],
    category: "tech",
    useSemanticDedup: true,
  });
  console.log(`1. First store: isDuplicate=${r1.isDuplicate}, merged=${r1.merged ?? false}, merge_count=${r1.entry.merge_count}`);

  // Store second memory (should not merge yet - only 1 similar)
  const r2 = await db.store("TypeScript adds static typing to JavaScript", similar2, {
    tags: ["types"],
    category: "tech",
    useSemanticDedup: true,
  });
  console.log(`2. Second store: isDuplicate=${r2.isDuplicate}, merged=${r2.merged ?? false}, merge_count=${r2.entry.merge_count}`);
  console.log(`   Count: ${db.count()}`);

  // Store third memory (should merge - 2+ similar memories)
  const r3 = await db.store("TypeScript is JavaScript with type definitions", similar3, {
    tags: ["javascript"],
    category: "tech",
    useSemanticDedup: true,
  });
  console.log(`3. Third store: isDuplicate=${r3.isDuplicate}, merged=${r3.merged ?? false}, merge_count=${r3.entry.merge_count}`);
  console.log(`   Count: ${db.count()}`);
  
  if (r3.merged) {
    console.log(`   ✅ Semantic dedup worked! Merged into: ${r3.updatedId}`);
    console.log(`   Tags: ${r3.entry.tags.join(", ")}`);
  } else {
    console.log(`   ℹ️ No merge (embeddings may not be similar enough)`);
  }

  // Store a different memory (should not merge)
  const r4 = await db.store("Python is a dynamically typed language", different, {
    tags: ["python"],
    category: "tech",
    useSemanticDedup: true,
  });
  console.log(`4. Different topic: isDuplicate=${r4.isDuplicate}, merged=${r4.merged ?? false}`);
  console.log(`   Count: ${db.count()}`);

  console.log("\n=== Testing with Semantic Dedup Disabled ===\n");

  // Clean and test without semantic dedup
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
  
  const db2 = new MemoryDB(TEST_DB, 1536);

  const s1 = await db2.store("TypeScript is a programming language with types", similar1, {
    tags: ["typescript"],
    category: "tech",
    useSemanticDedup: false,
  });
  console.log(`1. First store: merged=${s1.merged ?? false}`);

  const s2 = await db2.store("TypeScript adds static typing to JavaScript", similar2, {
    tags: ["types"],
    category: "tech",
    useSemanticDedup: false,
  });
  console.log(`2. Second store: merged=${s2.merged ?? false}`);

  const s3 = await db2.store("TypeScript is JavaScript with type definitions", similar3, {
    tags: ["javascript"],
    category: "tech",
    useSemanticDedup: false,
  });
  console.log(`3. Third store: merged=${s3.merged ?? false}`);
  console.log(`   Count: ${db2.count()}`);

  console.log("\n");

  db2.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
