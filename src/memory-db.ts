/**
 * Memory storage layer using better-sqlite3
 *
 * Embedded SQLite with in-process cosine similarity for vector search.
 * Graph edges stored as a relation table for linking memories.
 *
 * NOTE: better-sqlite3 is loaded lazily via createRequire so that this module
 * can be imported without the native binary being present.  If better-sqlite3
 * is not installed, MemoryDB will throw at construction time with a clear
 * message directing users to the PluresDB backend.
 */

// better-sqlite3 is intentionally NOT statically imported — it is required
// lazily inside the constructor so that Vite / vitest can load this module
// even when the native binary is not present in the environment.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

export type MemoryPriority = "critical" | "high" | "normal" | "low";

/** Options accepted by content-only store operations (no pre-computed embedding). */
export interface StoreContentOpts {
  source?: string;
  tags?: string[];
  category?: string;
  priority?: MemoryPriority;
  originator_id?: string;
  originator_name?: string;
  destination?: string;
  status?: string;
  assigned_to?: string;
  due_at?: number;
  last_checkin?: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  created_at: number;
  source: string;
  tags: string[];
  category: string;
  priority?: MemoryPriority;
  last_accessed_at?: number;
  merge_count?: number;
  importance_score?: number;
  conversation_tag_ids?: string[];
  /** ID of the agent that created this record (empty string = unknown/local) */
  originator_id?: string;
  /** Human-readable name of the originating agent (e.g. "desktop", "surface") */
  originator_name?: string;
  /** Intended target agent or scope; empty = broadcast to all agents */
  destination?: string;
  /** Task lifecycle status: '' | 'claimed' | 'in-progress' | 'completed' | 'abandoned' */
  status?: string;
  /** Agent ID responsible for executing this task */
  assigned_to?: string;
  /** Optional deadline (Unix ms timestamp) */
  due_at?: number;
  /** Last timestamp (Unix ms) the assigned agent acknowledged this task */
  last_checkin?: number;
}

export interface ConversationTag {
  id: string;
  label: string;
  embedding: number[];
  parent_tag_id?: string;
  message_ids: string[];
  created_at: number;
  updated_at: number;
  similarity_threshold: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface ProfileData {
  summary: string;
  facts: string[];
  updated_at: number;
  capture_count: number;
}

export interface DailySummary {
  date: string; // YYYY-MM-DD format
  summary: string; // Markdown formatted summary
  memoryCount: number;
  categories: Record<string, number>;
  created_at: number;
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

/**
 * Compute time-decay factor for a memory.
 * decayScore = exp(-lambda * daysSinceAccess)
 * lambda = ln(2) / halfLifeDays
 */
function computeDecayFactor(
  lastAccessedAt: number | null | undefined,
  createdAt: number,
  halfLifeDays: number,
  isPermanent: boolean
): number {
  if (isPermanent || halfLifeDays <= 0) return 1.0;
  
  const now = Date.now();
  const accessTime = lastAccessedAt ?? createdAt;
  const daysSinceAccess = (now - accessTime) / (1000 * 60 * 60 * 24);
  
  const lambda = Math.log(2) / halfLifeDays;
  return Math.exp(-lambda * daysSinceAccess);
}

/**
 * Determine priority based on category and tags.
 * - critical: Always include in recalls (has "critical" or "permanent" tag, personal docs, credentials)
 * - high: Include when relevant (explicit, decision, active project state, preferences)
 * - normal: Standard recall behavior (default)
 * - low: Only recall if highly relevant (conversation fragments, FYI items)
 */
export function determinePriority(category: string, tags: string[]): MemoryPriority {
  // Check for critical/permanent tags first
  if (tags.includes("critical") || tags.includes("permanent")) {
    return "critical";
  }
  
  // Category-based priority
  switch (category) {
    case "explicit":
    case "decision":
    case "entity":
    case "preference":
    case "architecture-decision":
      return "high";
    
    case "conversation":
      return "low";
    
    case "code-pattern":
    case "type-definition":
    case "api-pattern":
    case "module-composition":
    case "error-fix":
    case "work-in-progress":
    case "project":
    case "project-context":
    default:
      return "normal";
  }
}

export class MemoryDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any; // dynamically loaded better-sqlite3 Database instance
  private dbPath: string;
  private closed = false;
  private decayHalfLifeDays: number = 30; // default

