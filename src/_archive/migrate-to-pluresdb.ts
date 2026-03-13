#!/usr/bin/env node
/**
 * Migration script: better-sqlite3 DB to PluresDB native format
 *
 * Migrates all memories (including embeddings), edges, and profile from a
 * better-sqlite3 (superlocalmemory/pluresLM) database to a PluresDB CRDT store.
 *
 * Usage (after `npm run build`):
 *   node dist/migrate-to-pluresdb.js --from sqlite --to pluresdb \
 *     --source ~/.openclaw/superlocalmemory.db \
 *     --target ~/.openclaw/pluresLM-pluresdb.db \
 *     [--dry-run] [--skip-backup]
 *
 * Or via npm script (dev, no build required):
 *   npm run migrate:pluresdb -- --source <path> --target <path>
 *
 * Or when the package is installed:
 *   npx pluresLM migrate --from sqlite --to pluresdb --source <path> --target <path>
 *
 * Supports source databases from pluresLM v0.12.x through v0.15.x.
 */

import Database from "better-sqlite3";
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface MigrateOptions {
  /** Path to source better-sqlite3 database */
  sourcePath: string;
  /** Path for target PluresDB database (will be created or overwritten) */
  targetPath: string;
  /** Simulate migration without writing to target */
  dryRun?: boolean;
  /** Skip creating a .bak copy of the source database */
  skipBackup?: boolean;
}

export interface MigrationResult {
  memoriesTotal: number;
  memoriesMigrated: number;
  memoriesWithEmbedding: number;
  embeddingDimension: number | null;
  edgesTotal: number;
  edgesMigrated: number;
  profileMigrated: boolean;
  backupPath: string | null;
  errors: string[];
  durationMs: number;
  verification: {
    countMatch: boolean;
    sampleVerified: number;
    sampleTotal: number;
    embeddingSearchMatch: boolean;
  };
}

// --------------------------------------------------------------------------
// Embedding helpers (mirrors memory-db.ts encoding)
// --------------------------------------------------------------------------

function decodeEmbedding(blob: Buffer): number[] {
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float64Array(ab));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --------------------------------------------------------------------------
// Source schema helpers (handles v0.12.x–v0.15.x schema variations)
// --------------------------------------------------------------------------

interface SourceRow {
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

interface SourceEdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  created_at: number;
}

interface SourceProfileRow {
  summary: string;
  facts: string;
  updated_at: number;
  capture_count: number;
}

