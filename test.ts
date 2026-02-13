#!/usr/bin/env npx tsx
/**
 * Superlocalmemory integration test
 *
 * Tests: DB init, store, dedup, vector search, graph edges, profile, delete
 * Uses OpenAI embeddings (primary) with Ollama fallback.
 */

import { MemoryDB } from "./src/memory-db.js";
import { DualEmbeddings } from "./src/embeddings.js";
import { unlinkSync, existsSync, rmSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-test.db";
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

  console.log("\n=== 1. Embedding Provider ===\n");

  const embeddings = new DualEmbeddings({
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: "text-embedding-3-small",
    dimension: 1536,
    ollamaEndpoint: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
  });

  const vec1 = await embeddings.embed("TypeScript is a typed superset of JavaScript");
  assert(vec1.length === 1536, `Embedding returns correct dimension (got ${vec1.length})`);
  assert(typeof vec1[0] === "number", `Embedding values are numbers`);

  const vec2 = await embeddings.embed("TypeScript is a typed superset of JavaScript");
  // Same input should give very similar embeddings
  const dot = vec1.reduce((s, v, i) => s + v * vec2[i], 0);
  const norm1 = Math.sqrt(vec1.reduce((s, v) => s + v * v, 0));
  const norm2 = Math.sqrt(vec2.reduce((s, v) => s + v * v, 0));
  const selfSim = dot / (norm1 * norm2);
  assert(selfSim > 0.99, `Same text self-similarity: ${selfSim.toFixed(4)}`);

  console.log("\n=== 2. Database Init & Store ===\n");

  const db = new MemoryDB(TEST_DB, 1536);

  const r1 = await db.store("I prefer TypeScript over JavaScript", vec1, {
    source: "test", tags: ["tech:typescript"], category: "preference",
  });
  assert(!r1.isDuplicate, `First store is not duplicate`);
  assert(r1.entry.id.length === 36, `Entry has UUID id`);
  assert(r1.entry.category === "preference", `Category preserved`);

  assert(await db.count() === 1, `Count is 1 after first store`);

  console.log("\n=== 3. Deduplication ===\n");

  const r2 = await db.store("I prefer TypeScript over JavaScript", vec2, {
    source: "test", tags: ["tech:typescript"], category: "preference", dedupeThreshold: 0.95,
  });
  assert(r2.isDuplicate, `Identical content detected as duplicate`);
  assert(await db.count() === 1, `Count still 1 after dedup`);

  console.log("\n=== 4. Vector Search ===\n");

  // Store a few more memories with different topics
  const topics = [
    "PluresDB is a local-first graph database built with Rust",
    "The weather in Seattle is rainy most of the year",
    "Praxis is a typed application logic framework for Svelte",
    "My favorite color is blue and I like dark mode",
  ];

  for (const t of topics) {
    const vec = await embeddings.embed(t);
    await db.store(t, vec, { source: "test", category: "conversation" });
  }

  assert(await db.count() === 5, `Count is 5 after storing more`);

  // Search for something related to databases
  const searchVec = await embeddings.embed("What databases do we use?");
  const results = await db.vectorSearch(searchVec, 3, 0.3);
  assert(results.length > 0, `Vector search returns results`);
  assert(results[0].score > 0.3, `Top result has reasonable score: ${results[0].score.toFixed(3)}`);
  console.log(`   Top result: "${results[0].entry.content.slice(0, 60)}..." (${(results[0].score * 100).toFixed(1)}%)`);

  // Search for weather
  const weatherVec = await embeddings.embed("What's the weather like?");
  const weatherResults = await db.vectorSearch(weatherVec, 3, 0.3);
  assert(
    weatherResults.some((r) => r.entry.content.includes("weather")),
    `Weather search finds weather memory`,
  );

  console.log("\n=== 5. Graph Edges ===\n");

  const ids = (await db.vectorSearch(await embeddings.embed("PluresDB"), 1, 0.3)).map((r) => r.entry.id);
  const praxisIds = (await db.vectorSearch(await embeddings.embed("Praxis framework"), 1, 0.3)).map((r) => r.entry.id);

  if (ids.length > 0 && praxisIds.length > 0) {
    await db.addEdge(ids[0], praxisIds[0], "related-project");
    const related = await db.getRelated(ids[0], "related-project");
    assert(related.length === 1, `Graph edge links PluresDB → Praxis`);
    assert(related[0].content.includes("Praxis"), `Related content is correct`);
  } else {
    assert(false, `Could not find entries for graph edge test`);
  }

  console.log("\n=== 6. Profile ===\n");

  assert(await db.getProfile() === null, `No profile initially`);

  await db.setProfile({
    summary: "User prefers TypeScript, works on PluresDB and Praxis",
    facts: ["Prefers TypeScript", "Uses dark mode"],
    updated_at: Date.now(),
    capture_count: 5,
  });

  const profile = await db.getProfile();
  assert(profile !== null, `Profile stored`);
  assert(profile!.facts.length === 2, `Profile has 2 facts`);
  assert(profile!.summary.includes("TypeScript"), `Profile summary correct`);

  console.log("\n=== 7. Delete ===\n");

  const beforeCount = await db.count();
  const delVec = await embeddings.embed("weather in Seattle");
  const deleted = await db.deleteByQuery(delVec, 0.5);
  assert(deleted > 0, `Deleted ${deleted} memories by query`);
  assert(await db.count() === beforeCount - deleted, `Count decreased by ${deleted}`);

  console.log("\n=== 8. Stats ===\n");

  const stats = await db.stats();
  console.log(`   Total memories: ${stats.totalMemories}`);
  console.log(`   Categories: ${JSON.stringify(stats.categories)}`);
  console.log(`   Edges: ${stats.edgeCount}`);
  assert(stats.totalMemories > 0, `Stats show memories`);
  assert(stats.edgeCount > 0, `Stats show edges`);

  console.log("\n=== 9. Capture Counter ===\n");

  const c1 = await db.incrementCaptureCount();
  const c2 = await db.incrementCaptureCount();
  assert(c2 === c1 + 1, `Capture counter increments (${c1} → ${c2})`);

  // Cleanup
  await db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
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
