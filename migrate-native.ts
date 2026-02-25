#!/usr/bin/env npx tsx

/**
 * Direct SQLite to PluresDB data migration
 * 
 * Reads from legacy pluresLM.db and writes via the PluresDB native API
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { PluresDatabase } from "@plures/pluresdb/embedded";

interface LegacyMemory {
  id: string;
  content: string;
  embedding: Buffer | null;
  created_at: number;
  source: string;
  tags: string;
  category: string;
  priority: string | null;
  last_accessed_at: number | null;
  merge_count: number | null;
  importance_score: number | null;
}

function decodeEmbedding(blob: Buffer): number[] {
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float64Array(ab));
}

async function migrate(sourcePath: string, targetPath: string, dryRun: boolean = false) {
  console.log(`\n🔄 pluresLM — SQLite → PluresDB Native Migration`);
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Target: ${targetPath}`);
  if (dryRun) console.log(`   Mode: DRY RUN`);
  console.log();

  if (!existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  // Open source database
  const srcDb = new Database(sourcePath, { readonly: true });

  try {
    // Read source data
    const memories = srcDb.prepare(`
      SELECT id, content, embedding, created_at, source, tags, category,
             priority, last_accessed_at, merge_count, importance_score
      FROM memories 
      ORDER BY created_at ASC
    `).all() as LegacyMemory[];

    console.log(`📊 Source database contents:`);
    console.log(`   Total memories: ${memories.length}`);
    
    const withEmbedding = memories.filter(m => m.embedding != null).length;
    console.log(`   With embeddings: ${withEmbedding}`);
    
    if (memories.length === 0) {
      console.log("✅ Source database is empty");
      return;
    }

    if (dryRun) {
      console.log(`\n[DRY RUN] Would migrate ${memories.length} memories to PluresDB`);
      return;
    }

    // Open target PluresDB
    console.log(`\n📂 Opening target PluresDB at: ${targetPath}`);
    const db = PluresDatabase.open(targetPath);

    // Migrate memories
    console.log(`\n🔄 Migrating ${memories.length} memories...`);
    
    let migrated = 0;
    let skipped = 0;
    const batchSize = 50;

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      
      for (const memory of batch) {
        try {
          // Convert to PluresDB format
          const nodeData = {
            id: memory.id,
            data: JSON.stringify({
              content: memory.content,
              source: memory.source || "",
              tags: memory.tags ? JSON.parse(memory.tags) : [],
              category: memory.category || "other",
              priority: memory.priority || "normal",
              importance_score: memory.importance_score || 1.0,
              created_at: memory.created_at,
              last_accessed_at: memory.last_accessed_at,
              merge_count: memory.merge_count || 0
            }),
            clock: memory.created_at,
            timestamp: new Date(memory.created_at).toISOString(),
            actor: "migration-script",
            embedding: memory.embedding ? decodeEmbedding(memory.embedding) : undefined
          };

          if (nodeData.embedding) {
            db.putWithEmbedding(nodeData.id, nodeData.actor, JSON.parse(nodeData.data), nodeData.embedding as number[]);
          } else {
            db.put(nodeData.id, nodeData.actor, JSON.parse(nodeData.data));
          }
          
          migrated++;
        } catch (err) {
          console.warn(`   Warning: Failed to migrate memory ${memory.id}: ${err}`);
          skipped++;
        }
      }

      process.stdout.write(`\r   Progress: ${Math.min(i + batchSize, memories.length)}/${memories.length} (${migrated} migrated, ${skipped} skipped)`);
      
      // Small delay to not overwhelm the system
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log(`\n\n✅ Migration complete!`);
    console.log(`   Migrated: ${migrated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Total: ${memories.length}`);

    // Close database
    db.close();

  } finally {
    srcDb.close();
  }
}

// CLI
const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(`
Usage: npx tsx migrate-native.ts <source-db-path> <target-db-path> [--dry-run]

Examples:
  npx tsx migrate-native.ts ~/.openclaw/pluresLM.db ~/.pluresLM/openclaw-gateway/db
  npx tsx migrate-native.ts ~/.openclaw/pluresLM.db ~/.pluresLM/openclaw-gateway/db --dry-run
`);
  process.exit(0);
}

const sourcePath = resolve(args[0]);
const targetPath = resolve(args[1]);
const dryRun = args.includes("--dry-run");

migrate(sourcePath, targetPath, dryRun).catch(err => {
  console.error("\n❌ Migration failed:", err.message);
  process.exit(1);
});