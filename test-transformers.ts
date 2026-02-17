#!/usr/bin/env npx tsx
/**
 * Test for Transformers.js embeddings
 *
 * Tests zero-config setup with Transformers.js as default provider
 */

import { TransformersEmbeddings, DualEmbeddings } from "./src/embeddings.js";
import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-transformers-test.db";
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

  console.log("\n=== 1. TransformersEmbeddings (Zero Config) ===\n");

  const start1 = Date.now();
  const embeddings = new TransformersEmbeddings();
  
  const vec1 = await embeddings.embed("TypeScript is a typed superset of JavaScript");
  const elapsed1 = Date.now() - start1;
  
  console.log(`First embedding took ${elapsed1}ms (includes model download)`);
  assert(vec1.length === 384, `Embedding returns correct dimension (got ${vec1.length})`);
  assert(typeof vec1[0] === "number", `Embedding values are numbers`);
  assert(Math.abs(vec1[0]) <= 1, `Embeddings are normalized (value: ${vec1[0].toFixed(4)})`);

  console.log("\n=== 2. Embedding Consistency ===\n");

  const start2 = Date.now();
  const vec2 = await embeddings.embed("TypeScript is a typed superset of JavaScript");
  const elapsed2 = Date.now() - start2;
  
  console.log(`Second embedding took ${elapsed2}ms (model cached)`);
  assert(elapsed2 < 5000, `Cached embedding is fast (${elapsed2}ms < 5000ms)`);
  
  // Same input should give identical embeddings
  const dot = vec1.reduce((s, v, i) => s + v * vec2[i], 0);
  const norm1 = Math.sqrt(vec1.reduce((s, v) => s + v * v, 0));
  const norm2 = Math.sqrt(vec2.reduce((s, v) => s + v * v, 0));
  const selfSim = dot / (norm1 * norm2);
  assert(selfSim > 0.999, `Same text self-similarity: ${selfSim.toFixed(6)}`);

  console.log("\n=== 3. Semantic Similarity ===\n");

  const vec3 = await embeddings.embed("JavaScript is dynamically typed");
  const sim13 = vec1.reduce((s, v, i) => s + v * vec3[i], 0) / (norm1 * Math.sqrt(vec3.reduce((s, v) => s + v * v, 0)));
  console.log(`Related texts similarity: ${sim13.toFixed(4)}`);
  assert(sim13 > 0.5, `Related texts have high similarity (${sim13.toFixed(4)} > 0.5)`);

  const vec4 = await embeddings.embed("The weather is sunny today");
  const norm4 = Math.sqrt(vec4.reduce((s, v) => s + v * v, 0));
  const sim14 = vec1.reduce((s, v, i) => s + v * vec4[i], 0) / (norm1 * norm4);
  console.log(`Unrelated texts similarity: ${sim14.toFixed(4)}`);
  assert(sim14 < 0.5, `Unrelated texts have low similarity (${sim14.toFixed(4)} < 0.5)`);

  console.log("\n=== 4. DualEmbeddings with Transformers.js (Zero Config) ===\n");

  const dualEmbeddings = new DualEmbeddings({
    provider: "transformers",
  });
  
  const vec5 = await dualEmbeddings.embed("Testing default provider");
  assert(vec5.length === 384, `DualEmbeddings defaults to 384 dimensions (got ${vec5.length})`);

  console.log("\n=== 5. Database Integration ===\n");

  const db = new MemoryDB(TEST_DB, 384);
  
  const r1 = await db.store("I prefer TypeScript over JavaScript", vec1, {
    source: "test", tags: ["tech:typescript"], category: "preference",
  });
  assert(!r1.isDuplicate, `First store is not duplicate`);
  assert(r1.entry.id.length === 36, `Entry has UUID id`);

  // Vector search
  const searchVec = await embeddings.embed("typescript");
  const results = await db.vectorSearch(searchVec, 3, 0.3);
  assert(results.length > 0, `Vector search returns results`);
  assert(results[0].score > 0.3, `Top result has reasonable score: ${results[0].score.toFixed(3)}`);

  await db.close();

  console.log("\n=== Test Summary ===\n");
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ Test failed with error:`, err);
  process.exit(1);
});
