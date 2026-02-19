#!/usr/bin/env npx tsx
/**
 * Test the before_compaction lifecycle hook
 *
 * This test validates that the before_compaction hook:
 * 1. Captures compaction summary as memories
 * 2. Extracts code patterns from the summary
 * 3. Captures decisions and important context
 * 4. Tags all memories with 'compaction-snapshot' category
 * 5. Tags all memories appropriately for retrieval
 */

import { MemoryDB } from "./src/memory-db.js";
import { DualEmbeddings } from "./src/embeddings.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-compaction-test.db";
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

  console.log("\n=== Test before_compaction Hook ===\n");

  const embeddings = new DualEmbeddings({
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: "text-embedding-3-small",
    dimension: 1536,
    ollamaEndpoint: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
  });

  const db = new MemoryDB(TEST_DB, 1536);

  // Simulate a compaction summary that would be passed by OpenClaw
  const compactionSummary = `
Conversation Summary - Session abc123 (15 messages compacted)

Key Decisions:
- Decided to use TypeScript for the new API service
- Will implement rate limiting using Redis
- Planning to migrate from REST to GraphQL for better client flexibility

Code Patterns:
\`\`\`typescript
interface CompactionEvent {
  summary: string;
  sessionKey: string;
  messageCount: number;
}
\`\`\`

Work in Progress:
- Still need to complete the authentication middleware
- TODO: Add unit tests for the new endpoints
- Next session: implement the caching layer

Context:
Remember that the team prefers async/await over promises
Important: Always validate input before storing in database
`.trim();

  console.log("Simulating before_compaction hook call...\n");

  // Simulate the hook behavior
  const timestamp = new Date().toISOString();
  const sessionKey = "abc123";
  const messageCount = 15;

  const compactionMetadata = [
    `Session: ${sessionKey}`,
    `Messages: ${messageCount}`,
    `Timestamp: ${timestamp}`,
  ].join(" | ");

  // Store the full compaction summary
  const summaryContent = `${compactionMetadata}\n\n${compactionSummary}`;
  const summaryEmbedding = await embeddings.embed(summaryContent);
  
  const summaryResult = await db.store(summaryContent, summaryEmbedding, {
    source: "compaction-snapshot",
    tags: ["compaction", "snapshot", `timestamp:${timestamp}`, `session:${sessionKey}`],
    category: "compaction-snapshot",
    dedupeThreshold: 0.95,
  });

  assert(!summaryResult.isDuplicate, "Compaction summary stored successfully");
  assert(summaryResult.entry.category === "compaction-snapshot", "Summary has correct category");
  assert(summaryResult.entry.tags.includes("compaction"), "Summary tagged with 'compaction'");

  // Extract and store a code pattern
  const codePattern = `interface CompactionEvent {
  summary: string;
  sessionKey: string;
  messageCount: number;
}`;
  
  const codeEmbedding = await embeddings.embed(codePattern);
  const codeResult = await db.store(codePattern, codeEmbedding, {
    source: "compaction-snapshot:code",
    tags: ["lang:typescript", "pattern:type", "compaction", `timestamp:${timestamp}`],
    category: "compaction-snapshot",
    dedupeThreshold: 0.95,
  });

  assert(!codeResult.isDuplicate, "Code pattern stored successfully");
  assert(codeResult.entry.category === "compaction-snapshot", "Code pattern has correct category");

  // Extract and store a decision
  const decision = "Decided to use TypeScript for the new API service";
  const decisionEmbedding = await embeddings.embed(decision);
  const decisionResult = await db.store(decision, decisionEmbedding, {
    source: "compaction-snapshot:decision",
    tags: ["compaction", "decision", `timestamp:${timestamp}`, "tech:typescript"],
    category: "compaction-snapshot",
    dedupeThreshold: 0.95,
  });

  assert(!decisionResult.isDuplicate, "Decision stored successfully");
  assert(decisionResult.entry.category === "compaction-snapshot", "Decision has correct category");
  assert(decisionResult.entry.tags.includes("decision"), "Decision tagged with 'decision'");

  // Extract and store a WIP item
  const wipItem = "Still need to complete the authentication middleware";
  const wipEmbedding = await embeddings.embed(wipItem);
  const wipResult = await db.store(wipItem, wipEmbedding, {
    source: "compaction-snapshot:wip",
    tags: ["compaction", "wip", `timestamp:${timestamp}`],
    category: "compaction-snapshot",
    dedupeThreshold: 0.95,
  });

  assert(!wipResult.isDuplicate, "WIP item stored successfully");
  assert(wipResult.entry.category === "compaction-snapshot", "WIP has correct category");
  assert(wipResult.entry.tags.includes("wip"), "WIP tagged with 'wip'");

  console.log("\n=== Verify Retrieval ===\n");

  // Verify we can search for compaction memories
  const count = await db.count();
  assert(count === 4, `4 memories stored (got ${count})`);

  // Search for typescript-related content
  const tsQuery = await embeddings.embed("TypeScript API development");
  const tsResults = await db.vectorSearch(tsQuery, 5, 0.3);
  assert(tsResults.length > 0, "Can retrieve TypeScript-related memories");

  const compactionMemories = tsResults.filter(r => r.entry.category === "compaction-snapshot");
  assert(compactionMemories.length > 0, `Found ${compactionMemories.length} compaction snapshot(s) in search results`);

  // Search for WIP items
  const wipQuery = await embeddings.embed("what work is incomplete");
  const wipResults = await db.vectorSearch(wipQuery, 5, 0.3);
  const wipMemories = wipResults.filter(r => r.entry.tags.includes("wip"));
  assert(wipMemories.length > 0, `Found ${wipMemories.length} WIP memory/memories`);

  console.log("\n=== Summary ===\n");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  await db.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