  constructor(dbPath: string, _vectorDimension: number, decayHalfLifeDays: number = 30) {
    this.dbPath = dbPath;
    this.decayHalfLifeDays = decayHalfLifeDays;
    // Load better-sqlite3 lazily so the module can be imported without it installed.
    const req = createRequire(import.meta.url);
    let Database: any;
    try {
      Database = req("better-sqlite3");
    } catch {
      throw new Error(
        "better-sqlite3 is not available. pluresLM now uses the PluresDB backend. " +
        "Migrate existing data with: npx pluresLM migrate-from-sqlite",
      );
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.closed = false;
    this.db.exec(`
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
        importance_score REAL DEFAULT 1.0,
        originator_id TEXT DEFAULT '',
        originator_name TEXT DEFAULT '',
        destination TEXT DEFAULT '',
        status TEXT DEFAULT '',
        assigned_to TEXT DEFAULT '',
        due_at INTEGER,
        last_checkin INTEGER
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
      CREATE TABLE IF NOT EXISTS conversation_tags (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        embedding BLOB,
        parent_tag_id TEXT,
        message_ids TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        similarity_threshold REAL DEFAULT 0.85
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_conv_tags_parent ON conversation_tags(parent_tag_id);
      CREATE INDEX IF NOT EXISTS idx_conv_tags_updated ON conversation_tags(updated_at);
    `);
    
    // Migration: Add new columns if they don't exist
    this.migrateSchema();
  }

  private migrateSchema(): void {
    // Check if last_accessed_at column exists
    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    
    if (!columnNames.includes("last_accessed_at")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER");
    }
    
    if (!columnNames.includes("merge_count")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN merge_count INTEGER DEFAULT 0");
    }
    
    if (!columnNames.includes("priority")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN priority TEXT DEFAULT 'normal'");
    }

    if (!columnNames.includes("importance_score")) {
      // New importance_score column: default 1.0 is treated as a neutral importance.
      // Existing memories will be backfilled with 1.0, preserving pre-migration behavior.
      this.db.exec("ALTER TABLE memories ADD COLUMN importance_score REAL DEFAULT 1.0");
    }

    if (!columnNames.includes("originator_id")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN originator_id TEXT DEFAULT ''");
    }
    if (!columnNames.includes("originator_name")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN originator_name TEXT DEFAULT ''");
    }
    if (!columnNames.includes("destination")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN destination TEXT DEFAULT ''");
    }
    if (!columnNames.includes("status")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN status TEXT DEFAULT ''");
    }
    if (!columnNames.includes("assigned_to")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN assigned_to TEXT DEFAULT ''");
    }
    if (!columnNames.includes("due_at")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN due_at INTEGER");
    }
    if (!columnNames.includes("last_checkin")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN last_checkin INTEGER");
    }
    if (!columnNames.includes("conversation_tag_ids")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN conversation_tag_ids TEXT DEFAULT '[]'");
    }
  }

  private encodeEmbedding(vec: number[]): Buffer {
    return Buffer.from(new Float64Array(vec).buffer);
  }

  private decodeEmbedding(blob: Buffer): number[] {
    const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    return Array.from(new Float64Array(ab));
  }

  /**
   * Semantic dedup v2: Find clusters of similar memories and merge them.
   * Returns the ID of the memory to merge into, or null if no merge needed.
   */
  private async clusterAndMerge(
    embedding: number[],
    content: string,
    tags: string[],
  ): Promise<{ shouldMerge: boolean; targetId?: string; mergedContent?: string; mergedEmbedding?: number[]; mergedTags?: string[]; earliestCreatedAt?: number } | null> {
    // Find top-3 similar memories (without updating access time)
    const similar = await this.vectorSearch(embedding, 3, 0.85, false);
    
    if (similar.length === 0) return null;
    
    // Check if 2+ memories in the cluster are >0.85 similar to each other
    let clusterCount = 0;
    for (let i = 0; i < similar.length; i++) {
      const sim = cosineSimilarity(embedding, similar[i].entry.embedding);
      if (sim >= 0.85) clusterCount++;
    }
    
    if (clusterCount < 2) return null;
    
    // Merge: keep the longest/richest content
    const candidates = similar.filter(s => cosineSimilarity(embedding, s.entry.embedding) >= 0.85);
    // Add new content as a candidate (with temporary ID)
    candidates.push({ entry: { id: '', content, embedding, created_at: Date.now(), source: '', tags, category: 'other' }, score: 1.0 });
    
    const longest = candidates.reduce((prev, curr) => 
      curr.entry.content.length > prev.entry.content.length ? curr : prev
    );
    
    // Union tags
    const allTags = new Set<string>();
    for (const c of candidates) {
      c.entry.tags.forEach(t => allTags.add(t));
    }
    
    // Find earliest created_at from existing memories (not including the new one)
    const existingCandidates = candidates.filter(c => c.entry.id);
    const earliestCreatedAt = existingCandidates.length > 0 
      ? Math.min(...existingCandidates.map(c => c.entry.created_at))
      : Date.now();
    
    // Use the first existing memory as the target
    const target = similar[0].entry;
    
    return {
      shouldMerge: true,
      targetId: target.id,
      mergedContent: longest.entry.content,
      mergedEmbedding: longest.entry.embedding,
      mergedTags: Array.from(allTags),
      earliestCreatedAt,
    };
  }

  async store(
    content: string,
    embedding: number[],
    opts: { source?: string; tags?: string[]; category?: string; priority?: MemoryPriority; dedupeThreshold?: number; useSemanticDedup?: boolean; importanceScore?: number; originator_id?: string; originator_name?: string; destination?: string; status?: string; assigned_to?: string; due_at?: number; last_checkin?: number },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string; merged?: boolean }> {
    const tags = opts.tags ?? [];
    const category = opts.category ?? "other";
    const priority = opts.priority ?? determinePriority(category, tags);
    const useSemanticDedup = opts.useSemanticDedup ?? true;
    const importanceScore = opts.importanceScore ?? 1.0;
    const originator_id = opts.originator_id ?? "";
    const originator_name = opts.originator_name ?? "";
    const destination = opts.destination ?? "";
    const status = opts.status ?? "";
    const assigned_to = opts.assigned_to ?? "";
    const due_at = opts.due_at ?? null;
    const last_checkin = opts.last_checkin ?? null;
    
    // Semantic dedup v2
    if (useSemanticDedup) {
      const mergeResult = await this.clusterAndMerge(embedding, content, tags);
      if (mergeResult?.shouldMerge && mergeResult.targetId) {
        const now = Date.now();
        const target = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(mergeResult.targetId) as Record<string, unknown>;
        const currentMergeCount = ((target.merge_count ?? 0) as number);
        const targetPriority = (target.priority as MemoryPriority) ?? "normal";
        
        // Promote priority if merge_count is high (reinforced fact)
        // Use the higher of target priority or new priority, then promote if merge count is high
        const basePriority = targetPriority === "high" || targetPriority === "critical" ? targetPriority : priority;
        const promotedPriority = currentMergeCount >= 3 && basePriority === "normal" ? "high" : basePriority;

        // Merge opts fields so metadata is never dropped on semantic dedup
        const mergedSource = opts.source ?? (target.source as string | undefined) ?? "";
        const mergedCategory = opts.category ?? (target.category as string | undefined) ?? "other";
        const mergedImportanceScore = Math.max(
          opts.importanceScore ?? 1.0,
          (target.importance_score as number | null) ?? 1.0,
        );
        
        this.db.prepare(
          `UPDATE memories SET content = ?, embedding = ?, tags = ?, created_at = ?, merge_count = ?, priority = ?, source = ?, category = ?, importance_score = ? WHERE id = ?`,
        ).run(
          mergeResult.mergedContent,
          this.encodeEmbedding(mergeResult.mergedEmbedding!),
          JSON.stringify(mergeResult.mergedTags),
          mergeResult.earliestCreatedAt,
          currentMergeCount + 1,
          promotedPriority,
          mergedSource,
          mergedCategory,
          mergedImportanceScore,
          mergeResult.targetId
        );
        
        const updatedEntry: MemoryEntry = {
          id: mergeResult.targetId,
          content: mergeResult.mergedContent!,
          embedding: mergeResult.mergedEmbedding!,
          created_at: mergeResult.earliestCreatedAt!,
          source: mergedSource,
          tags: mergeResult.mergedTags!,
          category: mergedCategory,
          importance_score: mergedImportanceScore,
          priority: promotedPriority,
          merge_count: currentMergeCount + 1,
        };
        
        return { entry: updatedEntry, isDuplicate: true, updatedId: mergeResult.targetId, merged: true };
      }
    }
    
    // Fallback to simple dedup
    const threshold = opts.dedupeThreshold ?? 0.95;
    const existing = await this.vectorSearch(embedding, 1, threshold);

    if (existing.length > 0) {
      const ex = existing[0].entry;
      const now = Date.now();
      const mergedTags = [...new Set([...ex.tags, ...tags])];
      const mergedSource = opts.source ?? ex.source ?? "";
      const mergedCategory = opts.category ?? ex.category ?? "other";
      const mergedImportanceScore = Math.max(
        opts.importanceScore ?? 1.0,
        ex.importance_score ?? 1.0,
      );
      const mergedPriority = opts.priority ?? determinePriority(mergedCategory, mergedTags);
      this.db.prepare(
        `UPDATE memories SET content = ?, embedding = ?, created_at = ?, source = ?, tags = ?, category = ?, priority = ?, importance_score = ? WHERE id = ?`,
      ).run(
        content,
        this.encodeEmbedding(embedding),
        now,
        mergedSource,
        JSON.stringify(mergedTags),
        mergedCategory,
        mergedPriority,
        mergedImportanceScore,
        ex.id,
      );
      return {
        entry: {
          ...ex,
          content,
          embedding,
          created_at: now,
          source: mergedSource,
          tags: mergedTags,
          category: mergedCategory,
          priority: mergedPriority,
          importance_score: mergedImportanceScore,
        },
        isDuplicate: true,
        updatedId: ex.id,
      };
    }

    const id = randomUUID();
    const now = Date.now();

    // Assign conversation tags before building the entry
    const conversationTagIds = this.assignConversationTag(id, embedding, content);

    const entry: MemoryEntry = {
      id, content, embedding, created_at: now,
      source: opts.source ?? "", tags, category,
      priority,
      merge_count: 0,
      importance_score: importanceScore,
      conversation_tag_ids: conversationTagIds,
      originator_id,
      originator_name,
      destination,
      status,
      assigned_to,
      due_at: due_at ?? undefined,
      last_checkin: last_checkin ?? undefined,
    };

    this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, priority, merge_count, importance_score, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin, conversation_tag_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, this.encodeEmbedding(embedding), now, entry.source, JSON.stringify(entry.tags), entry.category, entry.priority, 0, importanceScore, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin, JSON.stringify(conversationTagIds));

    return { entry, isDuplicate: false };
  }

