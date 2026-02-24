#!/usr/bin/env node
/**
 * Ingest MEMORY.md into pluresLM as properly categorized memories.
 *
 * Run once during setup or when MEMORY.md changes significantly.
 * Skips sections already ingested (dedup by content prefix).
 *
 * Usage: npx tsx scripts/ingest-memory-md.ts [path-to-MEMORY.md]
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Section heading → pluresLM category mapping
const SECTION_CATEGORIES: Record<string, string> = {
  "Critical Ops Knowledge": "architecture-decision",
  "Product Strategy": "decision",
  "CI/CD Pipeline": "project-context",
  "Product: Plures LM": "project-context",
  "Active Projects": "project-context",
  "AI Model Routing": "decision",
  "Product direction": "decision",
  "Personal Documents & Accounts": "entity",
  "Preferences": "preference",
};

function categorize(heading: string): string {
  for (const [prefix, cat] of Object.entries(SECTION_CATEGORIES)) {
    if (heading.startsWith(prefix)) return cat;
  }
  return "explicit";
}

function tagsFromHeading(heading: string): string[] {
  const tags = ["memory-md", "migrated"];
  if (heading.includes("Pares")) tags.push("pares");
  if (heading.includes("Plures LM") || heading.includes("pluresLM")) tags.push("pluresLM");
  if (heading.includes("CI/CD")) tags.push("ci-cd");
  if (heading.includes("Ops")) tags.push("ops");
  if (heading.includes("Personal")) tags.push("personal", "confidential");
  return tags;
}

async function main() {
  const memoryPath = resolve(
    process.argv[2] || `${process.env.HOME}/.openclaw/workspace/MEMORY.md`,
  );
  const content = readFileSync(memoryPath, "utf-8");

  // Split into sections by ## headings
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeading && currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = line.replace(/^## /, "").trim();
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading && currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }

  console.log(`Found ${sections.length} sections in ${memoryPath}`);

  // Load pluresLM tools
  // When run as a script, we use the store tool directly via the backend
  const dbPath = process.env.PLURESLM_DB_PATH ||
    `${process.env.HOME}/.openclaw/pluresLM-native.db`;

  // Try to load native module
  let PluresDatabase: any;
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    try {
      const mod = require(`${process.env.HOME}/.openclaw/workspace/repos/pluresdb/embedded.js`);
      PluresDatabase = mod.PluresDatabase;
    } catch (e) {
      console.error("Could not load PluresDB native module:", e);
      process.exit(1);
    }
  } catch (e) {
    console.error("Could not create require:", e);
    process.exit(1);
  }

  const db = PluresDatabase.newWithEmbeddings("BAAI/bge-small-en-v1.5", "memory-md-ingest", dbPath);

  let stored = 0;
  let skipped = 0;

  for (const section of sections) {
    const category = categorize(section.heading);
    const tags = tagsFromHeading(section.heading);

    // For large sections, chunk by ### sub-headings or by ~2000 char blocks
    const chunks = chunkSection(section.heading, section.body);

    for (const chunk of chunks) {
      // Check for existing memory with same content prefix (dedup)
      const prefix = chunk.content.slice(0, 100);
      const existing = db.search(prefix, 1);
      if (existing.length > 0 && existing[0].score > 0.95) {
        skipped++;
        continue;
      }

      const id = `memory:memmd-${Buffer.from(prefix).toString("base64url").slice(0, 20)}-${Date.now()}`;
      db.put(id, {
        content: chunk.content,
        created_at: Date.now(),
        source: `memory-md:${section.heading}`,
        tags: JSON.stringify(tags),
        category,
        priority: category === "entity" ? "high" : "normal",
        importance_score: category === "architecture-decision" || category === "decision" ? 2.0 : 1.0,
      });
      stored++;
    }
  }

  console.log(`Done: ${stored} stored, ${skipped} skipped (duplicates)`);
}

function chunkSection(heading: string, body: string): Array<{ content: string }> {
  // If body has ### sub-headings, split on those
  if (body.includes("\n### ")) {
    const chunks: Array<{ content: string }> = [];
    const parts = body.split(/\n(?=### )/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 50) {
        chunks.push({ content: `## ${heading}\n${trimmed}` });
      }
    }
    return chunks.length > 0 ? chunks : [{ content: `## ${heading}\n${body}` }];
  }

  // If body is small enough, keep as one chunk
  if (body.length < 3000) {
    return [{ content: `## ${heading}\n${body}` }];
  }

  // Split by bullet points or paragraphs for large sections
  const chunks: Array<{ content: string }> = [];
  let current = `## ${heading}\n`;
  for (const line of body.split("\n")) {
    if (current.length + line.length > 2500 && current.length > 200) {
      chunks.push({ content: current.trim() });
      current = `## ${heading} (cont.)\n`;
    }
    current += line + "\n";
  }
  if (current.trim().length > 100) {
    chunks.push({ content: current.trim() });
  }
  return chunks;
}

main().catch(console.error);
