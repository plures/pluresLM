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

  assert(db.count() === 1, `Count is 1 after first store`);

  console.log("\n=== 3. Deduplication ===\n");

  const r2 = await db.store("I prefer TypeScript over JavaScript", vec2, {
    source: "test", tags: ["tech:typescript"], category: "preference", dedupeThreshold: 0.95,
  });
  assert(r2.isDuplicate, `Identical content detected as duplicate`);
  assert(db.count() === 1, `Count still 1 after dedup`);

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

  assert(db.count() === 5, `Count is 5 after storing more`);

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
    db.addEdge(ids[0], praxisIds[0], "related-project");
    const related = db.getRelated(ids[0], "related-project");
    assert(related.length === 1, `Graph edge links PluresDB → Praxis`);
    assert(related[0].content.includes("Praxis"), `Related content is correct`);
  } else {
    assert(false, `Could not find entries for graph edge test`);
  }

  console.log("\n=== 6. Profile ===\n");

  assert(db.getProfile() === null, `No profile initially`);

  db.setProfile({
    summary: "User prefers TypeScript, works on PluresDB and Praxis",
    facts: ["Prefers TypeScript", "Uses dark mode"],
    updated_at: Date.now(),
    capture_count: 5,
  });

  const profile = db.getProfile();
  assert(profile !== null, `Profile stored`);
  assert(profile!.facts.length === 2, `Profile has 2 facts`);
  assert(profile!.summary.includes("TypeScript"), `Profile summary correct`);

  console.log("\n=== 7. Delete ===\n");

  const beforeCount = db.count();
  const delVec = await embeddings.embed("weather in Seattle");
  const deleted = await db.deleteByQuery(delVec, 0.5);
  assert(deleted > 0, `Deleted ${deleted} memories by query`);
  assert(db.count() === beforeCount - deleted, `Count decreased by ${deleted}`);

  console.log("\n=== 8. Stats ===\n");

  const stats = db.stats();
  console.log(`   Total memories: ${stats.totalMemories}`);
  console.log(`   Categories: ${JSON.stringify(stats.categories)}`);
  console.log(`   Edges: ${stats.edgeCount}`);
  assert(stats.totalMemories > 0, `Stats show memories`);
  assert(stats.edgeCount > 0, `Stats show edges`);

  console.log("\n=== 9. Capture Counter ===\n");

  const c1 = db.incrementCaptureCount();
  const c2 = db.incrementCaptureCount();
  assert(c2 === c1 + 1, `Capture counter increments (${c1} → ${c2})`);

  console.log("\n=== 10. Time-Decay Scoring ===\n");

  // Close and reopen DB with custom decay half-life
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const dbDecay = new MemoryDB(TEST_DB, 1536, 7); // 7-day half-life

  // Store a memory
  const decayVec1 = await embeddings.embed("Important project deadline approaching");
  const stored1 = await dbDecay.store("Important project deadline approaching", decayVec1, {
    source: "test", tags: ["work"], category: "task",
  });
  assert(stored1.entry.last_accessed_at === undefined, `New memory has no last_accessed_at initially`);

  // Search immediately - should have high score
  const immediateResults = await dbDecay.vectorSearch(decayVec1, 5, 0.3);
  assert(immediateResults.length > 0, `Immediate search finds memory`);
  const immediateScore = immediateResults[0].score;
  assert(immediateResults[0].entry.last_accessed_at !== undefined, `last_accessed_at set after search`);
  console.log(`   Immediate score: ${immediateScore.toFixed(3)}`);

  // Store a permanent memory (should skip decay)
  const decayVec2 = await embeddings.embed("Core architecture principle: use microservices");
  await dbDecay.store("Core architecture principle: use microservices", decayVec2, {
    source: "test", tags: ["permanent", "architecture"], category: "principle",
  });

  // Simulate age by setting last_accessed_at to 14 days ago
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
  dbDecay.updateLastAccessedAt(stored1.entry.id, fourteenDaysAgo);

  // Search again - should have lower score due to decay (7-day half-life, 14 days = 2 half-lives = 0.25x)
  const delayedResults = await dbDecay.vectorSearch(decayVec1, 5, 0.01);
  assert(delayedResults.length > 0, `Delayed search still finds memory`);
  const delayedScore = delayedResults[0].score;
  console.log(`   Delayed score (14 days old): ${delayedScore.toFixed(3)}`);
  assert(delayedScore < immediateScore * 0.3, `Score decayed significantly (${delayedScore.toFixed(3)} < ${(immediateScore * 0.3).toFixed(3)})`);

  // Check permanent memory doesn't decay
  const permanentResults = await dbDecay.vectorSearch(decayVec2, 5, 0.3);
  assert(permanentResults.length > 0, `Permanent memory found`);
  assert(permanentResults[0].entry.tags.includes("permanent"), `Memory has permanent tag`);

  // Simulate permanent memory being old
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  if (permanentResults.length > 0) {
    dbDecay.updateLastAccessedAt(permanentResults[0].entry.id, thirtyDaysAgo);
  }
  const permanentDelayed = await dbDecay.vectorSearch(decayVec2, 5, 0.3);
  assert(permanentDelayed.length > 0, `Permanent memory found even when old`);
  console.log(`   Permanent memory score (30 days old): ${permanentDelayed[0].score.toFixed(3)}`);

  console.log("\n=== 11. Semantic Dedup v2 ===\n");

  // Create test DB for dedup
  dbDecay.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const dbDedup = new MemoryDB(TEST_DB, 1536);

  // Store similar memories that should cluster
  const similar1 = "TypeScript is a programming language that adds types to JavaScript";
  const similar2 = "TypeScript adds static typing to JavaScript programming";
  const similar3 = "TypeScript extends JavaScript by adding type definitions";
  const unrelated = "Python is a dynamically typed programming language";

  const vec_s1 = await embeddings.embed(similar1);
  const vec_s2 = await embeddings.embed(similar2);
  const vec_s3 = await embeddings.embed(similar3);
  const vec_unrelated = await embeddings.embed(unrelated);

  await dbDedup.store(similar1, vec_s1, { tags: ["typescript", "language"], category: "tech", useSemanticDedup: false });
  await dbDedup.store(similar2, vec_s2, { tags: ["typescript", "types"], category: "tech", useSemanticDedup: false });
  await dbDedup.store(similar3, vec_s3, { tags: ["javascript", "typescript"], category: "tech", useSemanticDedup: false });
  await dbDedup.store(unrelated, vec_unrelated, { tags: ["python"], category: "tech", useSemanticDedup: false });

  assert(dbDedup.count() === 4, `Stored 4 memories without semantic dedup`);

  // Test findDuplicates (dry run)
  const dryRunDuplicates = await dbDedup.findDuplicates(true);
  console.log(`   Found ${dryRunDuplicates.length} duplicate cluster(s) in dry run`);
  assert(dryRunDuplicates.length > 0, `Dry run finds duplicate clusters`);
  
  if (dryRunDuplicates.length > 0) {
    const cluster = dryRunDuplicates[0];
    assert(cluster.duplicates.length >= 1, `Cluster has at least 1 duplicate (found ${cluster.duplicates.length})`);
    assert(cluster.mergedTags.length >= 2, `Merged tags union multiple sources (${cluster.mergedTags.join(", ")})`);
    console.log(`   Cluster target: "${cluster.targetContent.slice(0, 50)}..."`);
    console.log(`   Merged tags: ${cluster.mergedTags.join(", ")}`);
  }

  const beforeDedupCount = dbDedup.count();

  // Actually perform dedup
  const actualDuplicates = await dbDedup.findDuplicates(false);
  const afterDedupCount = dbDedup.count();
  
  assert(afterDedupCount < beforeDedupCount, `Dedup reduced memory count (${beforeDedupCount} → ${afterDedupCount})`);
  assert(actualDuplicates.length === dryRunDuplicates.length, `Same number of clusters found in actual dedup`);

  console.log(`   Merged ${beforeDedupCount - afterDedupCount} duplicate memories`);

  // Test semantic dedup during store
  dbDedup.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const dbDedup2 = new MemoryDB(TEST_DB, 1536);

  const first = await dbDedup2.store(similar1, vec_s1, { tags: ["ts"], category: "tech" });
  assert(!first.isDuplicate && !first.merged, `First store is not duplicate or merged`);
  
  const second = await dbDedup2.store(similar2, vec_s2, { tags: ["types"], category: "tech" });
  assert(!second.isDuplicate && !second.merged, `Second store not merged (only 1 similar memory)`);
  
  const third = await dbDedup2.store(similar3, vec_s3, { tags: ["js"], category: "tech" });
  console.log(`   Third store result - isDuplicate: ${third.isDuplicate}, merged: ${third.merged}`);
  
  // Check merge count was incremented
  if (third.merged) {
    const mergeCount = third.entry.merge_count ?? 0;
    assert(mergeCount > 0, `Merge count incremented (${mergeCount})`);
    console.log(`   Merge count: ${mergeCount}`);
  }

  dbDedup2.close();

  console.log("\n=== 12. Dashboard Helper Methods ===\n");

  // Create a test DB with some data for dashboard methods
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const dbDashboard = new MemoryDB(TEST_DB, 1536);

  // Store some memories with tech tags across multiple days
  const testMemories = [
    { content: "Using TypeScript for type safety", tags: ["tech:typescript"], category: "project-context" },
    { content: "Fixed async/await issue in API handler", tags: ["tech:typescript", "tech:api"], category: "error-fix" },
    { content: "Decided to use React for the frontend", tags: ["tech:react"], category: "architecture-decision" },
    { content: "Working on dashboard feature", tags: ["tech:typescript"], category: "work-in-progress" },
    { content: "User prefers dark mode", tags: [], category: "conversation" },
  ];

  for (const mem of testMemories) {
    const embedding = await embeddings.embed(mem.content);
    await dbDashboard.store(mem.content, embedding, {
      source: "test",
      tags: mem.tags,
      category: mem.category,
    });
  }

  // Test getDbSize
  const dbSize = dbDashboard.getDbSize();
  assert(dbSize > 0, `getDbSize returns non-zero size: ${dbSize} bytes`);
  console.log(`   DB size (including WAL/SHM): ${dbSize} bytes`);

  // Test getCaptureRateHistory
  const captureRate = dbDashboard.getCaptureRateHistory(7);
  assert(captureRate.length === 7, `getCaptureRateHistory returns 7 days`);
  assert(captureRate.every(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(d.date)), `All entries have valid day names`);
  const totalCaptures = captureRate.reduce((sum, d) => sum + d.count, 0);
  assert(totalCaptures === 5, `Capture rate totals to 5 memories: ${totalCaptures}`);
  console.log(`   Capture rate history: ${captureRate.map(d => `${d.date}:${d.count}`).join(", ")}`);

  // Test getTopTopics
  const topTopics = dbDashboard.getTopTopics(3);
  assert(topTopics.length > 0, `getTopTopics returns topics: ${topTopics.length}`);
  assert(topTopics[0].topic === "typescript", `Top topic is typescript (got ${topTopics[0].topic})`);
  assert(topTopics[0].count === 3, `TypeScript appears 3 times (got ${topTopics[0].count})`);
  console.log(`   Top topics: ${topTopics.map(t => `${t.topic}(${t.count})`).join(", ")}`);

  // Test with malformed JSON in tags (edge case)
  // Using direct SQL to inject malformed JSON that wouldn't pass through normal store() validation
  dbDashboard.db.prepare(`INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("malformed-id", "Test with bad JSON", null, Date.now(), "test", "{invalid json", "test");
  
  const topicsWithMalformed = dbDashboard.getTopTopics(3);
  assert(topicsWithMalformed.length > 0, `getTopTopics handles malformed JSON gracefully`);
  console.log(`   Handled malformed JSON in tags column`);

  dbDashboard.close();

  // Cleanup
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