  /**
   * Store content without a pre-computed embedding.
   * Uses exact-content dedup. The entry is stored with a null embedding and
   * will not appear in vector search results until setEmbedding() is called.
   * On PluresDB, the backend can auto-embed content when supported.
   */
  async storeContent(
    content: string,
    opts: StoreContentOpts,
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
    const tags = opts.tags ?? [];
    const category = opts.category ?? "other";
    const priority = opts.priority ?? determinePriority(category, tags);

    // Best-effort exact-content dedup (no embedding available for vector dedup)
    const dup = this.db.prepare(
      "SELECT id, content, created_at, source, tags, category, priority FROM memories WHERE content = ? LIMIT 1",
    ).get(content) as Record<string, unknown> | undefined;
    if (dup) {
      const entry: MemoryEntry = {
        id: dup.id as string,
        content: dup.content as string,
        embedding: [],
        created_at: dup.created_at as number,
        source: dup.source as string,
        tags: JSON.parse((dup.tags as string) || "[]"),
        category: dup.category as string,
        priority: (dup.priority as MemoryPriority) ?? "normal",
      };
      return { entry, isDuplicate: true, updatedId: dup.id as string };
    }

    const id = randomUUID();
    const now = Date.now();
    const originator_id = opts.originator_id ?? "";
    const originator_name = opts.originator_name ?? "";
    const destination = opts.destination ?? "";
    const status = opts.status ?? "";
    const assigned_to = opts.assigned_to ?? "";
    const due_at = opts.due_at ?? null;
    const last_checkin = opts.last_checkin ?? null;

    this.db.prepare(
      "INSERT INTO memories (id, content, embedding, created_at, source, tags, category, priority, merge_count, importance_score, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 1.0, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, content, now, opts.source ?? "", JSON.stringify(tags), category, priority, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin);

    const entry: MemoryEntry = {
      id, content, embedding: [], created_at: now,
      source: opts.source ?? "", tags, category, priority,
      merge_count: 0,
      importance_score: 1.0,
      originator_id: originator_id || undefined,
      originator_name: originator_name || undefined,
      destination: destination || undefined,
      status: status || undefined,
      assigned_to: assigned_to || undefined,
      due_at: due_at ?? undefined,
      last_checkin: last_checkin ?? undefined,
    };

    return { entry, isDuplicate: false };
  }

  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
    updateAccessTime: boolean = true,
  ): Promise<MemorySearchResult[]> {
    const rows = this.db.prepare(
      "SELECT id, content, embedding, created_at, source, tags, category, priority, last_accessed_at, merge_count, importance_score, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin, conversation_tag_ids FROM memories",
    ).all() as Array<Record<string, unknown>>;

    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      let stored: number[];
      try {
        stored = this.decodeEmbedding(row.embedding as Buffer);
      } catch {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, stored);
      if (score >= minScore) {
        const tags = JSON.parse((row.tags as string) || "[]");
        const isPermanent = tags.includes("permanent");
        
        // Apply time-decay to score
        const decayFactor = computeDecayFactor(
          row.last_accessed_at as number | null | undefined,
          row.created_at as number,
          this.decayHalfLifeDays,
          isPermanent
        );
        let decayedScore = score * decayFactor;
        
        // Apply importance_score multiplier (user-set importance boost)
        const importanceScore = (row.importance_score as number | null) ?? 1.0;
        decayedScore *= importanceScore;
        
        // Apply priority boost
        const memoryPriority = (row.priority as MemoryPriority) ?? "normal";
        const priorityBoost = memoryPriority === "critical" ? 1.5 : 
                             memoryPriority === "high" ? 1.2 : 
                             memoryPriority === "low" ? 0.8 : 1.0;
        decayedScore *= priorityBoost;
        
        if (decayedScore >= minScore) {
          results.push({
            entry: {
              id: row.id as string,
              content: row.content as string,
              embedding: stored,
              created_at: row.created_at as number,
              source: row.source as string,
              tags,
              category: row.category as string,
              priority: memoryPriority,
              last_accessed_at: row.last_accessed_at as number | undefined,
              merge_count: row.merge_count as number | undefined,
              importance_score: importanceScore,
              conversation_tag_ids: JSON.parse((row.conversation_tag_ids as string) || "[]"),
              originator_id: (row.originator_id as string) || undefined,
              originator_name: (row.originator_name as string) || undefined,
              destination: (row.destination as string) || undefined,
              status: (row.status as string) || undefined,
              assigned_to: (row.assigned_to as string) || undefined,
              due_at: (row.due_at as number | null) ?? undefined,
              last_checkin: (row.last_checkin as number | null) ?? undefined,
            },
            score: decayedScore,
          });
        }
      }
    }

    const sorted = results.sort((a, b) => b.score - a.score).slice(0, limit);
    
    // Update last_accessed_at for returned results (if enabled)
    if (updateAccessTime) {
      const now = Date.now();
      const updateStmt = this.db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?");
      for (const result of sorted) {
        updateStmt.run(now, result.entry.id);
        result.entry.last_accessed_at = now;
      }
    }
    
    return sorted;
  }

