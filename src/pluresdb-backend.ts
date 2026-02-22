/**
 * PluresDB native CRDT storage backend
 *
 * Replaces the better-sqlite3 compatibility shim with PluresDB's native
 * key-value CRDT API. Memories are stored as PluresDB nodes with automatic
 * vector-clock-based conflict resolution.
 *
 * Requires:
 *   - Deno runtime (https://deno.land/)
 *   - @plures/pluresdb peer dependency
 *
 * Phase 1: Native CRDT store (put/get/list via PluresDB HTTP API)
 * Phase 2: Native vector search via PluresDB BruteForceVectorIndex
 * Phase 3: P2P sync via PluresDB mesh networking (future)
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { MemoryEntry, MemorySearchResult, ProfileData, DailySummary, MemoryPriority, ConversationTag } from "./memory-db.js";
import { determinePriority } from "./memory-db.js";

// Key prefixes used to namespace node types in the CRDT store
const MEM = "memory:";
const EDGE = "edge:";
const PROFILE_KEY = "profile:user_profile";
const SYNC = "sync:";
const CONV_TAG = "conv_tag:";

// Shape of data returned from GET /api/list and POST /api/search
interface ApiNode {
  id: string;
  data: Record<string, unknown>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Derives a stable port in [34569, 35568] from the dbPath to avoid conflicts. */
function derivePort(dbPath: string): number {
  let h = 5381;
  for (let i = 0; i < dbPath.length; i++) {
    h = ((h << 5) - h + dbPath.charCodeAt(i)) | 0;
  }
  return 34569 + (Math.abs(h) % 1000);
}

/** Convert a JSON-parsed value back to a number[]. */
function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x): x is number => typeof x === "number");
}

