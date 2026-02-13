/**
 * Memory storage layer using better-sqlite3
 *
 * Embedded SQLite with in-process cosine similarity for vector search.
 * Graph edges stored as a relation table for linking memories.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  created_at: number;
  source: string;
  tags: string[];
  category: string;
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

export class MemoryDB {
  private db: Database.Database;
  private dbPath: string;
  private closed = false;

  constructor(dbPath: string, _vectorDimension: number) {
    this.dbPath = dbPath;
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
        category TEXT DEFAULT 'other'
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

  private encodeEmbedding(vec: number[]): Buffer {
    return Buffer.from(new Float64Array(vec).buffer);
  }

  private decodeEmbedding(blob: Buffer): number[] {
    const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    return Array.from(new Float64Array(ab));
  }

  async store(
    content: string,
    embedding: number[],
    opts: { source?: string; tags?: string[]; category?: string; dedupeThreshold?: number },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
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
    };

    this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, this.encodeEmbedding(embedding), now, entry.source, JSON.stringify(entry.tags), entry.category);

    return { entry, isDuplicate: false };
  }

  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
  ): Promise<MemorySearchResult[]> {
    const rows = this.db.prepare(
      "SELECT id, content, embedding, created_at, source, tags, category FROM memories",
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
        results.push({
          entry: {
            id: row.id as string,
            content: row.content as string,
            embedding: stored,
            created_at: row.created_at as number,
            source: row.source as string,
            tags: JSON.parse((row.tags as string) || "[]"),
            category: row.category as string,
          },
          score,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
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

  /**
   * Get the database file size in bytes.
   */
  getDbSize(): number {
    try {
      const stat = statSync(this.dbPath);
      return stat.size;
    } catch {
      return 0;
    }
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
    // Extract tech tags from all memories
    const rows = this.db.prepare(`SELECT tags FROM memories`).all() as Array<{ tags: string }>;
    const tagCounts = new Map<string, number>();

    for (const row of rows) {
      const tags = JSON.parse(row.tags || "[]") as string[];
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

  close(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.closed = true;
    }
  }
}
