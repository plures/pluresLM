#!/usr/bin/env npx tsx
/**
 * Migration script: SQLite to PluresDB via Gateway IPC
 * 
 * Reads from legacy SQLite database and imports via IPC to running gateway
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

class GatewayIPCClient {
  private ipcDir: string;

  constructor() {
    this.ipcDir = join(homedir(), ".pluresLM", "ipc");
  }

  async put(memory: any): Promise<void> {
    const requestId = randomUUID();
    const request = {
      command: "store",
      args: { memory },
      id: requestId,
      timestamp: Date.now()
    };

    // Write request
    const requestPath = join(this.ipcDir, "requests", `${requestId}.json`);
    writeFileSync(requestPath, JSON.stringify(request), "utf8");

    // Wait for response
    const responsePath = join(this.ipcDir, "responses", `${requestId}.json`);
    const startTime = Date.now();
    const timeout = 10000;

    while (Date.now() - startTime < timeout) {
      if (existsSync(responsePath)) {
        try {
          const responseData = JSON.parse(readFileSync(responsePath, "utf8"));
          unlinkSync(responsePath); // cleanup
          
          if (!responseData.success) {
            throw new Error(`Gateway error: ${responseData.error}`);
          }
          return responseData.data;
        } catch (err) {
          unlinkSync(responsePath); // cleanup on error
          throw err;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`Gateway IPC timeout after ${timeout}ms`);
  }

  async stats(): Promise<any> {
    const requestId = randomUUID();
    const request = {
      command: "stats",
      args: {},
      id: requestId,
      timestamp: Date.now()
    };

    const requestPath = join(this.ipcDir, "requests", `${requestId}.json`);
    writeFileSync(requestPath, JSON.stringify(request), "utf8");

    const responsePath = join(this.ipcDir, "responses", `${requestId}.json`);
    const startTime = Date.now();
    const timeout = 10000;

    while (Date.now() - startTime < timeout) {
      if (existsSync(responsePath)) {
        try {
          const responseData = JSON.parse(readFileSync(responsePath, "utf8"));
          unlinkSync(responsePath);
          
          if (!responseData.success) {
            throw new Error(`Gateway error: ${responseData.error}`);
          }
          return responseData.data;
        } catch (err) {
          unlinkSync(responsePath);
          throw err;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`Gateway IPC timeout after ${timeout}ms`);
  }
}

function decodeEmbedding(blob: Buffer): number[] {
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float64Array(ab));
}

async function migrate(sourcePath: string, dryRun: boolean = false) {
  console.log(`\n🔄 pluresLM — SQLite → Gateway IPC Migration`);
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Target: Gateway via IPC`);
  if (dryRun) console.log(`   Mode: DRY RUN`);
  console.log();

  if (!existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  const client = new GatewayIPCClient();
  const srcDb = new Database(sourcePath, { readonly: true });

  try {
    // Check current gateway stats
    console.log("📊 Checking current gateway state...");
    const currentStats = await client.stats();
    console.log(`   Current memories: ${currentStats.totalMemories}`);
    console.log();

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
      console.log(`\n[DRY RUN] Would migrate ${memories.length} memories via IPC`);
      return;
    }

    // Migrate memories via IPC
    console.log(`\n🔄 Migrating ${memories.length} memories via IPC...`);
    
    let migrated = 0;
    let skipped = 0;
    const batchSize = 10;

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      
      for (const memory of batch) {
        try {
          // Convert to PluresLM format
          const memoryData = {
            id: memory.id,
            content: memory.content,
            embedding: memory.embedding ? decodeEmbedding(memory.embedding) : null,
            created_at: memory.created_at,
            source: memory.source || "",
            tags: memory.tags ? JSON.parse(memory.tags) : [],
            category: memory.category || "other",
            priority: memory.priority || "normal",
            importance_score: memory.importance_score || 1.0,
            conversation_tag_ids: []
          };

          await client.put(memoryData);
          migrated++;
        } catch (err) {
          console.warn(`   Warning: Failed to migrate memory ${memory.id}: ${err}`);
          skipped++;
        }
      }

      process.stdout.write(`\r   Progress: ${Math.min(i + batchSize, memories.length)}/${memories.length} (${migrated} migrated, ${skipped} skipped)`);
      
      // Small delay to not overwhelm the gateway
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n\n✅ Migration complete!`);
    console.log(`   Migrated: ${migrated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Total: ${memories.length}`);

    // Verify final state
    const finalStats = await client.stats();
    console.log(`\n📊 Final gateway state:`);
    console.log(`   Total memories: ${finalStats.totalMemories}`);
    console.log(`   Increase: +${finalStats.totalMemories - currentStats.totalMemories}`);

  } finally {
    srcDb.close();
  }
}

// CLI
const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(`
Usage: npx tsx migrate-via-ipc.ts <source-db-path> [--dry-run]

Examples:
  npx tsx migrate-via-ipc.ts ~/.openclaw/pluresLM.db
  npx tsx migrate-via-ipc.ts ~/.openclaw/pluresLM.db --dry-run
`);
  process.exit(0);
}

const sourcePath = resolve(args[0]);
const dryRun = args.includes("--dry-run");

migrate(sourcePath, dryRun).catch(err => {
  console.error("\n❌ Migration failed:", err.message);
  process.exit(1);
});