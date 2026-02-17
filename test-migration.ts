#!/usr/bin/env npx tsx
/**
 * Migration tool test (parsing only)
 * 
 * Tests the file parsing functionality without requiring API access
 */

import { parseMemoryMd, parseDailyFile, parseDailyDirectory } from "./src/migration.js";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";

const TEST_DIR = "/tmp/superlocalmemory-test-files";
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
  // Cleanup and setup
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  console.log("\n=== 1. File Parsing: MEMORY.md ===\n");

  // Create test MEMORY.md file
  const memoryMdPath = path.join(TEST_DIR, "MEMORY.md");
  const memoryMdContent = `# User Preferences

- I prefer TypeScript over JavaScript
- I like dark mode themes
- My favorite editor is VS Code

# Project Context

Working on a memory migration tool for superlocalmemory.

# Technologies

- Using Node.js and TypeScript
- SQLite for storage
`;

  writeFileSync(memoryMdPath, memoryMdContent);

  const memoryMdItems = parseMemoryMd(memoryMdPath);
  assert(memoryMdItems.length > 0, `Parsed MEMORY.md into ${memoryMdItems.length} items`);
  assert(
    memoryMdItems.some(m => m.content.includes("TypeScript")),
    "Found TypeScript preference"
  );
  assert(
    memoryMdItems.every(m => m.priority === "critical"),
    "All MEMORY.md items have critical priority"
  );
  assert(
    memoryMdItems.every(m => m.category === "migrated-memory"),
    "All items have migrated-memory category"
  );
  assert(
    memoryMdItems.some(m => m.tags.includes("source:memory.md")),
    "Items have source:memory.md tag"
  );
  assert(
    memoryMdItems.some(m => m.tags.includes("section:user-preferences")),
    "Items have section tags from headers"
  );

  console.log("\n=== 2. File Parsing: Daily Files ===\n");

  // Create test daily file
  const dailyFilePath = path.join(TEST_DIR, "2024-01-15.md");
  const dailyContent = `Today I worked on the migration tool implementation.

Made good progress on file parsing and CLI commands.

Need to add verification logic next.`;

  writeFileSync(dailyFilePath, dailyContent);

  const dailyItems = parseDailyFile(dailyFilePath);
  assert(dailyItems.length === 3, `Parsed daily file into ${dailyItems.length} items`);
  assert(
    dailyItems.every(m => m.category === "daily-summary"),
    "All daily items have daily-summary category"
  );
  assert(
    dailyItems.some(m => m.tags.includes("date:2024-01-15")),
    "Daily items have date tag"
  );
  assert(
    dailyItems.every(m => m.priority === "normal"),
    "Daily items have normal priority"
  );
  assert(
    dailyItems.every(m => m.source === "migration:2024-01-15"),
    "Daily items have correct source"
  );

  console.log("\n=== 3. Directory Parsing ===\n");

  // Create another daily file
  const dailyFilePath2 = path.join(TEST_DIR, "2024-01-16.md");
  writeFileSync(dailyFilePath2, "Continued work on migration.\n\nAdded verification command.");

  const dailyFilePath3 = path.join(TEST_DIR, "2024-01-17.md");
  writeFileSync(dailyFilePath3, "Testing the migration tool with various file formats.");

  const dirItems = parseDailyDirectory(TEST_DIR);
  assert(dirItems.length >= dailyItems.length, `Parsed directory: ${dirItems.length} items from multiple files`);
  assert(
    dirItems.some(m => m.tags.includes("date:2024-01-16")),
    "Found items from second daily file"
  );
  assert(
    dirItems.some(m => m.tags.includes("date:2024-01-17")),
    "Found items from third daily file"
  );

  console.log("\n=== 4. Edge Cases ===\n");

  // Test with empty sections
  const emptyPath = path.join(TEST_DIR, "empty.md");
  writeFileSync(emptyPath, "\n\n\n");
  const emptyItems = parseMemoryMd(emptyPath);
  assert(emptyItems.length === 0, "Empty file returns no items");

  // Test with very short content (should be filtered)
  const shortPath = path.join(TEST_DIR, "short.md");
  writeFileSync(shortPath, "- hi\n- ok\n- yes");
  const shortItems = parseMemoryMd(shortPath);
  assert(shortItems.length === 0, "Very short items are filtered out");

  // Test with substantial content
  const substantialPath = path.join(TEST_DIR, "substantial.md");
  writeFileSync(substantialPath, "- This is a substantial piece of content that should be captured\n- Another important memory item");
  const substantialItems = parseMemoryMd(substantialPath);
  assert(substantialItems.length === 2, "Substantial items are captured");

  console.log("\n=== 5. File Structure Validation ===\n");

  // Verify structure of parsed memories
  const sampleMemory = memoryMdItems[0];
  assert(typeof sampleMemory.content === "string", "Memory has content string");
  assert(Array.isArray(sampleMemory.tags), "Memory has tags array");
  assert(typeof sampleMemory.category === "string", "Memory has category string");
  assert(typeof sampleMemory.priority === "string", "Memory has priority string");
  assert(typeof sampleMemory.source === "string", "Memory has source string");
  assert(
    ["critical", "high", "normal"].includes(sampleMemory.priority),
    "Priority is valid value"
  );

  // Cleanup
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