  /**
   * Vector search with score boosting for specific categories.
   * boostCategories: map of category -> multiplier (e.g. {"work-in-progress": 1.3})
   */
  async vectorSearchBoosted(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
    boostCategories: Record<string, number> = {},
  ): Promise<MemorySearchResult[]> {
    const results = await this.vectorSearch(queryEmbedding, limit * 2, minScore);

    for (const r of results) {
      const boost = boostCategories[r.entry.category];
      if (boost) {
        r.score = Math.min(r.score * boost, 1.0);
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async addEdge(fromId: string, toId: string, relation: string): Promise<void> {
    this.db.prepare(
      `INSERT OR IGNORE INTO memory_edges (id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), fromId, toId, relation, Date.now());
  }
  /**
   * Find and optionally merge duplicate memories.
   * Returns array of merge candidates with details.
   */
  async findDuplicates(dryRun: boolean = true): Promise<Array<{
    targetId: string;
    targetContent: string;
    duplicates: Array<{ id: string; content: string; similarity: number }>;
    mergedContent: string;
    mergedTags: string[];
  }>> {
    const allMemories = this.db.prepare(
      "SELECT id, content, embedding, tags, created_at, merge_count FROM memories"
    ).all() as Array<Record<string, unknown>>;
    
    const candidates: Array<{
      targetId: string;
      targetContent: string;
      duplicates: Array<{ id: string; content: string; similarity: number }>;
      mergedContent: string;
      mergedTags: string[];
    }> = [];
    
    const processed = new Set<string>();
    
    for (const memory of allMemories) {
      if (processed.has(memory.id as string)) continue;
      if (!memory.embedding) continue;
      
      let embedding: number[];
      try {
        embedding = this.decodeEmbedding(memory.embedding as Buffer);
      } catch {
        continue;
      }
      
      // Find similar memories
      const similar: Array<{ id: string; content: string; embedding: number[]; tags: string[]; created_at: number; similarity: number }> = [];
      
      for (const other of allMemories) {
        if (other.id === memory.id || processed.has(other.id as string)) continue;
        if (!other.embedding) continue;
        
        let otherEmbedding: number[];
        try {
          otherEmbedding = this.decodeEmbedding(other.embedding as Buffer);
        } catch {
          continue;
        }
        
        const sim = cosineSimilarity(embedding, otherEmbedding);
        if (sim >= 0.85) {
          similar.push({
            id: other.id as string,
            content: other.content as string,
            embedding: otherEmbedding,
            tags: JSON.parse((other.tags as string) || "[]"),
            created_at: other.created_at as number,
            similarity: sim,
          });
        }
      }
      
      // Check if we have a cluster (at least 1 similar memory to form a cluster of 2+)
      if (similar.length >= 1) {
        // Include the current memory in the cluster
        const cluster = [
          {
            id: memory.id as string,
            content: memory.content as string,
            embedding,
            tags: JSON.parse((memory.tags as string) || "[]"),
            created_at: memory.created_at as number,
            similarity: 1.0,
          },
          ...similar,
        ];
        
        // Find the longest content
        const longest = cluster.reduce((prev, curr) => 
          curr.content.length > prev.content.length ? curr : prev
        );
        
        // Union all tags
        const allTags = new Set<string>();
        cluster.forEach(m => m.tags.forEach((t: string) => allTags.add(t)));
        
        // Find earliest created_at
        const earliestCreatedAt = Math.min(...cluster.map(m => m.created_at));
        const target = cluster.find(m => m.created_at === earliestCreatedAt) || cluster[0];
        
        candidates.push({
          targetId: target.id,
          targetContent: target.content.slice(0, 100),
          duplicates: similar.map(s => ({ id: s.id, content: s.content.slice(0, 100), similarity: s.similarity })),
          mergedContent: longest.content,
          mergedTags: Array.from(allTags),
        });
        
        // Mark all as processed
        processed.add(memory.id as string);
        similar.forEach(s => processed.add(s.id));
        
        // If not dry run, perform the merge
        if (!dryRun) {
          const currentMergeCount = (memory.merge_count as number) ?? 0;
          
          // Update the target memory
          this.db.prepare(
            `UPDATE memories SET content = ?, tags = ?, created_at = ?, merge_count = ? WHERE id = ?`,
          ).run(
            longest.content,
            JSON.stringify(Array.from(allTags)),
            earliestCreatedAt,
            currentMergeCount + similar.length,
            target.id
          );
          
          // Delete the duplicates
          for (const dup of similar) {
            this.delete(dup.id);
          }
        }
      }
    }
    
    return candidates;
  }

  async getRelated(memoryId: string, relation?: string): Promise<MemoryEntry[]> {
    const sql = relation
      ? `SELECT m.id, m.content, m.created_at, m.source, m.tags, m.category FROM memories m 
         JOIN memory_edges e ON (e.to_id = m.id OR e.from_id = m.id) 
         WHERE (e.from_id = ? OR e.to_id = ?) AND e.relation = ? AND m.id != ?`
      : `SELECT m.id, m.content, m.created_at, m.source, m.tags, m.category FROM memories m 
         JOIN memory_edges e ON (e.to_id = m.id OR e.from_id = m.id) 
         WHERE (e.from_id = ? OR e.to_id = ?) AND m.id != ?`;

    const params = relation ? [memoryId, memoryId, relation, memoryId] : [memoryId, memoryId, memoryId];
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      embedding: [],
      created_at: row.created_at as number,
      source: row.source as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      category: row.category as string,
    }));
  }

  async delete(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Invalid memory ID: ${id}`);
    }
    this.db.prepare(`DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?`).run(id, id);
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return true;
  }

  /**
   * Delete all memories matching a specific source tag (for re-indexing).
   */
  async deleteBySource(source: string): Promise<number> {
    // First delete edges referencing these memories
    const ids = this.db.prepare(`SELECT id FROM memories WHERE source = ?`).all(source) as Array<{ id: string }>;
    for (const { id } of ids) {
      this.db.prepare(`DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?`).run(id, id);
    }
    const result = this.db.prepare(`DELETE FROM memories WHERE source = ?`).run(source);
    return result.changes;
  }

  async deleteByQuery(embedding: number[], threshold: number = 0.8): Promise<number> {
    const matches = await this.vectorSearch(embedding, 10, threshold);
    for (const match of matches) await this.delete(match.entry.id);
    return matches.length;
  }

  async count(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
    return row.cnt;
  }

  async getAllContent(limit: number = 100): Promise<string[]> {
    const rows = this.db.prepare(`SELECT content FROM memories ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  /**
   * Get the last capture time (most recent memory created_at).
   */
  async getLastCaptureTime(): Promise<number | null> {
    const row = this.db.prepare("SELECT MAX(created_at) as ts FROM memories").get() as { ts: number | null };
    return row.ts;
  }

  async getProfile(): Promise<ProfileData | null> {
    const row = this.db.prepare("SELECT * FROM profile WHERE id = 'user_profile'").get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      summary: row.summary as string,
      facts: JSON.parse((row.facts as string) || "[]"),
      updated_at: row.updated_at as number,
      capture_count: row.capture_count as number,
    };
  }

  async setProfile(profile: ProfileData): Promise<void> {
    this.db.prepare(
      `INSERT OR REPLACE INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', ?, ?, ?, ?)`,
    ).run(profile.summary, JSON.stringify(profile.facts), profile.updated_at, profile.capture_count);
  }

  async incrementCaptureCount(): Promise<number> {
    const profile = await this.getProfile();
    const newCount = (profile?.capture_count ?? 0) + 1;
    if (profile) {
      this.db.prepare(`UPDATE profile SET capture_count = ? WHERE id = 'user_profile'`).run(newCount);
    } else {
      this.db.prepare(
        `INSERT INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', '', '[]', ?, ?)`,
      ).run(Date.now(), newCount);
    }
    return newCount;
  }

  async stats(): Promise<{ totalMemories: number; categories: Record<string, number>; edgeCount: number; lastCaptureTime: number | null }> {
    const total = await this.count();
    const catRows = this.db.prepare("SELECT category, COUNT(*) as cnt FROM memories GROUP BY category").all() as Array<{ category: string; cnt: number }>;
    const categories: Record<string, number> = {};
    for (const row of catRows) categories[row.category] = row.cnt;
    const edgeRow = this.db.prepare("SELECT COUNT(*) as cnt FROM memory_edges").get() as { cnt: number };
    return { totalMemories: total, categories, edgeCount: edgeRow.cnt, lastCaptureTime: await this.getLastCaptureTime() };
  }

  /**
   * Get memories by priority categories with recency bias.
   * 
   * @param categories - List of category names to filter by
   * @param limit - Maximum number of memories to return
   * @param recencyBias - Weight for recency vs random selection (0-1, higher = more recent)
   * @returns Array of memory entries
   */
  async getMemoriesByCategories(categories: string[], limit: number, recencyBias: number = 0.7): Promise<MemoryEntry[]> {
    if (categories.length === 0) return [];
    
    // Build the category filter
    const placeholders = categories.map(() => "?").join(",");
    
    // Get all matching memories with recency weighting
    // We'll select more than limit, then apply a weighted random selection
    const selectLimit = Math.min(limit * 3, 100); // Get 3x limit for better variety
    
    const rows = this.db.prepare(
      `SELECT id, content, embedding, created_at, source, tags, category, last_accessed_at, merge_count, importance_score, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin 
       FROM memories 
       WHERE category IN (${placeholders})
       ORDER BY created_at DESC 
       LIMIT ?`
    ).all(...categories, selectLimit) as Array<Record<string, unknown>>;
    
    if (rows.length === 0) return [];
    
    // Convert to MemoryEntry objects
    const entries = rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      embedding: this.decodeEmbedding(row.embedding as Buffer),
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
      last_accessed_at: (row.last_accessed_at as number | undefined) ?? undefined,
      merge_count: (row.merge_count as number | undefined) ?? undefined,
      importance_score: (row.importance_score as number | null) ?? 1.0,
      originator_id: (row.originator_id as string) || undefined,
      originator_name: (row.originator_name as string) || undefined,
      destination: (row.destination as string) || undefined,
      status: (row.status as string) || undefined,
      assigned_to: (row.assigned_to as string) || undefined,
      due_at: (row.due_at as number | null) ?? undefined,
      last_checkin: (row.last_checkin as number | null) ?? undefined,
    }));
    
