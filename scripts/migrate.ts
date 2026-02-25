#!/usr/bin/env node
/**
 * Migration utility for moving data from better-sqlite3 to PluresDB
 * 
 * Usage:
 *   npx tsx migrate.ts <source-db-path> <target-db-path>
 *   
 * Example:
 *   npx tsx migrate.ts ~/.openclaw/pluresLM.db ~/.openclaw/pluresLM-pluresdb.db
 */

import { MemoryDB } from "./src/memory-db.js";
import { PluresDBBackend } from "./src/pluresdb-backend.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface MigrationStats {
  memories: number;
  edges: number;
  profile: boolean;
  syncState: number;
  errors: string[];
  startTime: number;
  endTime: number;
}

async function migrate(sourcePath: string, targetPath: string): Promise<MigrationStats> {
  const stats: MigrationStats = {
    memories: 0,
    edges: 0,
    profile: false,
    syncState: 0,
    errors: [],
    startTime: Date.now(),
    endTime: 0,
  };

  console.log(`\n🔄 Starting migration...`);
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Target: ${targetPath}\n`);

  // Validate source database exists
  if (!existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  // Warn if target exists
  if (existsSync(targetPath)) {
    console.warn(`⚠️  Target database already exists. It will be used as-is.`);
  }

  let source: MemoryDB | null = null;
  let target: PluresDBBackend | null = null;

  try {
    // Open databases
    console.log("📂 Opening source database (better-sqlite3)...");
    source = new MemoryDB(sourcePath, 1536, 30);
    
    console.log("📂 Opening target database (PluresDB)...");
    target = new PluresDBBackend(targetPath, 1536);
    
    // Wait for PluresDB to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get all memory IDs from source
    console.log("\n📊 Analyzing source database...");
    const memoryIds = await source.getAllMemoryIds();
    console.log(`   Found ${memoryIds.length} memories`);

    if (memoryIds.length === 0) {
      console.log("✅ Source database is empty. Nothing to migrate.");
      stats.endTime = Date.now();
      return stats;
    }

    // Migrate memories in batches
    console.log("\n🔄 Migrating memories...");
    const batchSize = 100;
    for (let i = 0; i < memoryIds.length; i += batchSize) {
      const batch = memoryIds.slice(i, Math.min(i + batchSize, memoryIds.length));
      const ids = batch.map(m => m.id);
      
      const memories = await source.getMemoriesByIds(ids);
      
      for (const memory of memories) {
        try {
          await target.storeRaw(memory);
          stats.memories++;
          
          if (stats.memories % 50 === 0) {
            process.stdout.write(`\r   Migrated ${stats.memories}/${memoryIds.length} memories...`);
          }
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          stats.errors.push(`Failed to migrate memory ${memory.id}: ${err}`);
        }
      }
    }
    console.log(`\r   Migrated ${stats.memories}/${memoryIds.length} memories ✓`);

    // Get embeddings for migrated memories (this is the expensive part)
    console.log("\n🔄 Migrating embeddings...");
    console.log("   Note: This step is skipped. Re-index memories after migration for vector search.");
    console.log("   Run: pluresLM reindex --all");

    // Migrate profile
    console.log("\n🔄 Migrating user profile...");
    const profile = await source.getProfile();
    if (profile) {
      await target.setProfile(profile);
      stats.profile = true;
      console.log("   Profile migrated ✓");
    } else {
      console.log("   No profile found");
    }

    // Migrate sync state (peer sync timestamps)
    console.log("\n🔄 Migrating sync state...");
    console.log("   Note: Sync state migration not implemented yet.");
    console.log("   P2P peers will perform full sync on first connection.");

    stats.endTime = Date.now();

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("✅ Migration completed!");
    console.log("=".repeat(60));
    console.log(`   Memories migrated: ${stats.memories}`);
    console.log(`   Profile migrated: ${stats.profile ? "Yes" : "No"}`);
    console.log(`   Duration: ${((stats.endTime - stats.startTime) / 1000).toFixed(2)}s`);
    
    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered: ${stats.errors.length}`);
      stats.errors.slice(0, 10).forEach(err => console.log(`   - ${err}`));
      if (stats.errors.length > 10) {
        console.log(`   ... and ${stats.errors.length - 10} more`);
      }
    }

    console.log("\n📝 Next steps:");
    console.log("   1. Update your config to use 'backend: \"pluresdb\"'");
    console.log("   2. Update dbPath to point to the new database");
    console.log("   3. Restart OpenClaw");
    console.log("   4. Optionally: Re-index all memories for full vector search");
    console.log("\n");

  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Migration failed: ${err}`);
    throw error;
  } finally {
    // Close databases
    if (source) {
      try {
        await source.close();
      } catch (e) {
        console.error("Error closing source database:", e);
      }
    }
    if (target) {
      try {
        await target.close();
      } catch (e) {
        console.error("Error closing target database:", e);
      }
    }
  }

  return stats;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error("Usage: npx tsx migrate.ts <source-db-path> <target-db-path>");
    console.error("\nExample:");
    console.error("  npx tsx migrate.ts ~/.openclaw/pluresLM.db ~/.openclaw/pluresLM-pluresdb.db");
    process.exit(1);
  }

  const [sourcePath, targetPath] = args.map(p => resolve(p));

  migrate(sourcePath, targetPath)
    .then(stats => {
      process.exit(stats.errors.length > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error("\nFatal error:", error);
      process.exit(1);
    });
}

export { migrate };
