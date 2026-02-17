/**
 * Migration utilities for importing manual memory files into SLM
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IMemoryBackend } from "./backend-factory.js";

export interface ParsedMemory {
  content: string;
  priority: "critical" | "high" | "normal";
  category: string;
  tags: string[];
  source: string;
}

/**
 * Parse MEMORY.md file into structured memories.
 * 
 * Expected format:
 * - Bullet points or sections of text
 * - Each paragraph or bullet becomes a separate memory
 * - Headers are used as context/tags
 */
export function parseMemoryMd(filePath: string): ParsedMemory[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const memories: ParsedMemory[] = [];
  
  // Split by lines and process
  const lines = content.split("\n");
  let currentSection = "";
  let currentTags: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Detect markdown headers as section markers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[2].toLowerCase().replace(/\s+/g, "-");
      currentTags = [`section:${currentSection}`];
      continue;
    }
    
    // Detect bullet points
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const memoryContent = bulletMatch[1].trim();
      if (memoryContent.length > 10) { // Skip very short items
        memories.push({
          content: memoryContent,
          priority: "critical",
          category: "migrated-memory",
          tags: [...currentTags, "source:memory.md"],
          source: "migration:MEMORY.md",
        });
      }
      continue;
    }
    
    // Regular paragraphs
    if (line.length > 20) { // Only capture substantial content
      memories.push({
        content: line,
        priority: "critical",
        category: "migrated-memory",
        tags: [...currentTags, "source:memory.md"],
        source: "migration:MEMORY.md",
      });
    }
  }
  
  return memories;
}

/**
 * Parse a daily memory file (e.g., memory/2024-01-15.md)
 * 
 * Expected format:
 * - Date-based filename
 * - Daily summary content
 */
export function parseDailyFile(filePath: string): ParsedMemory[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8").trim();
  const filename = path.basename(filePath, ".md");
  
  // Extract date from filename if possible (YYYY-MM-DD format)
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  const dateTag = dateMatch ? `date:${dateMatch[1]}` : "";
  
  const memories: ParsedMemory[] = [];
  
  // Split content into paragraphs or sections
  const sections = content.split(/\n\n+/);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length > 20) {
      const tags = ["source:daily-file"];
      if (dateTag) tags.push(dateTag);
      
      memories.push({
        content: trimmed,
        priority: "normal",
        category: "daily-summary",
        tags,
        source: `migration:${filename}`,
      });
    }
  }
  
  return memories;
}

/**
 * Parse all files in a directory (for daily memory files)
 */
export function parseDailyDirectory(dirPath: string): ParsedMemory[] {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  const memories: ParsedMemory[] = [];
  const files = fs.readdirSync(dirPath);
  
  for (const file of files) {
    if (file.endsWith(".md")) {
      const filePath = path.join(dirPath, file);
      try {
        const dailyMemories = parseDailyFile(filePath);
        memories.push(...dailyMemories);
      } catch (err) {
        console.warn(`Warning: Failed to parse ${file}: ${String(err)}`);
      }
    }
  }
  
  return memories;
}

/**
 * Import parsed memories into the database
 */
export async function importMemories(
  memories: ParsedMemory[],
  db: IMemoryBackend,
  embeddings: { embed(text: string): Promise<number[]> },
  options: {
    dryRun?: boolean;
    dedupeThreshold?: number;
  } = {}
): Promise<{ imported: number; skipped: number; duplicates: number }> {
  const dryRun = options.dryRun ?? false;
  const dedupeThreshold = options.dedupeThreshold ?? 0.95;
  
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  
  for (const memory of memories) {
    try {
      const embedding = await embeddings.embed(memory.content);
      
      if (dryRun) {
        console.log(`[DRY RUN] Would import: ${memory.content.slice(0, 80)}...`);
        console.log(`  Category: ${memory.category}, Tags: ${memory.tags.join(", ")}`);
        imported++;
        continue;
      }
      
      const result = await db.store(memory.content, embedding, {
        source: memory.source,
        tags: [...memory.tags, `priority:${memory.priority}`],
        category: memory.category,
        dedupeThreshold,
      });
      
      if (result.isDuplicate) {
        duplicates++;
      } else {
        imported++;
      }
    } catch (err) {
      console.warn(`Warning: Failed to import memory: ${String(err)}`);
      skipped++;
    }
  }
  
  return { imported, skipped, duplicates };
}

/**
 * Verify that migrated content is present in the database
 */
export async function verifyMigration(
  originalMemories: ParsedMemory[],
  db: IMemoryBackend,
  embeddings: { embed(text: string): Promise<number[]> },
  threshold: number = 0.9
): Promise<{
  total: number;
  found: number;
  missing: number;
  coverage: number;
  missingItems: string[];
}> {
  let found = 0;
  const missingItems: string[] = [];
  
  for (const memory of originalMemories) {
    try {
      const embedding = await embeddings.embed(memory.content);
      const results = await db.vectorSearch(embedding, 1, 0.85);
      
      if (results.length > 0 && results[0].score >= 0.85) {
        found++;
      } else {
        missingItems.push(memory.content.slice(0, 80) + "...");
      }
    } catch (err) {
      console.warn(`Warning: Failed to verify memory: ${String(err)}`);
      missingItems.push(memory.content.slice(0, 80) + "...");
    }
  }
  
  const total = originalMemories.length;
  const missing = total - found;
  const coverage = total > 0 ? found / total : 0;
  
  return {
    total,
    found,
    missing,
    coverage,
    missingItems,
  };
}
