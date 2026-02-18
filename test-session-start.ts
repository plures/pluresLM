#!/usr/bin/env npx tsx
/**
 * Test for session-start context injection feature (unit test without embeddings)
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-session-start-test.db";
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

// Helper to create a fake embedding
function fakeEmbedding(dim: number = 1536): number[] {
  return Array(dim).fill(0).map(() => Math.random());
}

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log("\n=== Session-Start Context Injection Test ===\n");

  const db = new MemoryDB(TEST_DB, 1536);

  // Store some test memories with different categories
  const testMemories = [
    { content: "User prefers TypeScript over JavaScript", category: "preference" },
    { content: "Decided to use PostgreSQL for the project database", category: "decision" },
    { content: "Working on implementing authentication feature", category: "work-in-progress" },
    { content: "Explicitly noted: always use async/await", category: "explicit" },
    { content: "Had a conversation about weather", category: "conversation" },
    { content: "User prefers dark mode UI", category: "preference" },
    { content: "Decided against using MongoDB", category: "decision" },
    { content: "Need to refactor the user service", category: "work-in-progress" },
    { content: "Error handling should use custom error classes", category: "explicit" },
    { content: "Discussed lunch plans", category: "conversation" },
  ];

  console.log("1. Storing test memories...\n");
  
  for (const mem of testMemories) {
    const embedding = fakeEmbedding();
    await db.store(mem.content, embedding, {
      source: "test",
      category: mem.category,
      tags: [],
    });
    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const totalCount = await db.count();
  assert(totalCount === testMemories.length, `Stored ${totalCount} memories`);

  console.log("\n2. Testing getMemoriesByCategories with priority categories...\n");

  const priorityCategories = ["decision", "preference", "explicit", "work-in-progress"];
  const priorityMemories = await db.getMemoriesByCategories(priorityCategories, 6, 0.7);

  assert(priorityMemories.length > 0, `Retrieved ${priorityMemories.length} priority memories`);
  assert(priorityMemories.length <= 6, `Respects limit (got ${priorityMemories.length}, max 6)`);

  // All returned memories should be from priority categories
  const allFromPriority = priorityMemories.every(m => priorityCategories.includes(m.category));
  assert(allFromPriority, "All returned memories are from priority categories");

  // Should NOT include conversation memories
  const hasConversation = priorityMemories.some(m => m.category === "conversation");
  assert(!hasConversation, "Does not include conversation memories");

  // Check that embeddings are returned
  assert(priorityMemories.every(m => Array.isArray(m.embedding)), "Embeddings are included");
  assert(priorityMemories.every(m => m.embedding.length === 1536), "Embeddings have correct dimension");

  console.log("\n3. Testing limit enforcement...\n");

  const all8 = await db.getMemoriesByCategories(priorityCategories, 8, 0.7);
  assert(all8.length === 8, `Retrieves correct number (got ${all8.length}, expected 8)`);

  const all20 = await db.getMemoriesByCategories(priorityCategories, 20, 0.7);
  // We only have 8 memories in priority categories
  assert(all20.length === 8, `Does not exceed available (got ${all20.length}, expected 8)`);

  console.log("\n4. Testing recency bias...\n");

  // Add a new decision with a delay
  await new Promise(resolve => setTimeout(resolve, 10));
  const recentDecision = "Just decided to use Redis for caching";
  await db.store(recentDecision, fakeEmbedding(), {
    source: "test",
    category: "decision",
    tags: [],
  });

  // With high recency bias, recent memory should appear more often
  let recentAppearances = 0;
  const trials = 20;
  
  for (let i = 0; i < trials; i++) {
    const results = await db.getMemoriesByCategories(["decision"], 2, 0.9);
    if (results.some(r => r.content === recentDecision)) {
      recentAppearances++;
    }
  }

  // With high recency bias (0.9), recent memory should appear in most trials
  assert(recentAppearances >= trials * 0.5, `Recent memory appears frequently (${recentAppearances}/${trials} trials with recency bias 0.9)`);

  console.log("\n5. Testing empty categories...\n");

  const emptyResults = await db.getMemoriesByCategories(["nonexistent-category"], 5, 0.7);
  assert(emptyResults.length === 0, "Returns empty array for non-existent categories");

  const emptyCategories = await db.getMemoriesByCategories([], 5, 0.7);
  assert(emptyCategories.length === 0, "Returns empty array for empty category list");

  console.log("\n6. Testing with profile...\n");

  await db.setProfile({
    summary: "User is a TypeScript developer working on a full-stack web application",
    facts: ["Prefers TypeScript", "Uses PostgreSQL", "Likes dark mode"],
    updated_at: Date.now(),
    capture_count: 10,
  });

  const profile = await db.getProfile();
  assert(profile !== null, "Profile was stored");
  assert(profile?.summary.includes("TypeScript"), "Profile summary contains TypeScript");
  assert(profile?.facts.length === 3, "Profile has 3 facts");

  console.log("\n7. Testing category distribution...\n");

  const stats = await db.stats();
  console.log(`   Categories: ${JSON.stringify(stats.categories)}`);
  assert(stats.categories["decision"] === 3, "Has 3 decision memories");
  assert(stats.categories["preference"] === 2, "Has 2 preference memories");
  assert(stats.categories["work-in-progress"] === 2, "Has 2 work-in-progress memories");
  assert(stats.categories["explicit"] === 2, "Has 2 explicit memories");
  assert(stats.categories["conversation"] === 2, "Has 2 conversation memories");

  console.log("\n=== Summary ===\n");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  await db.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
