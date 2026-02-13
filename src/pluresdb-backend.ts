/**
 * PluresDB storage backend - drop-in replacement for better-sqlite3
 * 
 * Provides the same interface as MemoryDB but uses PluresDB native backend
 * for CRDT sync, vector search, and P2P capabilities.
 */

import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemorySearchResult, ProfileData } from "./memory-db.js";

// Import types - will be available when @plures/pluresdb is installed
type PluresDBDatabase = any;
type PluresDBStatement = any;

export class PluresDBBackend {
  private db: PluresDBDatabase | null;
  private dbPath: string;
  private closed = false;

  constructor(dbPath: string, _vectorDimension: number) {
    this.dbPath = dbPath;
    // PluresDB initialization will happen in init()
    this.db = null;
  }

  private async init(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency
      // @ts-ignore - optional peer dependency
      const pluresdb = await import("@plures/pluresdb/better-sqlite3");
      const { BetterSQLite3Database } = pluresdb;
      
      this.db = new BetterSQLite3Database(this.dbPath, { 
        autoStart: true,
        verbose: console.log 
      });
      
      await this.db.open();
      
      // PluresDB async pragma calls
      await this.db.pragma("journal_mode = WAL");
      await this.db.pragma("foreign_keys = ON");
      
      await this.createTables();
      this.closed = false;
    } catch (error) {
      throw new Error(
        `Failed to initialize PluresDB backend: ${error instanceof Error ? error.message : String(error)}. ` +
        `Make sure @plures/pluresdb is installed: npm install @plures/pluresdb`
      );
    }
  }

  private async createTables(): Promise<void> {
    await this.db.exec(`
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

  private cosineSimilarity(a: number[], b: number[]): number {
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

  async store(
    content: string,
    embedding: number[],
    opts: { source?: string; tags?: string[]; category?: string; dedupeThreshold?: number },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
    await this.ensureInitialized();
    
    const threshold = opts.dedupeThreshold ?? 0.95;
    const existing = await this.vectorSearch(embedding, 1, threshold);

    if (existing.length > 0) {
      const ex = existing[0].entry;
      const now = Date.now();
      const stmt = this.db.prepare(
        `UPDATE memories SET content = ?, embedding = ?, created_at = ?, source = ?, tags = ?, category = ? WHERE id = ?`,
      );
      await stmt.run(content, this.encodeEmbedding(embedding), now, opts.source ?? "", JSON.stringify(opts.tags ?? []), opts.category ?? ex.category, ex.id);
      return { entry: { ...ex, content, embedding, created_at: now }, isDuplicate: true, updatedId: ex.id };
    }

    const id = randomUUID();
    const now = Date.now();
    const entry: MemoryEntry = {
      id, content, embedding, created_at: now,
      source: opts.source ?? "", tags: opts.tags ?? [], category: opts.category ?? "other",
    };

    const stmt = this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    await stmt.run(id, content, this.encodeEmbedding(embedding), now, entry.source, JSON.stringify(entry.tags), entry.category);

    return { entry, isDuplicate: false };
  }

  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();
    
    const stmt = this.db.prepare(
      "SELECT id, content, embedding, created_at, source, tags, category FROM memories",
    );
    const rows = await stmt.all() as Array<Record<string, unknown>>;

    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      let stored: number[];
      try {
        stored = this.decodeEmbedding(row.embedding as Buffer);
      } catch {
        continue;
      }

      const score = this.cosineSimilarity(queryEmbedding, stored);
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
    await this.ensureInitialized();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO memory_edges (id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    await stmt.run(randomUUID(), fromId, toId, relation, Date.now());
  }

  async getRelated(memoryId: string, relation?: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    
    const sql = relation
      ? `SELECT m.id, m.content, m.created_at, m.source, m.tags, m.category FROM memories m 
         JOIN memory_edges e ON (e.to_id = m.id OR e.from_id = m.id) 
         WHERE (e.from_id = ? OR e.to_id = ?) AND e.relation = ? AND m.id != ?`
      : `SELECT m.id, m.content, m.created_at, m.source, m.tags, m.category FROM memories m 
         JOIN memory_edges e ON (e.to_id = m.id OR e.from_id = m.id) 
         WHERE (e.from_id = ? OR e.to_id = ?) AND m.id != ?`;

    const params = relation ? [memoryId, memoryId, relation, memoryId] : [memoryId, memoryId, memoryId];
    const stmt = this.db.prepare(sql);
    const rows = await stmt.all(...params) as Array<Record<string, unknown>>;

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
    await this.ensureInitialized();
    
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Invalid memory ID: ${id}`);
    }
    
    const edgeStmt = this.db.prepare(`DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?`);
    await edgeStmt.run(id, id);
    
    const memStmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    await memStmt.run(id);
    
    return true;
  }

  async deleteBySource(source: string): Promise<number> {
    await this.ensureInitialized();
    
    const selectStmt = this.db.prepare(`SELECT id FROM memories WHERE source = ?`);
    const ids = await selectStmt.all(source) as Array<{ id: string }>;
    
    for (const { id } of ids) {
      const edgeStmt = this.db.prepare(`DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?`);
      await edgeStmt.run(id, id);
    }
    
    const deleteStmt = this.db.prepare(`DELETE FROM memories WHERE source = ?`);
    const result = await deleteStmt.run(source);
    return result.changes || 0;
  }

  async deleteByQuery(embedding: number[], threshold: number = 0.8): Promise<number> {
    const matches = await this.vectorSearch(embedding, 10, threshold);
    for (const match of matches) await this.delete(match.entry.id);
    return matches.length;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM memories");
    const row = await stmt.get() as { cnt: number };
    return row.cnt;
  }

  async getAllContent(limit: number = 100): Promise<string[]> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`SELECT content FROM memories ORDER BY created_at DESC LIMIT ?`);
    const rows = await stmt.all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  async getLastCaptureTime(): Promise<number | null> {
    await this.ensureInitialized();
    const stmt = this.db.prepare("SELECT MAX(created_at) as ts FROM memories");
    const row = await stmt.get() as { ts: number | null };
    return row.ts;
  }

  async getProfile(): Promise<ProfileData | null> {
    await this.ensureInitialized();
    const stmt = this.db.prepare("SELECT * FROM profile WHERE id = 'user_profile'");
    const row = await stmt.get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      summary: row.summary as string,
      facts: JSON.parse((row.facts as string) || "[]"),
      updated_at: row.updated_at as number,
      capture_count: row.capture_count as number,
    };
  }

  async setProfile(profile: ProfileData): Promise<void> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', ?, ?, ?, ?)`,
    );
    await stmt.run(profile.summary, JSON.stringify(profile.facts), profile.updated_at, profile.capture_count);
  }

  async incrementCaptureCount(): Promise<number> {
    await this.ensureInitialized();
    const profile = await this.getProfile();
    const newCount = (profile?.capture_count ?? 0) + 1;
    if (profile) {
      const stmt = this.db.prepare(`UPDATE profile SET capture_count = ? WHERE id = 'user_profile'`);
      await stmt.run(newCount);
    } else {
      const stmt = this.db.prepare(
        `INSERT INTO profile (id, summary, facts, updated_at, capture_count) VALUES ('user_profile', '', '[]', ?, ?)`,
      );
      await stmt.run(Date.now(), newCount);
    }
    return newCount;
  }

  async stats(): Promise<{ totalMemories: number; categories: Record<string, number>; edgeCount: number; lastCaptureTime: number | null }> {
    await this.ensureInitialized();
    
    const total = await this.count();
    
    const catStmt = this.db.prepare("SELECT category, COUNT(*) as cnt FROM memories GROUP BY category");
    const catRows = await catStmt.all() as Array<{ category: string; cnt: number }>;
    const categories: Record<string, number> = {};
    for (const row of catRows) categories[row.category] = row.cnt;
    
    const edgeStmt = this.db.prepare("SELECT COUNT(*) as cnt FROM memory_edges");
    const edgeRow = await edgeStmt.get() as { cnt: number };
    
    return { 
      totalMemories: total, 
      categories, 
      edgeCount: edgeRow.cnt, 
      lastCaptureTime: await this.getLastCaptureTime() 
    };
  }

  // Sync support methods
  async getMemoriesSince(timestamp: number): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category FROM memories WHERE created_at > ? ORDER BY created_at ASC`,
    );
    const rows = await stmt.all(timestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
    }));
  }

  async getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`SELECT id, created_at FROM memories`);
    const rows = await stmt.all() as Array<{ id: string; created_at: number }>;
    return rows;
  }

  async getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    if (ids.length === 0) return [];
    await this.ensureInitialized();
    
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `SELECT id, content, created_at, source, tags, category FROM memories WHERE id IN (${placeholders})`,
    );
    const rows = await stmt.all(...ids) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      created_at: row.created_at as number,
      source: (row.source as string) ?? "",
      tags: JSON.parse((row.tags as string) || "[]"),
      category: (row.category as string) ?? "other",
    }));
  }

  async storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean> {
    await this.ensureInitialized();
    
    const existingStmt = this.db.prepare(`SELECT id FROM memories WHERE id = ?`);
    const existing = await existingStmt.get(entry.id) as { id: string } | undefined;

    if (existing) {
      const updateStmt = this.db.prepare(
        `UPDATE memories SET content = ?, created_at = ?, source = ?, tags = ?, category = ? WHERE id = ?`,
      );
      await updateStmt.run(entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other", entry.id);
      return true;
    }

    const dupStmt = this.db.prepare(`SELECT id FROM memories WHERE content = ? LIMIT 1`);
    const dup = await dupStmt.get(entry.content) as { id: string } | undefined;
    if (dup) return false;

    const insertStmt = this.db.prepare(
      `INSERT INTO memories (id, content, embedding, created_at, source, tags, category) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    );
    await insertStmt.run(entry.id, entry.content, entry.created_at, entry.source ?? "", JSON.stringify(entry.tags ?? []), entry.category ?? "other");

    return true;
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`);
    await stmt.run(this.encodeEmbedding(embedding), id);
  }

  async getLastSyncTime(peerId: string): Promise<number> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`SELECT last_sync_at FROM sync_state WHERE peer_id = ?`);
    const row = await stmt.get(peerId) as { last_sync_at: number } | undefined;
    return row?.last_sync_at ?? 0;
  }

  async setLastSyncTime(peerId: string, timestamp: number): Promise<void> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(
      `INSERT INTO sync_state (peer_id, last_sync_at) VALUES (?, ?) ON CONFLICT(peer_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`,
    );
    await stmt.run(peerId, timestamp);
  }

  async isOpen(): Promise<boolean> {
    if (this.closed) return false;
    try {
      if (!this.db) return false;
      const stmt = this.db.prepare("SELECT 1");
      await stmt.get();
      return true;
    } catch {
      return false;
    }
  }

  async reopen(): Promise<void> {
    try {
      if (!this.closed && this.db) await this.db.close();
    } catch {
      // ignore
    }

    await this.init();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.db) await this.db.close();
    } finally {
      this.closed = true;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.db) {
      await this.init();
    }
  }
}