    // If we got fewer than limit, return all
    if (entries.length <= limit) return entries;
    
    // Apply recency bias: recent entries have higher weight
    const now = Date.now();
    const weights = entries.map((entry) => {
      const ageMs = now - entry.created_at;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      // Exponential decay with recencyBias controlling the decay rate
      const recencyWeight = Math.exp(-recencyBias * ageDays / 30);
      // Blend with uniform weight (1-recencyBias ensures some randomness)
      const baseWeight = recencyBias * recencyWeight + (1 - recencyBias);
      // Apply importance_score multiplier
      return baseWeight * (entry.importance_score ?? 1.0);
    });
    
    // Weighted random sampling
    const selected: MemoryEntry[] = [];
    const available = [...entries];
    const availableWeights = [...weights];
    
    for (let i = 0; i < limit && available.length > 0; i++) {
      // Calculate cumulative weights
      const totalWeight = availableWeights.reduce((sum, w) => sum + w, 0);
      let random = Math.random() * totalWeight;
      
      // Select index based on weight
      let selectedIndex = 0;
      for (let j = 0; j < availableWeights.length; j++) {
        random -= availableWeights[j];
        if (random <= 0) {
          selectedIndex = j;
          break;
        }
      }
      
      selected.push(available[selectedIndex]);
      available.splice(selectedIndex, 1);
      availableWeights.splice(selectedIndex, 1);
    }
    