export class PluresDBBackend {
  private readonly dbPath: string;
  private serverProcess: ChildProcess | null = null;
  private apiBaseUrl: string = "";
  private readonly wsPort: number;
  private readonly apiPort: number;
  private readonly kvPath: string;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string, _vectorDimension: number) {
    this.dbPath = dbPath;
    // Allow override via env var; otherwise derive from dbPath for stable port assignment
    const envPort = process.env.PLURESDB_PORT ? parseInt(process.env.PLURESDB_PORT, 10) : NaN;
    this.wsPort = Number.isFinite(envPort) ? envPort : derivePort(dbPath);
    this.apiPort = this.wsPort + 1;          // PluresDB HTTP API = wsPort + 1
    this.kvPath = dbPath.replace(/\.db$/, ".pluresdb.kv");
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    try {
      // Locate @plures/pluresdb package and its legacy Deno entry point
      const require = createRequire(import.meta.url);
      let pkgRoot: string;
      try {
        pkgRoot = path.dirname(require.resolve("@plures/pluresdb/package.json"));
      } catch {
        throw new Error("@plures/pluresdb is not installed. Run: npm install @plures/pluresdb");
      }

      const legacyMain = path.join(pkgRoot, "legacy", "main.ts");
      if (!fs.existsSync(legacyMain)) {
        throw new Error(`PluresDB Deno entry point not found at ${legacyMain}`);
      }

      const denoPath = this.findDenoPath();
      this.apiBaseUrl = `http://localhost:${this.apiPort}`;

      // Re-use an already-running server on this port (e.g. second open() call)
      if (!(await this.isServerHealthy())) {
        this.serverProcess = spawn(
          denoPath,
          [
            "run", "-A", "--unstable-kv", "--no-lock",
            legacyMain, "serve",
            "--port", this.wsPort.toString(),
            "--kv", this.kvPath,
          ],
          { stdio: ["pipe", "pipe", "pipe"], cwd: path.dirname(legacyMain) },
        );

        this.serverProcess.on("error", (err) => {
          if (process.env.PLURESDB_DEBUG === "true") {
            console.error("[PluresDBBackend] server process error:", err);
          }
        });

        if (process.env.PLURESDB_DEBUG === "true") {
          this.serverProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
          this.serverProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
        }

        await this.waitForServer(20_000);
      }

      this.closed = false;
    } catch (error) {
      throw new Error(
        `Failed to initialize PluresDB native backend: ${error instanceof Error ? error.message : String(error)}. ` +
        `Ensure Deno is installed (https://deno.land/) and @plures/pluresdb is a peer dependency.`,
      );
    }
  }

  private findDenoPath(): string {
    const candidates = [
      "deno",
      path.join(os.homedir(), ".deno", "bin", "deno"),
      path.join(os.homedir(), ".local", "bin", "deno"),
      "/usr/local/bin/deno",
      "/opt/homebrew/bin/deno",
      ...(process.platform === "win32"
        ? [
            path.join(os.homedir(), ".deno", "bin", "deno.exe"),
            "C:\\Program Files\\deno\\deno.exe",
          ]
        : []),
    ];

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* continue */ }
    }

    // Fall back to checking PATH via execSync
    try {
      execSync("deno --version", { stdio: "ignore" });
      return "deno";
    } catch { /* not on PATH */ }

    throw new Error(
      "Deno runtime not found. Install it from https://deno.land/ or set DENO_INSTALL_ROOT.",
    );
  }

  private async isServerHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/config`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForServer(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isServerHealthy()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`PluresDB server did not become ready within ${timeoutMs}ms`);
  }

  async reopen(): Promise<void> {
    await this.close();
    this.initPromise = null;
    await this.ensureInitialized();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.serverProcess) {
      try {
        this.serverProcess.kill("SIGTERM");
      } catch { /* ignore */ }
      this.serverProcess = null;
    }
    this.apiBaseUrl = "";
    this.initPromise = null;
  }

  private ensureInitialized(): Promise<void> {
    if (this.closed) {
      this.closed = false;
      this.initPromise = null;
    }
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }

  // ── PluresDB HTTP API helpers ─────────────────────────────────────────────────

  /**
   * PUT a CRDT node. Uses POST /api/put which stores the node through GunDB's
   * CRDT merge logic (vector clocks, per-field timestamps, automatic conflict resolution).
   */
  private async apiPut(id: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}/api/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, data }),
    });
    if (!res.ok) {
      throw new Error(`PluresDB put(${id}) failed: ${res.status} ${res.statusText}`);
    }
  }

  /**
   * GET a single CRDT node. Returns the data payload (without the id wrapper)
   * or null when the node does not exist.
   * Note: the legacy server returns a flat object { id, ...dataFields } rather
   * than the nested { id, data } shape used by list/search.
   */
  private async apiGet(id: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(
      `${this.apiBaseUrl}/api/get?id=${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`PluresDB get(${id}) failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as Record<string, unknown> | null;
    if (!body || (body as { error?: string }).error) return null;
    // The server returns { id, ...dataFields } — strip the id key
    const { id: _id, ...data } = body as { id: string; [k: string]: unknown };
    return data as Record<string, unknown>;
  }

  /** DELETE a CRDT node by ID. */
  private async apiDelete(id: string): Promise<void> {
    const res = await fetch(
      `${this.apiBaseUrl}/api/delete?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      throw new Error(`PluresDB delete(${id}) failed: ${res.status} ${res.statusText}`);
    }
  }

  /**
   * LIST all CRDT nodes. Returns Array<{ id, data }>.
   * Prefix filtering is done client-side since the legacy server returns all nodes.
   */
  private async apiList(): Promise<ApiNode[]> {
    const res = await fetch(`${this.apiBaseUrl}/api/list`);
    if (!res.ok) {
      throw new Error(`PluresDB list failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<ApiNode[]>;
  }

  /**
   * Vector search via PluresDB's BruteForceVectorIndex.
   * Passes a pre-computed embedding array to POST /api/search.
   * Returns Array<{ id, data }> sorted by cosine similarity (descending).
   * Phase 2: Uses PluresDB's native vector index; falls back to JS-side scan
   * when the index is empty (handled server-side by GunDB).
   */
  private async apiSearch(queryEmbedding: number[], limit: number): Promise<ApiNode[]> {
    const res = await fetch(`${this.apiBaseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: queryEmbedding, limit }),
    });
    if (!res.ok) {
      throw new Error(`PluresDB search failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<ApiNode[]>;
  }

  // ── IMemoryBackend implementation ────────────────────────────────────────────

  async store(
    content: string,
    embedding: number[],
    opts: {
      source?: string;
      tags?: string[];
      category?: string;
      priority?: MemoryPriority;
      dedupeThreshold?: number;
      importanceScore?: number;
    },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
    await this.ensureInitialized();

    const tags = opts.tags ?? [];
    const category = opts.category ?? "other";
    const priority = opts.priority ?? determinePriority(category, tags);
    const importanceScore = opts.importanceScore ?? 1.0;
    const threshold = opts.dedupeThreshold ?? 0.95;

    // Deduplication: use PluresDB vector search (Phase 2 native search)
    const dupeResults = await this.vectorSearch(embedding, 1, threshold);
    if (dupeResults.length > 0) {
      const ex = dupeResults[0].entry;
      const now = Date.now();

      // Merge new opts.* with existing entry metadata so callers can update
      // source/tags/category/importanceScore on dedupe hits.
      const mergedTags = opts.tags ?? ex.tags ?? [];
      const mergedCategory = opts.category ?? ex.category ?? "other";
      const mergedImportanceScore =
        opts.importanceScore ?? ex.importance_score ?? 1.0;
      const mergedSource = opts.source ?? ex.source ?? "";
      const mergedPriority =
        opts.priority ?? determinePriority(mergedCategory, mergedTags);

      const updated: MemoryEntry = {
        ...ex,
        content,
        embedding,
        created_at: now,
        source: mergedSource,
        tags: mergedTags,
        category: mergedCategory,
        importance_score: mergedImportanceScore,
        priority: mergedPriority,
      };
      await this.apiPut(MEM + ex.id, this.entryToNode(updated));
      return { entry: updated, isDuplicate: true, updatedId: ex.id };
    }

    const id = randomUUID();
    const now = Date.now();

    const conversationTagIds = await this.assignConversationTag(id, embedding, content);

    const entry: MemoryEntry = {
      id, content, embedding, created_at: now,
      source: opts.source ?? "", tags, category, priority,
      importance_score: importanceScore,
      conversation_tag_ids: conversationTagIds,
    };

    await this.apiPut(MEM + id, this.entryToNode(entry));
    return { entry, isDuplicate: false };
  }

  /**
   * Phase 2: vector search using PluresDB's native BruteForceVectorIndex.
   * Pre-computed embeddings are stored in the `vector` field of each node,
   * which GunDB indexes automatically on PUT. The server returns results
   * sorted by similarity; we re-compute exact cosine scores for minScore
   * filtering and importance-score boosting.
   */
  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Request more candidates than needed to allow minScore filtering
    const candidates = await this.apiSearch(queryEmbedding, limit * 3 + 10);

    const results: MemorySearchResult[] = [];
    for (const node of candidates) {
      if (!node.id.startsWith(MEM)) continue;
      const d = node.data;
      const stored = toNumberArray(d.vector);
      if (stored.length === 0) continue;

      const rawScore = cosineSimilarity(queryEmbedding, stored);
      const importanceScore = typeof d.importance_score === "number" ? d.importance_score : 1.0;
      const finalScore = rawScore * importanceScore;
      if (finalScore < minScore) continue;

      results.push({
        entry: this.nodeToEntry(d, node.id.slice(MEM.length)),
        score: finalScore,
      });
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
      if (boost) r.score = Math.min(r.score * boost, 1.0);
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async addEdge(fromId: string, toId: string, relation: string): Promise<void> {
    await this.ensureInitialized();
    const id = randomUUID();
    await this.apiPut(EDGE + id, { id, from_id: fromId, to_id: toId, relation, created_at: Date.now() });
  }

  async getRelated(memoryId: string, relation?: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const all = await this.apiList();

    // Collect IDs of the other endpoint for matching edges
    const relatedIds: string[] = [];
    for (const node of all) {
      if (!node.id.startsWith(EDGE)) continue;
      const d = node.data;
      if (d.from_id !== memoryId && d.to_id !== memoryId) continue;
      if (relation && d.relation !== relation) continue;
      const otherId = d.from_id === memoryId ? d.to_id as string : d.from_id as string;
      if (otherId && otherId !== memoryId) relatedIds.push(otherId);
    }

    const entries: MemoryEntry[] = [];
    for (const rid of relatedIds) {
      const data = await this.apiGet(MEM + rid);
      if (data) entries.push(this.nodeToEntry(data, rid));
    }
    return entries;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    // Allow UUIDs as well as stable composite IDs produced by this backend
    // (e.g. "daily-summary:YYYY-MM-DD") and arbitrary peer-sync IDs.
    // Still reject blank or obviously unsafe input.
    if (!id || /[\/\\<>|&;`"']/.test(id)) {
      throw new Error(`Invalid memory ID: ${id}`);
    }

    // Remove all edges that reference this memory — collect then delete in parallel
    const all = await this.apiList();
    const edgesToDelete = all
      .filter((node) => node.id.startsWith(EDGE) && (node.data.from_id === id || node.data.to_id === id))
      .map((node) => this.apiDelete(node.id));
    await Promise.all(edgesToDelete);

    await this.apiDelete(MEM + id);
    return true;
  }

  async deleteBySource(source: string): Promise<number> {
    await this.ensureInitialized();
    const all = await this.apiList();
    const toDelete = all.filter((n) => n.id.startsWith(MEM) && n.data.source === source);
    if (toDelete.length === 0) return 0;

    // Collect all memory IDs being deleted, then remove edges and memories in parallel
    const memIds = new Set(toDelete.map((n) => n.id.slice(MEM.length)));
    const edgeDeletes = all
      .filter(
        (n) => n.id.startsWith(EDGE) && (memIds.has(n.data.from_id as string) || memIds.has(n.data.to_id as string)),
      )
      .map((n) => this.apiDelete(n.id));
    const memDeletes = toDelete.map((n) => this.apiDelete(n.id));
    await Promise.all([...edgeDeletes, ...memDeletes]);

    return toDelete.length;
  }

  async deleteByQuery(embedding: number[], threshold: number = 0.8): Promise<number> {
    const matches = await this.vectorSearch(embedding, 10, threshold);
    for (const match of matches) await this.delete(match.entry.id);
    return matches.length;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    const all = await this.apiList();
    return all.filter((n) => n.id.startsWith(MEM)).length;
  }

  async getAllContent(limit: number = 100): Promise<string[]> {
    await this.ensureInitialized();
    const all = await this.apiList();
    return all
      .filter((n) => n.id.startsWith(MEM))
      .sort((a, b) => (b.data.created_at as number) - (a.data.created_at as number))
      .slice(0, limit)
      .map((n) => n.data.content as string);
  }

  async getLastCaptureTime(): Promise<number | null> {
    await this.ensureInitialized();
    const all = await this.apiList();
    let max: number | null = null;
    for (const n of all) {
      if (!n.id.startsWith(MEM)) continue;
      const t = n.data.created_at as number;
      if (max === null || t > max) max = t;
    }
    return max;
  }

  async getProfile(): Promise<ProfileData | null> {
    await this.ensureInitialized();
    const data = await this.apiGet(PROFILE_KEY);
    if (!data) return null;
    return {
      summary: (data.summary as string) ?? "",
      facts: (data.facts as string[]) ?? [],
      updated_at: (data.updated_at as number) ?? Date.now(),
      capture_count: (data.capture_count as number) ?? 0,
    };
  }

  async setProfile(profile: ProfileData): Promise<void> {
    await this.ensureInitialized();
    await this.apiPut(PROFILE_KEY, {
      summary: profile.summary,
      facts: profile.facts,
      updated_at: profile.updated_at,
      capture_count: profile.capture_count,
    });
  }

  async incrementCaptureCount(): Promise<number> {
    await this.ensureInitialized();
    const profile = await this.getProfile();
    const newCount = (profile?.capture_count ?? 0) + 1;
    await this.apiPut(PROFILE_KEY, {
      summary: profile?.summary ?? "",
      facts: profile?.facts ?? [],
      updated_at: profile?.updated_at ?? Date.now(),
      capture_count: newCount,
    });
    return newCount;
  }

  async stats(): Promise<{
    totalMemories: number;
    categories: Record<string, number>;
    edgeCount: number;
    lastCaptureTime: number | null;
  }> {
    await this.ensureInitialized();
    const all = await this.apiList();

    let edgeCount = 0;
    let lastCaptureTime: number | null = null;
    const categories: Record<string, number> = {};

    for (const node of all) {
      if (node.id.startsWith(MEM)) {
        const cat = (node.data.category as string) ?? "other";
        categories[cat] = (categories[cat] ?? 0) + 1;
        const t = node.data.created_at as number;
        if (lastCaptureTime === null || t > lastCaptureTime) lastCaptureTime = t;
      } else if (node.id.startsWith(EDGE)) {
        edgeCount++;
      }
    }

    return {
      totalMemories: all.filter((n) => n.id.startsWith(MEM)).length,
      categories,
      edgeCount,
      lastCaptureTime,
    };
  }

  async getMemoriesByCategories(
    categories: string[],
    limit: number,
    recencyBias: number = 0.7,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    if (categories.length === 0) return [];

    const catSet = new Set(categories);
    const all = await this.apiList();
    const selectLimit = Math.min(limit * 3, 100);

    const entries = all
      .filter((n) => n.id.startsWith(MEM) && catSet.has(n.data.category as string))
      .sort((a, b) => (b.data.created_at as number) - (a.data.created_at as number))
      .slice(0, selectLimit)
      .map((n) => this.nodeToEntry(n.data, n.id.slice(MEM.length)));

    if (entries.length <= limit) return entries;

    const now = Date.now();
    const weights = entries.map((e) => {
      const ageDays = (now - e.created_at) / (1000 * 60 * 60 * 24);
      const recencyWeight = Math.exp((-recencyBias * ageDays) / 30);
      return recencyBias * recencyWeight + (1 - recencyBias);
    });

    const selected: MemoryEntry[] = [];
    const available = [...entries];
    const availableWeights = [...weights];

    for (let i = 0; i < limit && available.length > 0; i++) {
      const totalWeight = availableWeights.reduce((s, w) => s + w, 0);
      let rand = Math.random() * totalWeight;
      let idx = 0;
      for (let j = 0; j < availableWeights.length; j++) {
        rand -= availableWeights[j];
        if (rand <= 0) { idx = j; break; }
      }
      selected.push(available[idx]);
      available.splice(idx, 1);
      availableWeights.splice(idx, 1);
    }

    return selected.sort((a, b) => b.created_at - a.created_at);
  }

  // ── Sync support methods ─────────────────────────────────────────────────────

  async getMemoriesSince(timestamp: number): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    await this.ensureInitialized();
    const all = await this.apiList();
    return all
      .filter((n) => n.id.startsWith(MEM) && (n.data.created_at as number) > timestamp)
      .sort((a, b) => (a.data.created_at as number) - (b.data.created_at as number))
      .map((n) => this.nodeToEntryNoEmbedding(n.data, n.id.slice(MEM.length)));
  }

  async getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>> {
    await this.ensureInitialized();
    const all = await this.apiList();
    return all
      .filter((n) => n.id.startsWith(MEM))
      .map((n) => ({ id: n.id.slice(MEM.length), created_at: n.data.created_at as number }));
  }

  async getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    if (ids.length === 0) return [];
    await this.ensureInitialized();
    const results: Array<Omit<MemoryEntry, "embedding">> = [];
    for (const id of ids) {
      const data = await this.apiGet(MEM + id);
      if (data) results.push(this.nodeToEntryNoEmbedding(data, id));
    }
    return results;
  }

  async storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean> {
    await this.ensureInitialized();

    const existing = await this.apiGet(MEM + entry.id);
    if (existing) {
      // Update via CRDT put — merge semantics apply
      await this.apiPut(MEM + entry.id, {
        ...(existing as Record<string, unknown>),
        content: entry.content,
        created_at: entry.created_at,
        source: entry.source ?? "",
        tags: entry.tags ?? [],
        category: entry.category ?? "other",
      });
      return true;
    }

    // Duplicate content check
    const all = await this.apiList();
    const dup = all.find(
      (n) => n.id.startsWith(MEM) && n.data.content === entry.content,
    );
    if (dup) return false;

    await this.apiPut(MEM + entry.id, {
      id: entry.id,
      content: entry.content,
      created_at: entry.created_at,
      source: entry.source ?? "",
      tags: entry.tags ?? [],
      category: entry.category ?? "other",
    });
    return true;
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.ensureInitialized();
    const existing = await this.apiGet(MEM + id);
    if (!existing) return;
    await this.apiPut(MEM + id, { ...(existing as Record<string, unknown>), vector: embedding });
  }

  async getLastSyncTime(peerId: string): Promise<number> {
    await this.ensureInitialized();
    const data = await this.apiGet(SYNC + peerId);
    return (data?.last_sync_at as number) ?? 0;
  }

  async setLastSyncTime(peerId: string, timestamp: number): Promise<void> {
    await this.ensureInitialized();
    await this.apiPut(SYNC + peerId, { last_sync_at: timestamp });
  }

  async generateDailySummary(date: string): Promise<DailySummary> {
    await this.ensureInitialized();

    const dateObj = new Date(date + "T00:00:00.000Z");
    const startOfDay = dateObj.getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    const all = await this.apiList();
    const memories = all
      .filter(
        (n) =>
          n.id.startsWith(MEM) &&
          (n.data.category as string) !== "daily-summary" &&
          (n.data.created_at as number) >= startOfDay &&
          (n.data.created_at as number) < endOfDay,
      )
      .sort((a, b) => (a.data.created_at as number) - (b.data.created_at as number))
      .map((n) => ({
        id: n.id.slice(MEM.length),
        content: n.data.content as string,
        created_at: n.data.created_at as number,
        category: (n.data.category as string) ?? "other",
        tags: (n.data.tags as string[]) ?? [],
      }));

    const categorizedMemories = new Map<string, Array<{ content: string; created_at: number }>>();
    const categoryCounts: Record<string, number> = {};

    for (const mem of memories) {
      if (!categorizedMemories.has(mem.category)) {
        categorizedMemories.set(mem.category, []);
      }
      categorizedMemories.get(mem.category)!.push({ content: mem.content, created_at: mem.created_at });
      categoryCounts[mem.category] = (categoryCounts[mem.category] || 0) + 1;
    }

    const sections: string[] = [];
    sections.push(`# Daily Summary - ${date}`, "", `**Total Memories**: ${memories.length}`, "");

    const categoryOrder = [
      "decision", "project", "work-in-progress", "architecture-decision",
      "error-fix", "code-pattern", "preference", "explicit", "entity", "conversation", "other",
    ];
    const sortedCategories = Array.from(categorizedMemories.keys()).sort((a, b) => {
      const ia = categoryOrder.indexOf(a), ib = categoryOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    for (const category of sortedCategories) {
      const items = categorizedMemories.get(category)!;
      const title = category.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      sections.push(`## ${title} (${items.length})`, "");
      for (const item of items) {
        const time = new Date(item.created_at).toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", hour12: false,
        });
        sections.push(`- **${time}**: ${item.content}`);
      }
      sections.push("");
    }

    const summaryMarkdown = sections.join("\n");
    const now = Date.now();

    // Use a stable composite key so CRDT upsert handles dedup automatically
    // (a second PUT for the same date just merges/overwrites via vector clock)
    const summaryId = `daily-summary:${date}`;
    await this.apiPut(MEM + summaryId, {
      id: summaryId,
      content: summaryMarkdown,
      created_at: now,
      source: "daily-summary",
      tags: [`daily-summary:${date}`],
      category: "daily-summary",
    });

    return { date, summary: summaryMarkdown, memoryCount: memories.length, categories: categoryCounts, created_at: now };
  }

  async getDailySummaries(days: number): Promise<DailySummary[]> {
    await this.ensureInitialized();
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = await this.apiList();

    return all
      .filter(
        (n) =>
          n.id.startsWith(MEM) &&
          (n.data.category as string) === "daily-summary" &&
          (n.data.created_at as number) >= startTime,
      )
      .sort((a, b) => (b.data.created_at as number) - (a.data.created_at as number))
      .map((n) => {
        const tags = (n.data.tags as string[]) ?? [];
        const dateTag = tags.find((t) => t.startsWith("daily-summary:"));
        const date = dateTag ? dateTag.substring("daily-summary:".length) : "unknown";
        const content = n.data.content as string;

        const categories: Record<string, number> = {};
        let totalCount = 0;
        for (const match of content.matchAll(/^## (.+?) \((\d+)\)$/gm)) {
          const categoryName = match[1].toLowerCase().replace(/\s+/g, "-");
          const count = parseInt(match[2], 10);
          categories[categoryName] = count;
          totalCount += count;
        }

        return {
          date,
          summary: content,
          memoryCount: totalCount,
          categories,
          created_at: n.data.created_at as number,
        };
      });
  }

  async isOpen(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.apiBaseUrl) return false;
    return this.isServerHealthy();
  }

  /**
   * Set the importance score for a memory to boost or reduce its recall weight.
   * Values > 1.0 boost the memory; values < 1.0 reduce it.
   */
  async setImportanceScore(id: string, score: number): Promise<void> {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error("importance_score must be a finite non-negative number between 0 and 100");
    }
    await this.ensureInitialized();
    const existing = await this.apiGet(MEM + id);
    if (!existing) return;
    await this.apiPut(MEM + id, { ...(existing as Record<string, unknown>), importance_score: score });
  }

  /**
   * Returns the byte-equivalent length of the first stored embedding,
   * using Float64Array semantics (8 bytes/value) for compatibility with
   * the self-test dimension-check in index.ts.
   */
  async getEmbeddingByteLength(): Promise<number | null> {
    await this.ensureInitialized();
    const all = await this.apiList();
    for (const n of all) {
      if (!n.id.startsWith(MEM)) continue;
      const vec = toNumberArray(n.data.vector);
      if (vec.length > 0) return vec.length * 8;
    }
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /** Convert a MemoryEntry to a plain object suitable for CRDT node storage. */
  private entryToNode(entry: MemoryEntry): Record<string, unknown> {
    return {
      id: entry.id,
      content: entry.content,
      // Store embedding as `vector` so PluresDB's GunDB indexes it automatically
      vector: entry.embedding,
      created_at: entry.created_at,
      source: entry.source ?? "",
      tags: entry.tags ?? [],
      category: entry.category ?? "other",
      priority: entry.priority ?? "normal",
      importance_score: entry.importance_score ?? 1.0,
      conversation_tag_ids: entry.conversation_tag_ids ?? [],
      ...(entry.last_accessed_at !== undefined ? { last_accessed_at: entry.last_accessed_at } : {}),
      ...(entry.merge_count !== undefined ? { merge_count: entry.merge_count } : {}),
    };
  }

  /** Reconstruct a MemoryEntry from CRDT node data. */
  private nodeToEntry(data: Record<string, unknown>, id: string): MemoryEntry {
    return {
      id,
      content: (data.content as string) ?? "",
      embedding: toNumberArray(data.vector),
      created_at: (data.created_at as number) ?? 0,
      source: (data.source as string) ?? "",
      tags: (data.tags as string[]) ?? [],
      category: (data.category as string) ?? "other",
      priority: (data.priority as MemoryPriority) ?? "normal",
      importance_score: typeof data.importance_score === "number" ? data.importance_score : 1.0,
      conversation_tag_ids: Array.isArray(data.conversation_tag_ids) ? (data.conversation_tag_ids as string[]) : [],
      ...(data.last_accessed_at !== undefined ? { last_accessed_at: data.last_accessed_at as number } : {}),
      ...(data.merge_count !== undefined ? { merge_count: data.merge_count as number } : {}),
    };
  }

  /** Reconstruct a MemoryEntry without its embedding vector (for sync methods). */
  private nodeToEntryNoEmbedding(data: Record<string, unknown>, id: string): Omit<MemoryEntry, "embedding"> {
    return {
      id,
      content: (data.content as string) ?? "",
      created_at: (data.created_at as number) ?? 0,
      source: (data.source as string) ?? "",
      tags: (data.tags as string[]) ?? [],
      category: (data.category as string) ?? "other",
      priority: (data.priority as MemoryPriority) ?? "normal",
      importance_score: typeof data.importance_score === "number" ? data.importance_score : 1.0,
    };
  }

  // ── Conversation Tagging ────────────────────────────────────────────────────

  private generateTagLabel(content: string): string {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4);
    return words.length > 0 ? words.join(" ") : content.slice(0, 40).trim();
  }

  /** Fetch a conversation tag node by ID, or null if not found. */
  private async getTagNode(tagId: string): Promise<(ConversationTag & { _node: Record<string, unknown> }) | null> {
    const data = await this.apiGet(CONV_TAG + tagId);
    if (!data) return null;
    return {
      id: tagId,
      label: (data.label as string) ?? "",
      embedding: toNumberArray(data.embedding),
      parent_tag_id: (data.parent_tag_id as string | undefined) ?? undefined,
      message_ids: Array.isArray(data.message_ids) ? (data.message_ids as string[]) : [],
      created_at: (data.created_at as number) ?? 0,
      updated_at: (data.updated_at as number) ?? 0,
      similarity_threshold: typeof data.similarity_threshold === "number" ? data.similarity_threshold : 0.85,
      _node: data,
    };
  }

  /** Persist a conversation tag as a CRDT node. */
  private async putTagNode(tag: ConversationTag): Promise<void> {
    await this.apiPut(CONV_TAG + tag.id, {
      id: tag.id,
      label: tag.label,
      embedding: tag.embedding,
      parent_tag_id: tag.parent_tag_id ?? null,
      message_ids: tag.message_ids,
      created_at: tag.created_at,
      updated_at: tag.updated_at,
      similarity_threshold: tag.similarity_threshold,
    });
  }

  private async addMemoryToTag(tagId: string, memoryId: string, newEmbedding: number[]): Promise<void> {
    const tag = await this.getTagNode(tagId);
    if (!tag) return;

    if (tag.message_ids.includes(memoryId)) return;

    const messageIds = [...tag.message_ids, memoryId];
    const count = messageIds.length;
    const updatedEmbedding = tag.embedding.map(
      (v, i) => (v * (count - 1) + newEmbedding[i]) / count
    );

    await this.putTagNode({
      ...tag,
      embedding: updatedEmbedding,
      message_ids: messageIds,
      updated_at: Date.now(),
    });
  }

  private async assignConversationTag(
    memoryId: string,
    embedding: number[],
    content: string,
    similarityThreshold: number = 0.85,
    parentThreshold: number = 0.7,
  ): Promise<string[]> {
    const all = await this.apiList();
    const tagNodes = all.filter((n) => n.id.startsWith(CONV_TAG));

    let bestMatchId: string | null = null;
    let bestMatchSim = -1;
    let potentialParentId: string | null = null;
    let potentialParentSim = -1;

    for (const node of tagNodes) {
      const tagId = node.id.slice(CONV_TAG.length);
      const tagEmbedding = toNumberArray(node.data.embedding);
      if (tagEmbedding.length === 0) continue;
      const sim = cosineSimilarity(embedding, tagEmbedding);
      const threshold = typeof node.data.similarity_threshold === "number"
        ? node.data.similarity_threshold
        : similarityThreshold;

      if (sim >= threshold && sim > bestMatchSim) {
        bestMatchSim = sim;
        bestMatchId = tagId;
      } else if (sim >= parentThreshold && sim > potentialParentSim) {
        potentialParentSim = sim;
        potentialParentId = tagId;
      }
    }

    if (bestMatchId) {
      await this.addMemoryToTag(bestMatchId, memoryId, embedding);
      return [bestMatchId];
    }

    const newTagId = randomUUID();
    const now = Date.now();
    await this.putTagNode({
      id: newTagId,
      label: this.generateTagLabel(content),
      embedding,
      parent_tag_id: potentialParentId ?? undefined,
      message_ids: [memoryId],
      created_at: now,
      updated_at: now,
      similarity_threshold: similarityThreshold,
    });

    return [newTagId];
  }

  async getConversationTags(): Promise<ConversationTag[]> {
    await this.ensureInitialized();
    const all = await this.apiList();
    const tags: ConversationTag[] = [];

    for (const node of all) {
      if (!node.id.startsWith(CONV_TAG)) continue;
      const tagId = node.id.slice(CONV_TAG.length);
      const d = node.data;
      tags.push({
        id: tagId,
        label: (d.label as string) ?? "",
        embedding: toNumberArray(d.embedding),
        parent_tag_id: (d.parent_tag_id as string | undefined) ?? undefined,
        message_ids: Array.isArray(d.message_ids) ? (d.message_ids as string[]) : [],
        created_at: (d.created_at as number) ?? 0,
        updated_at: (d.updated_at as number) ?? 0,
        similarity_threshold: typeof d.similarity_threshold === "number" ? d.similarity_threshold : 0.85,
      });
    }

    return tags.sort((a, b) => b.updated_at - a.updated_at);
  }

  async getMessagesForTag(tagId: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const tag = await this.getTagNode(tagId);
    if (!tag || tag.message_ids.length === 0) return [];

    const entries: MemoryEntry[] = [];
    for (const memId of tag.message_ids) {
      const data = await this.apiGet(MEM + memId);
      if (data) entries.push(this.nodeToEntry(data, memId));
    }

    return entries.sort((a, b) => a.created_at - b.created_at);
  }

  async getRelatedTags(tagId: string): Promise<ConversationTag[]> {
    await this.ensureInitialized();
    const tag = await this.getTagNode(tagId);
    if (!tag) return [];

    const all = await this.apiList();
    const related = new Map<string, ConversationTag>();

    const addNode = (node: ApiNode) => {
      const id = node.id.slice(CONV_TAG.length);
      if (id === tagId) return;
      const d = node.data;
      related.set(id, {
        id,
        label: (d.label as string) ?? "",
        embedding: toNumberArray(d.embedding),
        parent_tag_id: (d.parent_tag_id as string | undefined) ?? undefined,
        message_ids: Array.isArray(d.message_ids) ? (d.message_ids as string[]) : [],
        created_at: (d.created_at as number) ?? 0,
        updated_at: (d.updated_at as number) ?? 0,
        similarity_threshold: typeof d.similarity_threshold === "number" ? d.similarity_threshold : 0.85,
      });
    };

    for (const node of all) {
      if (!node.id.startsWith(CONV_TAG)) continue;
      const d = node.data;
      const id = node.id.slice(CONV_TAG.length);

      // Children of this tag
      if (d.parent_tag_id === tagId) {
        addNode(node);
        continue;
      }

      if (tag.parent_tag_id) {
        // Parent tag
        if (id === tag.parent_tag_id) {
          addNode(node);
          continue;
        }
        // Siblings (same parent)
        if (d.parent_tag_id === tag.parent_tag_id) {
          addNode(node);
        }
      }
    }

    return Array.from(related.values());
  }
}
