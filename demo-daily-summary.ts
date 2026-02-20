#!/usr/bin/env npx tsx
/**
 * Daily Summary Demo
 * 
 * Demonstrates the daily summary feature with sample data
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const TEST_DB = "/tmp/superlocalmemory-demo.db";
const OUTPUT_DIR = "/tmp/daily-summaries";

async function main() {
  // Cleanup
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║      Daily Summary Feature Demonstration        ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const db = new MemoryDB(TEST_DB, 1536);

  // Create some realistic memories for today
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  console.log(`📅 Date: ${todayStr}\n`);
  console.log("🔨 Creating sample memories...\n");

  // Helper to create memory with specific timestamp and offset
  async function createMemoryAtTime(content: string, category: string, hourOffset: number) {
    const timestamp = new Date(todayStr + 'T00:00:00.000Z').getTime() + (hourOffset * 60 * 60 * 1000);
    const embedding = Array(1536).fill(0).map(() => Math.random());
    
    const id = crypto.randomUUID();
    db['db'].prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, merge_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(id, content, db['encodeEmbedding'](embedding), timestamp, 'demo', JSON.stringify([]), category);
    
    console.log(`  ✓ [${category}] ${content.substring(0, 60)}...`);
  }

  // Morning - Decisions and Planning
  await createMemoryAtTime(
    "Decided to implement automatic daily summaries to reduce token costs in pre-compaction flushes. The current manual approach of writing 3-13KB files is inefficient.",
    "decision",
    9
  );

  await createMemoryAtTime(
    "Working on superlocalmemory plugin to add daily summary generation from captured memories. This will categorize and summarize memories automatically.",
    "project",
    9.5
  );

  // Mid-day - Work and Code Patterns
  await createMemoryAtTime(
    "Implemented generateDailySummary() method that queries memories by date range, groups by category, and generates structured markdown output with timestamps.",
    "code-pattern",
    11
  );

  await createMemoryAtTime(
    "Added getDailySummaries() to retrieve summaries for last N days. Returns array of DailySummary objects with date, content, and category breakdown.",
    "code-pattern",
    11.5
  );

  await createMemoryAtTime(
    "Need to add comprehensive tests for edge cases: empty dates, timezone handling, and category ordering in summaries.",
    "work-in-progress",
    12
  );

  // Afternoon - Bug Fixes and Improvements
  await createMemoryAtTime(
    "Fixed issue with PluresDB backend compatibility - needed to add async wrappers for all statement operations. All tests now pass.",
    "error-fix",
    14
  );

  await createMemoryAtTime(
    "Architecture decision: Store summaries as memories with category 'daily-summary' and tag 'daily-summary:YYYY-MM-DD' for easy retrieval and searchability.",
    "architecture-decision",
    14.5
  );

  // Personal preferences
  await createMemoryAtTime(
    "Prefer using explicit category ordering in summaries (decision > project > WIP > error-fix) rather than alphabetical, as it surfaces important info first.",
    "preference",
    15
  );

  // Late afternoon - More work
  await createMemoryAtTime(
    "Added two new tools: superlocalmemory_generate_daily_summary and superlocalmemory_get_daily_summaries for agent consumption.",
    "project",
    16
  );

  await createMemoryAtTime(
    "Still need to add optional file output to memory/YYYY-MM-DD.md for backward compatibility during transition period.",
    "work-in-progress",
    16.5
  );

  console.log(`\n✅ Created ${await db.count()} memories\n`);

  console.log("─".repeat(52));
  console.log("\n📊 Generating Daily Summary...\n");

  const summary = await db.generateDailySummary(todayStr);

  console.log(`✓ Generated summary for ${summary.date}`);
  console.log(`✓ Captured ${summary.memoryCount} memories`);
  console.log(`✓ Across ${Object.keys(summary.categories).length} categories:\n`);

  for (const [cat, count] of Object.entries(summary.categories)) {
    console.log(`   • ${cat}: ${count}`);
  }

  console.log("\n─".repeat(52));
  console.log("\n📄 Summary Preview:\n");
  console.log(summary.summary);

  console.log("\n─".repeat(52));
  console.log("\n💾 Saving to file...\n");

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write summary to file
  const outputPath = path.join(OUTPUT_DIR, `${todayStr}.md`);
  writeFileSync(outputPath, summary.summary, 'utf-8');
  console.log(`✓ Saved to: ${outputPath}\n`);

  console.log("─".repeat(52));
  console.log("\n🔍 Retrieving Recent Summaries...\n");

  const summaries = await db.getDailySummaries(7);
  console.log(`Found ${summaries.length} summaries in the last 7 days:\n`);

  for (const s of summaries) {
    console.log(`📅 ${s.date}: ${s.memoryCount} memories`);
  }

  console.log("\n─".repeat(52));
  console.log("\n✨ Demo complete!\n");

  await db.close();

  console.log("Summary file location:", outputPath);
  console.log("You can view it with: cat", outputPath, "\n");
}

main().catch(console.error);