function getSourceColumns(db: Database.Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function buildSelectSql(columns: Set<string>): string {
  const always = ["id", "content", "embedding", "created_at", "source", "tags", "category"];
  const optional = ["priority", "last_accessed_at", "merge_count", "importance_score"];
  const select = [
    ...always,
    ...optional.map((c) => (columns.has(c) ? c : `NULL AS ${c}`)),
  ];
  return `SELECT ${select.join(", ")} FROM memories ORDER BY created_at ASC`;
}

// --------------------------------------------------------------------------
// Target helpers (writes directly to target better-sqlite3 / PluresDB-compat)
// --------------------------------------------------------------------------

function createTargetTables(targetDb: Database.Database): void {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      created_at INTEGER NOT NULL,
      source TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      category TEXT DEFAULT 'other',
      priority TEXT DEFAULT 'normal',
      last_accessed_at INTEGER,
      merge_count INTEGER DEFAULT 0,
      importance_score REAL DEFAULT 1.0
    );
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS profile (
      id TEXT PRIMARY KEY DEFAULT 'user_profile',
      summary TEXT DEFAULT '',
      facts TEXT DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      capture_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      peer_id TEXT PRIMARY KEY,
      last_sync_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
  `);
}

// --------------------------------------------------------------------------
// Verification helpers
// --------------------------------------------------------------------------

function pickRandomSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const result: T[] = [];
  const pool = [...arr];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

function vectorSearchInDb(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
  minScore: number,
): Array<{ id: string; score: number }> {
  const rows = db.prepare(
    "SELECT id, embedding FROM memories WHERE embedding IS NOT NULL",
  ).all() as Array<{ id: string; embedding: Buffer }>;

  const results: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    try {
      const stored = decodeEmbedding(row.embedding);
      const score = cosineSimilarity(queryEmbedding, stored);
      if (score >= minScore) {
        results.push({ id: row.id, score });
      }
    } catch {
      // skip corrupt embeddings
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// --------------------------------------------------------------------------
// Core migration function
// --------------------------------------------------------------------------

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const { sourcePath, targetPath, dryRun = false, skipBackup = false } = options;

  const result: MigrationResult = {
    memoriesTotal: 0,
    memoriesMigrated: 0,
    memoriesWithEmbedding: 0,
    embeddingDimension: null,
    edgesTotal: 0,
    edgesMigrated: 0,
    profileMigrated: false,
    backupPath: null,
    errors: [],
    durationMs: 0,
    verification: {
      countMatch: false,
      sampleVerified: 0,
      sampleTotal: 0,
      embeddingSearchMatch: false,
    },
  };

  const startTime = Date.now();

  // ---- Validate source ----
  if (!existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  console.log(`\n🔄 pluresLM — SQLite → PluresDB migration`);
  console.log(`   Source : ${sourcePath}`);
  console.log(`   Target : ${targetPath}`);
  if (dryRun) console.log(`   Mode   : DRY RUN (no data will be written)`);
  console.log();

  // ---- Open source (read-only) ----
  const srcDb = new Database(sourcePath, { readonly: true });
  let targetDb: Database.Database | null = null;

  try {
    // ---- Inspect source schema (v0.12.x–v0.15.x compatibility) ----
    const sourceColumns = getSourceColumns(srcDb);
    const hasEdgesTable = (srcDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'"
    ).get() as { name: string } | undefined) !== undefined;
    const hasProfileTable = (srcDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='profile'"
    ).get() as { name: string } | undefined) !== undefined;

    // ---- Read source data ----
    const selectSql = buildSelectSql(sourceColumns);
    const sourceMemories = srcDb.prepare(selectSql).all() as SourceRow[];
    result.memoriesTotal = sourceMemories.length;

    const sourceEdges: SourceEdgeRow[] = hasEdgesTable
      ? (srcDb.prepare("SELECT id, from_id, to_id, relation, created_at FROM memory_edges").all() as SourceEdgeRow[])
      : [];
    result.edgesTotal = sourceEdges.length;

    const sourceProfile: SourceProfileRow | null = hasProfileTable
      ? ((srcDb.prepare("SELECT summary, facts, updated_at, capture_count FROM profile WHERE id = 'user_profile'").get() as SourceProfileRow | undefined) ?? null)
      : null;

    console.log(`📊 Source database contents:`);
    console.log(`   Memories : ${result.memoriesTotal}`);
    console.log(`   Edges    : ${result.edgesTotal}`);
    console.log(`   Profile  : ${sourceProfile ? "found" : "none"}`);

    // ---- Validate embedding dimensions ----
    const firstWithEmbedding = sourceMemories.find((m) => m.embedding != null);
    if (firstWithEmbedding?.embedding) {
      const emb = decodeEmbedding(firstWithEmbedding.embedding);
      result.embeddingDimension = emb.length;
      console.log(`   Embedding dimension: ${emb.length}`);
    } else {
      console.log(`   Embedding dimension: none (no embeddings in source)`);
    }

    if (result.memoriesTotal === 0) {
      console.log("\n✅ Source database is empty — nothing to migrate.");
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // ---- Dry-run: just report what would be done ----
    if (dryRun) {
      console.log(`\n[DRY RUN] Would migrate:`);
      console.log(`   ${result.memoriesTotal} memories`);
      console.log(`   ${result.edgesTotal} edges`);
      console.log(`   Profile: ${sourceProfile ? "yes" : "no"}`);
      const withEmb = sourceMemories.filter((m) => m.embedding != null).length;
      console.log(`   Memories with embeddings: ${withEmb}`);
      console.log(`   Backup: ${skipBackup ? "skipped" : sourcePath + ".bak.<timestamp>"}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // ---- Backup source ----
    if (!skipBackup) {
      const backupPath = `${sourcePath}.bak.${Date.now()}`;
      copyFileSync(sourcePath, backupPath);
      result.backupPath = backupPath;
      console.log(`\n💾 Backup created: ${backupPath}`);
    }

    // ---- Check if target exists ----
    if (existsSync(targetPath)) {
      console.warn(`\n⚠️  Target database already exists: ${targetPath}`);
      console.warn(`   It will be used as-is (existing data may be overwritten).`);
    }

    // ---- Open target ----
    targetDb = new Database(targetPath);
    targetDb.pragma("journal_mode = WAL");
    targetDb.pragma("foreign_keys = ON");
    createTargetTables(targetDb);

    // ---- Migrate memories (atomic transaction) ----
    console.log(`\n🔄 Migrating memories...`);

    const insertMemory = targetDb.prepare(`
      INSERT OR REPLACE INTO memories
        (id, content, embedding, created_at, source, tags, category,
         priority, last_accessed_at, merge_count, importance_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Use local counters inside the transaction; only assign to result after
    // successful commit so the counters remain accurate if the transaction rolls back.
    const migrateMemoriesTransaction = targetDb.transaction((memories: SourceRow[]) => {
      let migrated = 0;
      let withEmbedding = 0;
      for (const m of memories) {
        insertMemory.run(
          m.id,
          m.content,
          m.embedding ?? null,
          m.created_at,
          m.source ?? "",
          m.tags ?? "[]",
          m.category ?? "other",
          m.priority ?? "normal",
          m.last_accessed_at ?? null,
          m.merge_count ?? 0,
          m.importance_score ?? 1.0,
        );
        if (m.embedding != null) withEmbedding++;
        migrated++;

        if (migrated % 100 === 0) {
          process.stdout.write(
            `\r   Migrated ${migrated}/${memories.length} memories...`,
          );
        }
      }
      return { migrated, withEmbedding };
    });

    try {
      const counts = migrateMemoriesTransaction(sourceMemories);
      result.memoriesMigrated = counts.migrated;
      result.memoriesWithEmbedding = counts.withEmbedding;
    } catch (err) {
      throw new Error(`Memory migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`\r   Migrated ${result.memoriesMigrated}/${result.memoriesTotal} memories ✓`);
    console.log(`   Memories with embeddings: ${result.memoriesWithEmbedding}`);

    // ---- Migrate edges ----
    if (sourceEdges.length > 0) {
      console.log(`\n🔄 Migrating edges...`);

      const insertEdge = targetDb.prepare(`
        INSERT OR IGNORE INTO memory_edges (id, from_id, to_id, relation, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      // Use a local counter; assign to result only after successful commit.
      // Errors are not caught here — they propagate to the outer handler which
      // triggers a full rollback of the target database.
      const migrateEdgesTransaction = targetDb.transaction((edges: SourceEdgeRow[]) => {
        let migrated = 0;
        for (const e of edges) {
          insertEdge.run(
            e.id ?? randomUUID(),
            e.from_id,
            e.to_id,
            e.relation,
            e.created_at ?? Date.now(),
          );
          migrated++;
        }
        return migrated;
      });

      result.edgesMigrated = migrateEdgesTransaction(sourceEdges);

      console.log(`   Migrated ${result.edgesMigrated}/${result.edgesTotal} edges ✓`);
    }

    // ---- Migrate profile ----
    if (sourceProfile) {
      console.log(`\n🔄 Migrating user profile...`);
      targetDb.prepare(`
        INSERT OR REPLACE INTO profile (id, summary, facts, updated_at, capture_count)
        VALUES ('user_profile', ?, ?, ?, ?)
      `).run(
        sourceProfile.summary ?? "",
        sourceProfile.facts ?? "[]",
        sourceProfile.updated_at ?? Date.now(),
        sourceProfile.capture_count ?? 0,
      );
      result.profileMigrated = true;
      console.log(`   Profile migrated ✓`);
    }

    // ---- Post-migration verification ----
    console.log(`\n🔍 Verifying migration...`);

    const targetCount = (targetDb.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number }).cnt;
    result.verification.countMatch = targetCount === result.memoriesTotal;

    console.log(`   Source memories : ${result.memoriesTotal}`);
    console.log(`   Target memories : ${targetCount}`);
    console.log(`   Count match     : ${result.verification.countMatch ? "✓" : "✗"}`);

    if (!result.verification.countMatch) {
      result.errors.push(
        `Count mismatch: source has ${result.memoriesTotal} memories, target has ${targetCount}`,
      );
    }

    // Sample verification: check that random source IDs exist in target with same content
    const SAMPLE_SIZE = Math.min(10, result.memoriesTotal);
    const sample = pickRandomSample(sourceMemories, SAMPLE_SIZE);
    result.verification.sampleTotal = sample.length;

    const targetGetById = targetDb.prepare("SELECT id, content FROM memories WHERE id = ?");
    for (const src of sample) {
      const tgt = targetGetById.get(src.id) as { id: string; content: string } | undefined;
      if (tgt && tgt.content === src.content) {
        result.verification.sampleVerified++;
      } else {
        result.errors.push(
          `Verification failed for memory ${src.id}: ` +
            (tgt ? `content mismatch` : `not found in target`),
        );
      }
    }

    console.log(
      `   Sample check    : ${result.verification.sampleVerified}/${result.verification.sampleTotal} verified ✓`,
    );

    // Embedding search verification: pick a random embedded memory from source,
    // do vector search on target, and confirm the same memory surfaces as top result.
    const embeddedMemories = sourceMemories.filter((m) => m.embedding != null);
    if (embeddedMemories.length > 0) {
      const probe = pickRandomSample(embeddedMemories, 1)[0];
      const probeEmbedding = decodeEmbedding(probe.embedding!);
      const searchResults = vectorSearchInDb(targetDb, probeEmbedding, 1, 0.99);
      result.verification.embeddingSearchMatch =
        searchResults.length > 0 && searchResults[0].id === probe.id;
      console.log(
        `   Embedding search: ${result.verification.embeddingSearchMatch ? "✓ top result matches" : "✗ mismatch (embeddings may be corrupt)"}`,
      );
      if (!result.verification.embeddingSearchMatch) {
        result.errors.push(
          `Embedding search verification failed for memory ${probe.id}`,
        );
      }
    } else {
      result.verification.embeddingSearchMatch = true; // no embeddings to check
      console.log(`   Embedding search: skipped (no embeddings in source)`);
    }

  } catch (err) {
    // ---- Rollback: remove partially-written target ----
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Migration failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);

    if (targetDb) {
      try {
        targetDb.close();
        targetDb = null;
      } catch {
        // ignore close error during rollback
      }
    }

    // Clean up partial target files
    for (const ext of ["", "-wal", "-shm"]) {
      const filePath = targetPath + ext;
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // best-effort cleanup
        }
      }
    }

    console.error(`   Target database cleaned up (rolled back).`);
    throw err;
  } finally {
    srcDb.close();
    if (targetDb) {
      try {
        targetDb.close();
      } catch {
        // ignore
      }
    }
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

// --------------------------------------------------------------------------
// Summary printer
// --------------------------------------------------------------------------

function printSummary(result: MigrationResult, dryRun: boolean): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(dryRun ? "📋 Dry-run complete (nothing was written)" : "✅ Migration complete");
  console.log("=".repeat(60));
  console.log(`   Memories migrated  : ${result.memoriesMigrated} / ${result.memoriesTotal}`);
  console.log(`   With embeddings    : ${result.memoriesWithEmbedding}`);
  console.log(`   Embedding dimension: ${result.embeddingDimension ?? "n/a"}`);
  console.log(`   Edges migrated     : ${result.edgesMigrated} / ${result.edgesTotal}`);
  console.log(`   Profile migrated   : ${result.profileMigrated ? "yes" : "no"}`);
  if (result.backupPath) {
    console.log(`   Backup             : ${result.backupPath}`);
  }
  console.log(`   Duration           : ${(result.durationMs / 1000).toFixed(2)}s`);

  if (!dryRun) {
    console.log(`\n   Verification:`);
    console.log(`     Count match    : ${result.verification.countMatch ? "✓" : "✗"}`);
    console.log(
      `     Sample check   : ${result.verification.sampleVerified}/${result.verification.sampleTotal}`,
    );
    console.log(
      `     Embedding search: ${result.verification.embeddingSearchMatch ? "✓" : "✗"}`,
    );
  }

  if (result.errors.length > 0) {
    console.log(`\n⚠️  Errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`   - ${e}`);
    }
    if (result.errors.length > 10) {
      console.log(`   ... and ${result.errors.length - 10} more`);
    }
  }

  if (!dryRun && result.errors.length === 0) {
    console.log(`\n📝 Next steps:`);
    console.log(`   1. Update your config to use 'backend: "pluresdb"'`);
    console.log(`   2. Update dbPath to point to the new target database`);
    console.log(`   3. Restart OpenClaw`);
    console.log(`   4. Keep the backup until you have verified everything works`);
  }
  console.log();
}

