#!/usr/bin/env npx tsx
/**
 * Daily Summary Feature Test
 * 
 * Tests the generateDailySummary and getDailySummaries methods
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/superlocalmemory-daily-summary-test.db";
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

  console.log("\n=== Daily Summary Feature Test ===\n");

  const db = new MemoryDB(TEST_DB, 1536);

  // Create some mock memories for different dates
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  console.log(`\n=== 1. Creating Test Memories ===\n`);
  console.log(`Today: ${todayStr}`);
  console.log(`Yesterday: ${yesterdayStr}`);

  // Helper to create memory with specific timestamp
  async function createMemoryWithTimestamp(content: string, category: string, dateStr: string) {
    const timestamp = new Date(dateStr + 'T12:00:00.000Z').getTime();
    const embedding = Array(1536).fill(0).map(() => Math.random());
    
    // Directly insert with custom timestamp
    const id = crypto.randomUUID();
    db['db'].prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, merge_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(id, content, db['encodeEmbedding'](embedding), timestamp, 'test', JSON.stringify([]), category);
  }

  // Create memories for today
  await createMemoryWithTimestamp(
    "Decided to use TypeScript for the new project",
    "decision",
    todayStr
  );
  
  await createMemoryWithTimestamp(
    "Working on superlocalmemory daily summary feature",
    "project",
    todayStr
  );
  
  await createMemoryWithTimestamp(
    "Need to add tests for the new feature",
    "work-in-progress",
    todayStr
  );

  await createMemoryWithTimestamp(
    "Prefer using async/await over callbacks",
    "preference",
    todayStr
  );

  // Create memories for yesterday
  await createMemoryWithTimestamp(
    "Implemented vector search optimization",
    "project",
    yesterdayStr
  );
  
  await createMemoryWithTimestamp(
    "Fixed bug in embedding calculation",
    "error-fix",
    yesterdayStr
  );

  const totalCount = await db.count();
  assert(totalCount === 6, `Created 6 test memories (got ${totalCount})`);

  console.log(`\n=== 2. Generate Daily Summary for Today ===\n`);

  const todaySummary = await db.generateDailySummary(todayStr);
  
  assert(todaySummary.date === todayStr, `Summary date matches (${todaySummary.date})`);
  assert(todaySummary.memoryCount === 4, `Today has 4 memories (got ${todaySummary.memoryCount})`);
  assert(Object.keys(todaySummary.categories).length === 4, `Today has 4 categories (got ${Object.keys(todaySummary.categories).length})`);
  assert(todaySummary.categories.decision === 1, `Decision category has 1 memory`);
  assert(todaySummary.categories.project === 1, `Project category has 1 memory`);
  assert(todaySummary.categories['work-in-progress'] === 1, `WIP category has 1 memory`);
  assert(todaySummary.categories.preference === 1, `Preference category has 1 memory`);
  assert(todaySummary.summary.includes('# Daily Summary'), `Summary includes title`);
  assert(todaySummary.summary.includes('## Decision'), `Summary includes Decision section`);
  assert(todaySummary.summary.includes('TypeScript'), `Summary includes content`);

  console.log(`\n=== 3. Generate Daily Summary for Yesterday ===\n`);

  const yesterdaySummary = await db.generateDailySummary(yesterdayStr);
  
  assert(yesterdaySummary.date === yesterdayStr, `Summary date matches (${yesterdaySummary.date})`);
  assert(yesterdaySummary.memoryCount === 2, `Yesterday has 2 memories (got ${yesterdaySummary.memoryCount})`);
  assert(Object.keys(yesterdaySummary.categories).length === 2, `Yesterday has 2 categories`);
  assert(yesterdaySummary.categories.project === 1, `Project category has 1 memory`);
  assert(yesterdaySummary.categories['error-fix'] === 1, `Error-fix category has 1 memory`);

  console.log(`\n=== 4. Get Daily Summaries ===\n`);

  const summaries = await db.getDailySummaries(7);
  
  assert(summaries.length === 2, `Retrieved 2 summaries (got ${summaries.length})`);
  
  // Check that we have both dates
  const dates = summaries.map(s => s.date).sort();
  assert(dates.includes(todayStr), `Summaries include today's date`);
  assert(dates.includes(yesterdayStr), `Summaries include yesterday's date`);
  
  // Since summaries are ordered by created_at DESC (when they were generated),
  // and we generated today's first then yesterday's, yesterday's will appear first
  assert(summaries[0].date === yesterdayStr, `Most recent generated summary is yesterday's`);
  assert(summaries[1].date === todayStr, `Second summary is today's`);

  console.log(`\n=== 5. Empty Date Test ===\n`);

  const futureDate = new Date(today);
  futureDate.setDate(futureDate.getDate() + 10);
  const futureDateStr = futureDate.toISOString().split('T')[0];

  const emptySummary = await db.generateDailySummary(futureDateStr);
  assert(emptySummary.memoryCount === 0, `Future date has no memories`);
  assert(Object.keys(emptySummary.categories).length === 0, `Future date has no categories`);

  console.log(`\n=== 6. Verify Summary Stored as Memory (excluding empty) ===\n`);

  // Check that summaries are stored with correct category (empty summary should NOT be stored)
  const allMemories = await db.count();
  assert(allMemories === 8, `Total includes 6 original + 2 summaries (empty not stored) (got ${allMemories})`);

  // Use prepared statement to query for daily summaries
  const summaryMemories = db['db'].prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE category = 'daily-summary'`
  ).get() as { cnt: number };
  
  assert(summaryMemories.cnt === 2, `2 summary memories stored (empty excluded) (got ${summaryMemories.cnt})`);

  console.log(`\n=== 7. Duplicate Daily Summary Generation ===\n`);

  // Generate today's summary again - should replace the existing one, not create a duplicate
  const beforeDuplicate = db['db'].prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE category = 'daily-summary'`
  ).get() as { cnt: number };
  assert(beforeDuplicate.cnt === 2, `Precondition: 2 summary memories before duplicate generation (got ${beforeDuplicate.cnt})`);

  const duplicateSummary = await db.generateDailySummary(todayStr);
  assert(duplicateSummary.memoryCount === 4, `Duplicate generation returns correct count`);

  const afterDuplicate = db['db'].prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE category = 'daily-summary'`
  ).get() as { cnt: number };
  assert(afterDuplicate.cnt === 2, `Duplicate generation does not create extra summaries (still ${afterDuplicate.cnt})`);

  // Verify the summary was updated (created_at should be more recent)
  assert(duplicateSummary.created_at > todaySummary.created_at, `Duplicate summary has newer timestamp`);

  console.log(`\n=== Test Summary ===\n`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  await db.close();

  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