    // Return in reverse chronological order
    return selected.sort((a, b) => b.created_at - a.created_at);
  }

  // ========================================================================
  // Sync support
  // ========================================================================

  /**
   * Get all memories created after the given timestamp.
   * Returns lightweight entries without embeddings (to minimize bandwidth).
   */
  async getMemoriesSince(timestamp: number): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    const rows = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin FROM memories WHERE created_at > ? ORDER BY created_at ASC`,
    ).all(timestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
      originator_id: (row.originator_id as string) || undefined,
      originator_name: (row.originator_name as string) || undefined,
      destination: (row.destination as string) || undefined,
      status: (row.status as string) || undefined,
      assigned_to: (row.assigned_to as string) || undefined,
      due_at: (row.due_at as number | null) ?? undefined,
      last_checkin: (row.last_checkin as number | null) ?? undefined,
    }));
  }

  /**
   * Lightweight list of all memory IDs and timestamps for diffing.
   */
  async getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>> {
    const rows = this.db.prepare(`SELECT id, created_at FROM memories`).all() as Array<{ id: string; created_at: number }>;
    return rows;
  }

  /**
   * Fetch raw (no embedding) memory entries by ID.
   */
  async getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin FROM memories WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
      originator_id: (row.originator_id as string) || undefined,
      originator_name: (row.originator_name as string) || undefined,
      destination: (row.destination as string) || undefined,
      status: (row.status as string) || undefined,
      assigned_to: (row.assigned_to as string) || undefined,
      due_at: (row.due_at as number | null) ?? undefined,
      last_checkin: (row.last_checkin as number | null) ?? undefined,
    }));
  }

  /**
   * Store a memory entry without embedding (used for sync receive).
   * Preserves the remote `id` and `created_at`.
   */
  async storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean> {
    // Fast path: update if exists.
    const existing = this.db.prepare(`SELECT id FROM memories WHERE id = ?`).get(entry.id) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE memories SET content = ?, created_at = ?, source = ?, tags = ?, category = ?, originator_id = ?, originator_name = ?, destination = ?, status = ?, assigned_to = ?, due_at = ?, last_checkin = ? WHERE id = ?`,
      ).run(entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other", entry.originator_id ?? "", entry.originator_name ?? "", entry.destination ?? "", entry.status ?? "", entry.assigned_to ?? "", entry.due_at ?? null, entry.last_checkin ?? null, entry.id);
      return true;
    }

    // Best-effort exact-content dedupe (avoid obvious duplicates if two peers generated different IDs).
    const dup = this.db.prepare(`SELECT id FROM memories WHERE content = ? LIMIT 1`).get(entry.content) as { id: string } | undefined;
    if (dup) return false;

    this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, originator_id, originator_name, destination, status, assigned_to, due_at, last_checkin) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entry.id, entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other", entry.originator_id ?? "", entry.originator_name ?? "", entry.destination ?? "", entry.status ?? "", entry.assigned_to ?? "", entry.due_at ?? null, entry.last_checkin ?? null);

    return true;
  }

  /** Attach or update embedding for an existing memory. */
  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    this.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(this.encodeEmbedding(embedding), id);
  }

  async getLastSyncTime(peerId: string): Promise<number> {
    const row = this.db.prepare(`SELECT last_sync_at FROM sync_state WHERE peer_id = ?`).get(peerId) as { last_sync_at: number } | undefined;
    return row?.last_sync_at ?? 0;
  }

  async setLastSyncTime(peerId: string, timestamp: number): Promise<void> {
    this.db.prepare(
      `INSERT INTO sync_state (peer_id, last_sync_at) VALUES (?, ?) ON CONFLICT(peer_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`,
    ).run(peerId, timestamp);
  }

  /**
   * Update attribution/task fields for an existing memory.
   * Only the fields present in the opts object are updated.
   */
  async updateAttribution(id: string, opts: { status?: string; assigned_to?: string; due_at?: number | null; last_checkin?: number | null; destination?: string }): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (opts.status !== undefined) { sets.push("status = ?"); values.push(opts.status); }
    if (opts.assigned_to !== undefined) { sets.push("assigned_to = ?"); values.push(opts.assigned_to); }
    if ("due_at" in opts) { sets.push("due_at = ?"); values.push(opts.due_at ?? null); }
    if ("last_checkin" in opts) { sets.push("last_checkin = ?"); values.push(opts.last_checkin ?? null); }
    if (opts.destination !== undefined) { sets.push("destination = ?"); values.push(opts.destination); }

    if (sets.length === 0) return false;

    values.push(id);
    const result = this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  /**
   * Update last_accessed_at for a specific memory (for testing).
   */
  updateLastAccessedAt(id: string, timestamp: number): void {
    this.db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(timestamp, id);
  }

  /**
   * Set the importance score for a memory to boost or reduce its recall weight.
   * Values > 1.0 boost the memory; values < 1.0 reduce it.
   * Use this to preserve high-value memories or deprioritize low-value ones.
   */
  setImportanceScore(id: string, score: number): void {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error("importance_score must be a finite number between 0 and 100");
    }
    this.db.prepare("UPDATE memories SET importance_score = ? WHERE id = ?").run(score, id);
  }

  async isOpen(): Promise<boolean> {
    if (this.closed) return false;
    try {
      // better-sqlite3 throws if the connection is closed
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async reopen(): Promise<void> {
    // Best-effort: close existing handle if still open
    try {
      if (!this.closed) this.db.close();
    } catch {
      // ignore
    }

    this.db = createRequire(import.meta.url)("better-sqlite3")(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  /**
   * Get the database file size in bytes.
   *
   * In WAL mode, the on-disk footprint can include sidecar files:
   *   - <db>.wal
   *   - <db>.shm
   * We best-effort sum the sizes of the main DB file and these sidecars.
   */
  getDbSize(): number {
    let totalSize = 0;

    const paths = [
      this.dbPath,
      `${this.dbPath}-wal`,
      `${this.dbPath}-shm`,
    ];

    for (const path of paths) {
      try {
        const stat = statSync(path);
        totalSize += stat.size;
      } catch {
        // Ignore missing or inaccessible files; treat them as size 0.
      }
    }

    return totalSize;
  }

  /**
   * Get capture rate data for the last N days.
   * Returns an array of {date, count} objects.
   */
  getCaptureRateHistory(days: number = 7): Array<{ date: string; count: number }> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const result: Array<{ date: string; count: number }> = [];

    // Prepare statement once for reuse
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories WHERE created_at >= ? AND created_at < ?`
    );

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i * dayMs);
      const dayEnd = dayStart + dayMs;
      
      const count = stmt.get(dayStart, dayEnd) as { cnt: number };

      const date = new Date(dayStart);
      const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
      
      result.push({ date: dayName, count: count.cnt });
    }

    return result;
  }

  /**
   * Extract top topics from profile or from memory tags.
   */
  getTopTopics(limit: number = 3): Array<{ topic: string; count: number }> {
    // Extract tech tags from a bounded set of recent memories that are likely to have tech tags
    const MAX_MEMORIES_FOR_TOPICS = 5000;
    const rows = this.db
      .prepare(
        `SELECT tags FROM memories
         WHERE tags LIKE '%tech:%'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(MAX_MEMORIES_FOR_TOPICS) as Array<{ tags: string }>;
    const tagCounts = new Map<string, number>();

    for (const row of rows) {
      let tags: string[] = [];
      if (row.tags) {
        try {
          tags = JSON.parse(row.tags) as string[];
        } catch {
          // Malformed JSON in tags column; treat as no tags for this row
          tags = [];
        }
      }
      for (const tag of tags) {
        if (tag.startsWith("tech:")) {
          const topic = tag.slice(5); // Remove "tech:" prefix
          tagCounts.set(topic, (tagCounts.get(topic) || 0) + 1);
        }
      }
    }

    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([topic, count]) => ({ topic, count }));
  }

  /**
   * Generate a daily summary from memories created on a specific date.
   * Stores the summary as a memory with category 'daily-summary' and tag 'daily-summary:YYYY-MM-DD'.
   */
  async generateDailySummary(date: string): Promise<DailySummary> {
    // Parse date and get start/end timestamps for the day
    const dateObj = new Date(date + 'T00:00:00.000Z');
    const startOfDay = dateObj.getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    // Get all memories for this date
    const rows = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category FROM memories 
       WHERE created_at >= ? AND created_at < ? AND category != 'daily-summary'
       ORDER BY created_at ASC`
    ).all(startOfDay, endOfDay) as Array<Record<string, unknown>>;

    const memories = rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
    }));

    // Group by category
    const categorizedMemories = new Map<string, Array<{ content: string; created_at: number }>>();
    const categoryCounts: Record<string, number> = {};
    
    for (const mem of memories) {
      if (!categorizedMemories.has(mem.category)) {
        categorizedMemories.set(mem.category, []);
      }
      categorizedMemories.get(mem.category)!.push({
        content: mem.content,
        created_at: mem.created_at
      });
      categoryCounts[mem.category] = (categoryCounts[mem.category] || 0) + 1;
    }

    // Generate markdown summary
    const sections: string[] = [];
    sections.push(`# Daily Summary - ${date}`);
    sections.push('');
    sections.push(`**Total Memories**: ${memories.length}`);
    sections.push('');

    // Sort categories by importance
    const categoryOrder = [
      'decision', 
      'project', 
      'work-in-progress',
      'architecture-decision',
      'error-fix',
      'code-pattern',
      'preference',
      'explicit',
      'entity',
      'conversation',
      'other'
    ];

    const sortedCategories = Array.from(categorizedMemories.keys()).sort((a, b) => {
      const indexA = categoryOrder.indexOf(a);
      const indexB = categoryOrder.indexOf(b);
      if (indexA === -1 && indexB === -1) return a.localeCompare(b);
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });

    for (const category of sortedCategories) {
      const items = categorizedMemories.get(category)!;
      const categoryTitle = category
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      sections.push(`## ${categoryTitle} (${items.length})`);
      sections.push('');
      
      for (const item of items) {
        const time = new Date(item.created_at).toISOString().substring(11, 16); // HH:MM (UTC)
        sections.push(`- **${time} UTC**: ${item.content}`);
      }
      sections.push('');
    }

    const summaryMarkdown = sections.join('\n');

    // Store the summary as a memory (without embedding for now), but only if there are memories
    const now = Date.now();

    if (memories.length > 0) {
      // Check if a summary already exists for this date and delete it to prevent duplicates
      const existingSummaries = this.db.prepare(
        `SELECT id FROM memories WHERE category = 'daily-summary' AND tags LIKE ?`
      ).all(`%daily-summary:${date}%`) as Array<{ id: string }>;
      
      for (const existing of existingSummaries) {
        this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(existing.id);
      }
      
      const summaryId = randomUUID();
      const tags = [
        `daily-summary:${date}`,
        `categories:${JSON.stringify(categoryCounts)}`
      ];
      
      this.db.prepare(
        `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, merge_count) 
         VALUES (?, ?, NULL, ?, ?, ?, ?, 0)`
      ).run(
        summaryId,
        summaryMarkdown,
        now,
        'daily-summary',
        JSON.stringify(tags),
        'daily-summary'
      );
    }
    return {
      date,
      summary: summaryMarkdown,
      memoryCount: memories.length,
      categories: categoryCounts,
      created_at: now,
    };
  }

  /**
   * Get daily summaries for the last N days.
   */
  async getDailySummaries(days: number): Promise<DailySummary[]> {
    const now = Date.now();
    const startTime = now - (days * 24 * 60 * 60 * 1000);

    const rows = this.db.prepare(
      `SELECT content, created_at, tags FROM memories 
       WHERE category = 'daily-summary' AND created_at >= ?
       ORDER BY created_at DESC`
    ).all(startTime) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const tags = JSON.parse((row.tags as string) || "[]") as string[];
      const dateTag = tags.find(t => t.startsWith('daily-summary:'));
      const date = dateTag ? dateTag.substring('daily-summary:'.length) : 'unknown';
      
      // Try to get categories from tags first (robust method)
      const categoriesTag = tags.find(t => t.startsWith('categories:'));
      let categories: Record<string, number> = {};
      let totalCount = 0;
      
      if (categoriesTag) {
        try {
          categories = JSON.parse(categoriesTag.substring('categories:'.length));
          totalCount = Object.values(categories).reduce((sum, count) => sum + count, 0);
        } catch {
          // Fall back to parsing if JSON parsing fails
        }
      }
      
      // Fallback: parse categories from summary content if not in tags
      if (Object.keys(categories).length === 0) {
        const content = row.content as string;
        const categoryMatches = content.matchAll(/^## (.+?) \((\d+)\)$/gm);
        
        for (const match of categoryMatches) {
          const categoryName = match[1].toLowerCase().replace(/\s+/g, '-');
          const count = parseInt(match[2], 10);
          categories[categoryName] = count;
          totalCount += count;
        }
      }

      return {
        date,
        summary: row.content as string,
        memoryCount: totalCount,
        categories,
        created_at: row.created_at as number,
      };
    });
  }

  /**
   * Find stale memories that haven't been accessed in the specified number of days.
   * Returns memories with their staleness score (days since last access).
   */
  async findStaleMemories(daysThreshold: number = 30): Promise<Array<{ id: string; content: string; category: string; priority: MemoryPriority; daysSinceAccess: number }>> {
    const now = Date.now();
    const thresholdMs = daysThreshold * 24 * 60 * 60 * 1000;
    
    const rows = this.db.prepare(
      `SELECT id, content, category, priority, tags, created_at, last_accessed_at FROM memories`
    ).all() as Array<Record<string, unknown>>;
    
    const staleMemories: Array<{ id: string; content: string; category: string; priority: MemoryPriority; daysSinceAccess: number }> = [];
    
    for (const row of rows) {
      const lastAccess = (row.last_accessed_at as number | null) ?? (row.created_at as number);
      const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24);
      
      // Skip critical and permanent memories
      const tags = JSON.parse((row.tags as string) || "[]");
      const priority = (row.priority as MemoryPriority) ?? "normal";
      if (priority === "critical" || tags.includes("permanent")) {
        continue;
      }
      
      if (daysSinceAccess >= daysThreshold) {
        staleMemories.push({
          id: row.id as string,
          content: row.content as string,
          category: row.category as string,
          priority,
          daysSinceAccess: Math.floor(daysSinceAccess),
        });
      }
    }
    
    return staleMemories.sort((a, b) => b.daysSinceAccess - a.daysSinceAccess);
  }

  /**
   * Demote stale memories by lowering their priority.
   * Returns the number of memories demoted.
   */
  async demoteStaleMemories(daysThreshold: number = 30): Promise<number> {
    const staleMemories = await this.findStaleMemories(daysThreshold);
    let demoted = 0;
    
    const updateStmt = this.db.prepare(`UPDATE memories SET priority = ? WHERE id = ?`);
    
    for (const memory of staleMemories) {
      // Demote: high -> normal, normal -> low
      let newPriority: MemoryPriority;
      if (memory.priority === "high") {
        newPriority = "normal";
      } else if (memory.priority === "normal") {
        newPriority = "low";
      } else {
        continue; // Already low, skip
      }
      
      updateStmt.run(newPriority, memory.id);
      demoted++;
    }
    
    return demoted;
  }

  /**
   * Run periodic consolidation:
   * 1. Merge duplicate/similar memories
   * 2. Demote old conversation fragments
   * 3. Promote reinforced facts (high merge_count)
   * Returns stats about the consolidation.
   */
  async runConsolidation(opts: { 
    stalenessDays?: number; 
    dryRun?: boolean;
  } = {}): Promise<{
    duplicatesMerged: number;
    memoriesDemoted: number;
    memoriesPromoted: number;
  }> {
    const stalenessDays = opts.stalenessDays ?? 30;
    const dryRun = opts.dryRun ?? false;
    
    let duplicatesMerged = 0;
    let memoriesDemoted = 0;
    let memoriesPromoted = 0;
    
    // 1. Find and merge duplicates
    const duplicateClusters = await this.findDuplicates(true);
    if (!dryRun && duplicateClusters.length > 0) {
      // Actually merge duplicates
      await this.findDuplicates(false);
      duplicatesMerged = duplicateClusters.reduce((sum, cluster) => sum + cluster.duplicates.length, 0);
    } else {
      duplicatesMerged = duplicateClusters.reduce((sum, cluster) => sum + cluster.duplicates.length, 0);
    }
    
    // 2. Demote stale memories
    if (!dryRun) {
      memoriesDemoted = await this.demoteStaleMemories(stalenessDays);
    } else {
      const staleMemories = await this.findStaleMemories(stalenessDays);
      memoriesDemoted = staleMemories.filter(m => m.priority !== "low").length;
    }
    
    // 3. Promote reinforced facts (high merge_count)
    if (!dryRun) {
      const rows = this.db.prepare(
        `SELECT id, priority, merge_count FROM memories WHERE merge_count >= 3 AND priority = 'normal'`
      ).all() as Array<{ id: string; priority: string; merge_count: number }>;
      
      const updateStmt = this.db.prepare(`UPDATE memories SET priority = 'high' WHERE id = ?`);
      for (const row of rows) {
        updateStmt.run(row.id);
        memoriesPromoted++;
      }
    } else {
      const rows = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM memories WHERE merge_count >= 3 AND priority = 'normal'`
      ).get() as { cnt: number };
      memoriesPromoted = rows.cnt;
    }
    
    return { duplicatesMerged, memoriesDemoted, memoriesPromoted };
  }

  /**
   * Generate a "state of the world" summary from high-priority and recently accessed memories.
   * This can replace manual MEMORY.md curation.
   */
  async generateWorldState(): Promise<string> {
    // Get critical and high priority memories
    const highPriorityRows = this.db.prepare(
      `SELECT content, category, tags, priority FROM memories 
       WHERE priority IN ('critical', 'high')
       ORDER BY priority DESC, last_accessed_at DESC NULLS LAST
       LIMIT 50`
    ).all() as Array<{ content: string; category: string; tags: string; priority: string }>;
    
    // Group by category
    const byCategory = new Map<string, string[]>();
    for (const row of highPriorityRows) {
      const category = row.category;
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(row.content);
    }
    
    // Build summary
    const sections: string[] = [];
    sections.push("# Memory State Summary\n");
    sections.push(`Generated: ${new Date().toISOString()}\n`);
    
    // Sort categories by importance
    const categoryOrder = ["explicit", "decision", "preference", "entity", "project", "architecture-decision"];
    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    
    for (const category of sortedCategories) {
      const items = byCategory.get(category)!;
      sections.push(`\n## ${category.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}\n`);
      for (const item of items) {
        sections.push(`- ${item}`);
      }
    }
    
    return sections.join("\n");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.closed = true;
    }
  }

  /** Returns the byte length of the first stored embedding, or null if no embeddings exist. */
  async getEmbeddingByteLength(): Promise<number | null> {
    const row = this.db.prepare(
      `SELECT LENGTH(embedding) as len FROM memories WHERE embedding IS NOT NULL LIMIT 1`
    ).get() as { len: number } | undefined;
    return row?.len ?? null;
  }

  // ── Conversation Tagging ────────────────────────────────────────────────────

  /**
   * Generate a short human-readable label from message content.
   * Extracts the first few significant words (>3 chars) as the tag label.
   */
  private generateTagLabel(content: string): string {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4);
    return words.length > 0 ? words.join(" ") : content.slice(0, 40).trim();
  }

  /**
   * Update a conversation tag's centroid embedding (running average) and append the new message ID.
   */
  private addMemoryToTag(tagId: string, memoryId: string, newEmbedding: number[]): void {
    const tag = this.db.prepare(
      "SELECT embedding, message_ids FROM conversation_tags WHERE id = ?"
    ).get(tagId) as { embedding: Buffer; message_ids: string } | undefined;

    if (!tag) return;

    const messageIds: string[] = JSON.parse(tag.message_ids || "[]");
    if (messageIds.includes(memoryId)) return;

    messageIds.push(memoryId);

    // Update centroid: running average over all member messages
    const currentCentroid = this.decodeEmbedding(tag.embedding);
    const count = messageIds.length;
    const updatedCentroid = currentCentroid.map(
      (v, i) => (v * (count - 1) + newEmbedding[i]) / count
    );

    const now = Date.now();
    this.db.prepare(
      "UPDATE conversation_tags SET embedding = ?, message_ids = ?, updated_at = ? WHERE id = ?"
    ).run(this.encodeEmbedding(updatedCentroid), JSON.stringify(messageIds), now, tagId);
  }

  /**
   * Find the conversation tag to assign a new memory to, or create a new tag.
   *
   * Algorithm:
   *   1. Compare the message embedding to all existing tag centroids.
   *   2. If similarity >= similarityThreshold: assign to the best-matching tag.
   *   3. Else if similarity >= parentThreshold: create a new child tag under the closest match.
   *   4. Else: create a new root tag.
   *
   * Returns the list of tag IDs assigned (currently always one).
   */
  private assignConversationTag(
    memoryId: string,
    embedding: number[],
    content: string,
    similarityThreshold: number = 0.85,
    parentThreshold: number = 0.7,
  ): string[] {
    const tagRows = this.db.prepare(
      "SELECT id, embedding, message_ids, similarity_threshold FROM conversation_tags WHERE embedding IS NOT NULL"
    ).all() as Array<{ id: string; embedding: Buffer; message_ids: string; similarity_threshold: number }>;

    let bestMatchId: string | null = null;
    let bestMatchSim = -1;
    let potentialParentId: string | null = null;
    let potentialParentSim = -1;

    for (const tag of tagRows) {
      const tagEmbedding = this.decodeEmbedding(tag.embedding);
      const sim = cosineSimilarity(embedding, tagEmbedding);
      const threshold = tag.similarity_threshold ?? similarityThreshold;

      if (sim >= threshold && sim > bestMatchSim) {
        bestMatchSim = sim;
        bestMatchId = tag.id;
      } else if (sim >= parentThreshold && sim > potentialParentSim) {
        potentialParentSim = sim;
        potentialParentId = tag.id;
      }
    }

    if (bestMatchId) {
      // Assign to the best-matching existing tag and update its centroid
      this.addMemoryToTag(bestMatchId, memoryId, embedding);
      return [bestMatchId];
    }

    // Create a new tag, optionally with a parent
    const newTagId = randomUUID();
    const now = Date.now();
    const label = this.generateTagLabel(content);
    const parentId = potentialParentId ?? null;

    this.db.prepare(
      `INSERT INTO conversation_tags (id, label, embedding, parent_tag_id, message_ids, created_at, updated_at, similarity_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newTagId, label, this.encodeEmbedding(embedding), parentId, JSON.stringify([memoryId]), now, now, similarityThreshold);

    return [newTagId];
  }

  /**
   * Return all conversation tags, most recently updated first.
   */
  async getConversationTags(): Promise<ConversationTag[]> {
    const rows = this.db.prepare(
      "SELECT id, label, embedding, parent_tag_id, message_ids, created_at, updated_at, similarity_threshold FROM conversation_tags ORDER BY updated_at DESC"
    ).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      label: row.label as string,
      embedding: row.embedding ? this.decodeEmbedding(row.embedding as Buffer) : [],
      parent_tag_id: (row.parent_tag_id as string | null) ?? undefined,
      message_ids: JSON.parse((row.message_ids as string) || "[]"),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      similarity_threshold: row.similarity_threshold as number,
    }));
  }

  /**
   * Return all memories belonging to a given conversation tag, ordered by timestamp.
   */
  async getMessagesForTag(tagId: string): Promise<MemoryEntry[]> {
    const tagRow = this.db.prepare(
      "SELECT message_ids FROM conversation_tags WHERE id = ?"
    ).get(tagId) as { message_ids: string } | undefined;

    if (!tagRow) return [];

    const messageIds: string[] = JSON.parse(tagRow.message_ids || "[]");
    if (messageIds.length === 0) return [];

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT id, content, embedding, created_at, source, tags, category, priority, last_accessed_at, merge_count, importance_score, conversation_tag_ids
       FROM memories WHERE id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...messageIds) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      embedding: row.embedding ? this.decodeEmbedding(row.embedding as Buffer) : [],
      created_at: row.created_at as number,
      source: row.source as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      category: row.category as string,
      priority: (row.priority as MemoryPriority) ?? "normal",
      last_accessed_at: row.last_accessed_at as number | undefined,
      merge_count: row.merge_count as number | undefined,
      importance_score: (row.importance_score as number | null) ?? 1.0,
      conversation_tag_ids: JSON.parse((row.conversation_tag_ids as string) || "[]"),
    }));
  }

  /**
   * Return tags related to the given tag: its siblings (same parent), its parent, and its children.
   */
  async getRelatedTags(tagId: string): Promise<ConversationTag[]> {
    const tag = this.db.prepare(
      "SELECT parent_tag_id FROM conversation_tags WHERE id = ?"
    ).get(tagId) as { parent_tag_id: string | null } | undefined;

    if (!tag) return [];

    const related = new Map<string, ConversationTag>();

    const addRow = (row: Record<string, unknown>) => {
      if (row.id === tagId) return;
      related.set(row.id as string, {
        id: row.id as string,
        label: row.label as string,
        embedding: row.embedding ? this.decodeEmbedding(row.embedding as Buffer) : [],
        parent_tag_id: (row.parent_tag_id as string | null) ?? undefined,
        message_ids: JSON.parse((row.message_ids as string) || "[]"),
        created_at: row.created_at as number,
        updated_at: row.updated_at as number,
        similarity_threshold: row.similarity_threshold as number,
      });
    };

    const selectCols = "id, label, embedding, parent_tag_id, message_ids, created_at, updated_at, similarity_threshold";

    // Children of this tag
    const children = this.db.prepare(
      `SELECT ${selectCols} FROM conversation_tags WHERE parent_tag_id = ?`
    ).all(tagId) as Array<Record<string, unknown>>;
    children.forEach(addRow);

    if (tag.parent_tag_id) {
      // Parent tag
      const parent = this.db.prepare(
        `SELECT ${selectCols} FROM conversation_tags WHERE id = ?`
      ).get(tag.parent_tag_id) as Record<string, unknown> | undefined;
      if (parent) addRow(parent);

      // Siblings (same parent, excluding self)
      const siblings = this.db.prepare(
        `SELECT ${selectCols} FROM conversation_tags WHERE parent_tag_id = ? AND id != ?`
      ).all(tag.parent_tag_id, tagId) as Array<Record<string, unknown>>;
      siblings.forEach(addRow);
    }

    return Array.from(related.values());
  }
}