// --------------------------------------------------------------------------
// CLI entry point
// --------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  from: string;
  to: string;
  source: string | null;
  target: string | null;
  dryRun: boolean;
  skipBackup: boolean;
  help: boolean;
} {
  const args = {
    from: "",
    to: "",
    source: null as string | null,
    target: null as string | null,
    dryRun: false,
    skipBackup: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        args.from = argv[++i] ?? "";
        break;
      case "--to":
        args.to = argv[++i] ?? "";
        break;
      case "--source":
      case "-s":
        args.source = argv[++i] ?? null;
        break;
      case "--target":
      case "-t":
        args.target = argv[++i] ?? null;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-backup":
        args.skipBackup = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // Accept migrate subcommand silently
        if (arg === "migrate") break;
        if (!arg.startsWith("-")) {
          // Positional: first is source, second is target (legacy compat)
          if (args.source === null) {
            args.source = arg;
          } else if (args.target === null) {
            args.target = arg;
          }
        }
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
pluresLM migrate — SQLite to PluresDB migration tool

Usage:
  npx pluresLM migrate [options]
  npm run migrate:pluresdb -- [options]
  npx tsx src/migrate-to-pluresdb.ts [options]

Options:
  --from sqlite       Source format (currently only 'sqlite' is supported)
  --to pluresdb       Target format (currently only 'pluresdb' is supported)
  --source <path>     Path to source better-sqlite3 database
  --target <path>     Path for the new PluresDB database
  --dry-run           Simulate migration without writing any data
  --skip-backup       Do not create a .bak copy of the source database
  --help, -h          Show this help message

Examples:
  npx pluresLM migrate \\
    --from sqlite --to pluresdb \\
    --source ~/.openclaw/superlocalmemory.db \\
    --target ~/.openclaw/pluresLM-pluresdb.db

  # Dry-run first to preview
  npx pluresLM migrate \\
    --from sqlite --to pluresdb --dry-run \\
    --source ~/.openclaw/superlocalmemory.db \\
    --target ~/.openclaw/pluresLM-pluresdb.db
`);
}

// Detect when this module is the entry point. Works for both:
//   node dist/migrate-to-pluresdb.js   (compiled, bin entry)
//   tsx src/migrate-to-pluresdb.ts     (dev via npm run migrate:pluresdb)
//   tsx scripts/migrate-to-pluresdb.ts (legacy shim)
const argv1 = process.argv[1] ?? "";
if (argv1.includes("migrate-to-pluresdb")) {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.help || (!cliArgs.source && !cliArgs.target)) {
    printHelp();
    process.exit(cliArgs.help ? 0 : 1);
  }

  if (!cliArgs.source) {
    console.error("❌ --source <path> is required");
    printHelp();
    process.exit(1);
  }

  if (!cliArgs.target) {
    console.error("❌ --target <path> is required");
    printHelp();
    process.exit(1);
  }

  if (cliArgs.from && cliArgs.from !== "sqlite") {
    console.error(`❌ Unsupported --from value: ${cliArgs.from}. Only 'sqlite' is supported.`);
    process.exit(1);
  }

  if (cliArgs.to && cliArgs.to !== "pluresdb") {
    console.error(`❌ Unsupported --to value: ${cliArgs.to}. Only 'pluresdb' is supported.`);
    process.exit(1);
  }

  migrate({
    sourcePath: resolve(cliArgs.source),
    targetPath: resolve(cliArgs.target),
    dryRun: cliArgs.dryRun,
    skipBackup: cliArgs.skipBackup,
  })
    .then((result) => {
      printSummary(result, cliArgs.dryRun);
      const hasErrors = result.errors.length > 0;
      const verificationFailed =
        !cliArgs.dryRun &&
        (!result.verification.countMatch ||
          result.verification.sampleVerified < result.verification.sampleTotal ||
          !result.verification.embeddingSearchMatch);
      process.exit(hasErrors || verificationFailed ? 1 : 0);
    })
    .catch((err) => {
      console.error("\nFatal error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
