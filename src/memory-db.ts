/**
 * Memory storage layer using better-sqlite3
 *
 * Embedded SQLite with in-process cosine similarity for vector search.
 * Graph edges stored as a relation table for linking memories.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  created_at: number;
  source: string;
  tags: string[];
  category: string;
  last_accessed_at?: number;
  merge_count?: number;
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

export class MemoryDB {
  private db: Database.Database;
  private dbPath: string;
  private closed = false;
  private decayHalfLifeDays: number = 30; // default

  constructor(dbPath: string, _vectorDimension: number, decayHalfLifeDays: number = 30) {
    this.dbPath = dbPath;
    this.decayHalfLifeDays = decayHalfLifeDays;
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
        last_accessed_at INTEGER,
        merge_count INTEGER DEFAULT 0
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
    // Find top-3 similar memories
    const similar = await this.vectorSearch(embedding, 3, 0.85);
    
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
    opts: { source?: string; tags?: string[]; category?: string; dedupeThreshold?: number; useSemanticDedup?: boolean },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string; merged?: boolean }> {
    const tags = opts.tags ?? [];
    const useSemanticDedup = opts.useSemanticDedup ?? true;
    
    // Semantic dedup v2
    if (useSemanticDedup) {
      const mergeResult = await this.clusterAndMerge(embedding, content, tags);
      if (mergeResult?.shouldMerge && mergeResult.targetId) {
        const now = Date.now();
        const target = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(mergeResult.targetId) as Record<string, unknown>;
        const currentMergeCount = (target.merge_count as number) ?? 0;
        
        this.db.prepare(
          `UPDATE memories SET content = ?, embedding = ?, tags = ?, created_at = ?, merge_count = ? WHERE id = ?`,
        ).run(
          mergeResult.mergedContent,
          this.encodeEmbedding(mergeResult.mergedEmbedding!),
          JSON.stringify(mergeResult.mergedTags),
          mergeResult.earliestCreatedAt,
          currentMergeCount + 1,
          mergeResult.targetId
        );
        
        const updatedEntry: MemoryEntry = {
          id: mergeResult.targetId,
          content: mergeResult.mergedContent!,
          embedding: mergeResult.mergedEmbedding!,
          created_at: mergeResult.earliestCreatedAt!,
          source: opts.source ?? "",
          tags: mergeResult.mergedTags!,
          category: opts.category ?? (target.category as string) ?? "other",
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
      this.db.prepare(
        `UPDATE memories SET content = ?, embedding = ?, created_at = ?, source = ?, tags = ?, category = ? WHERE id = ?`,
      ).run(content, this.encodeEmbedding(embedding), now, opts.source ?? "", JSON.stringify(opts.tags ?? []), opts.category ?? ex.category, ex.id);
      return { entry: { ...ex, content, embedding, created_at: now }, isDuplicate: true, updatedId: ex.id };
    }

    const id = randomUUID();
    const now = Date.now();
    const entry: MemoryEntry = {
      id, content, embedding, created_at: now,
      source: opts.source ?? "", tags: opts.tags ?? [], category: opts.category ?? "other",
      merge_count: 0,
    };

    this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category, merge_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, this.encodeEmbedding(embedding), now, entry.source, JSON.stringify(entry.tags), entry.category, 0);

    return { entry, isDuplicate: false };
  }

  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
  ): Promise<MemorySearchResult[]> {
    const rows = this.db.prepare(
      "SELECT id, content, embedding, created_at, source, tags, category, last_accessed_at, merge_count FROM memories",
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
        const decayedScore = score * decayFactor;
        
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
              last_accessed_at: row.last_accessed_at as number | undefined,
              merge_count: row.merge_count as number | undefined,
            },
            score: decayedScore,
          });
        }
      }
    }

    const sorted = results.sort((a, b) => b.score - a.score).slice(0, limit);
    
    // Update last_accessed_at for returned results
    const now = Date.now();
    const updateStmt = this.db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?");
    for (const result of sorted) {
      updateStmt.run(now, result.entry.id);
      result.entry.last_accessed_at = now;
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
      
      // Check if we have a cluster (2+ similar memories)
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

  addEdge(fromId: string, toId: string, relation: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO memory_edges (id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), fromId, toId, relation, Date.now());
  }

  getRelated(memoryId: string, relation?: string): MemoryEntry[] {
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

  delete(id: string): boolean {
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
  deleteBySource(source: string): number {
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
    for (const match of matches) this.delete(match.entry.id);
    return matches.length;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
    return row.cnt;
  }

  getAllContent(limit: number = 100): string[] {
    const rows = this.db.prepare(`SELECT content FROM memories ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  /**
   * Get the last capture time (most recent memory created_at).
   */
  getLastCaptureTime(): number | null {
    const row = this.db.prepare("SELECT MAX(created_at) as ts FROM memories").get() as { ts: number | null };
    return row.ts;
  }

  getProfile(): ProfileData | null {
    const row = this.db.prepare("SELECT * FROM profile WHERE id = 'user_profile'").get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      summary: row.summary as string,
      facts: JSON.parse((row.facts as string) || "[]"),
      updated_at: row.updated_at as number,
      capture_count: row.capture_count as number,
    };
  }

  setProfile(profile: ProfileData): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', ?, ?, ?, ?)`,
    ).run(profile.summary, JSON.stringify(profile.facts), profile.updated_at, profile.capture_count);
  }

  incrementCaptureCount(): number {
    const profile = this.getProfile();
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

  stats(): { totalMemories: number; categories: Record<string, number>; edgeCount: number; lastCaptureTime: number | null } {
    const total = this.count();
    const catRows = this.db.prepare("SELECT category, COUNT(*) as cnt FROM memories GROUP BY category").all() as Array<{ category: string; cnt: number }>;
    const categories: Record<string, number> = {};
    for (const row of catRows) categories[row.category] = row.cnt;
    const edgeRow = this.db.prepare("SELECT COUNT(*) as cnt FROM memory_edges").get() as { cnt: number };
    return { totalMemories: total, categories, edgeCount: edgeRow.cnt, lastCaptureTime: this.getLastCaptureTime() };
  }

  // ========================================================================
  // Sync support
  // ========================================================================

  /**
   * Get all memories created after the given timestamp.
   * Returns lightweight entries without embeddings (to minimize bandwidth).
   */
  getMemoriesSince(timestamp: number): Array<Omit<MemoryEntry, "embedding">> {
    const rows = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category FROM memories WHERE created_at > ? ORDER BY created_at ASC`,
    ).all(timestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
    }));
  }

  /**
   * Lightweight list of all memory IDs and timestamps for diffing.
   */
  getAllMemoryIds(): Array<{ id: string; created_at: number }> {
    const rows = this.db.prepare(`SELECT id, created_at FROM memories`).all() as Array<{ id: string; created_at: number }>;
    return rows;
  }

  /**
   * Fetch raw (no embedding) memory entries by ID.
   */
  getMemoriesByIds(ids: string[]): Array<Omit<MemoryEntry, "embedding">> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category FROM memories WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
    }));
  }

  /**
   * Store a memory entry without embedding (used for sync receive).
   * Preserves the remote `id` and `created_at`.
   */
  storeRaw(entry: Omit<MemoryEntry, "embedding">): boolean {
    // Fast path: update if exists.
    const existing = this.db.prepare(`SELECT id FROM memories WHERE id = ?`).get(entry.id) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE memories SET content = ?, created_at = ?, source = ?, tags = ?, category = ? WHERE id = ?`,
      ).run(entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other", entry.id);
      return true;
    }

    // Best-effort exact-content dedupe (avoid obvious duplicates if two peers generated different IDs).
    const dup = this.db.prepare(`SELECT id FROM memories WHERE content = ? LIMIT 1`).get(entry.content) as { id: string } | undefined;
    if (dup) return false;

    this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(entry.id, entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other");

    return true;
  }

  /** Attach or update embedding for an existing memory. */
  setEmbedding(id: string, embedding: number[]): void {
    this.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(this.encodeEmbedding(embedding), id);
  }

  getLastSyncTime(peerId: string): number {
    const row = this.db.prepare(`SELECT last_sync_at FROM sync_state WHERE peer_id = ?`).get(peerId) as { last_sync_at: number } | undefined;
    return row?.last_sync_at ?? 0;
  }

  setLastSyncTime(peerId: string, timestamp: number): void {
    this.db.prepare(
      `INSERT INTO sync_state (peer_id, last_sync_at) VALUES (?, ?) ON CONFLICT(peer_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`,
    ).run(peerId, timestamp);
  }

  /**
   * Update last_accessed_at for a specific memory (for testing).
   */
  updateLastAccessedAt(id: string, timestamp: number): void {
    this.db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(timestamp, id);
  }

  isOpen(): boolean {
    if (this.closed) return false;
    try {
      // better-sqlite3 throws if the connection is closed
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  reopen(): void {
    // Best-effort: close existing handle if still open
    try {
      if (!this.closed) this.db.close();
    } catch {
      // ignore
    }

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.closed = true;
    }
  }
}
