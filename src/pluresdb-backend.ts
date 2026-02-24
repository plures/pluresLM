/**
 * PluresDB native NAPI storage backend
 *
 * Direct bindings to the PluresDB Rust engine via N-API. No Deno subprocess,
 * no HTTP shim, no legacy GunDB — just native CRDT store with HNSW vector
 * search and optional fastembed auto-embedding.
 *
 * Requires:
 *   - @plures/pluresdb with native binary built (crates/pluresdb-node)
 *   - For auto-embedding: binary compiled with --features embeddings
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { MemoryEntry, MemorySearchResult, ProfileData, DailySummary, MemoryPriority, ConversationTag, StoreContentOpts } from "./types.js";
import { determinePriority } from "./types.js";

// Key prefixes used to namespace node types in the CRDT store
const MEM = "memory:";
const EDGE = "edge:";
const PROFILE_KEY = "profile:user_profile";
const SYNC = "sync:";
const CONV_TAG = "conv_tag:";
const META = "meta:";

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

function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x): x is number => typeof x === "number");
}

/** PluresDB NAPI database handle type (from @plures/pluresdb/embedded) */
interface PluresDatabaseNAPI {
  put(id: string, data: Record<string, unknown>): string;
  putWithEmbedding(id: string, data: Record<string, unknown>, embedding: number[]): string;
  get(id: string): Record<string, unknown> | null;
  getWithMetadata(id: string): Record<string, unknown> | null;
  delete(id: string): void;
  list(): Array<{ id: string; data: Record<string, unknown> }>;
  listByType(nodeType: string): Array<{ id: string; data: Record<string, unknown> }>;
  vectorSearch(embedding: number[], limit?: number, threshold?: number): Array<{ id: string; data: Record<string, unknown>; score: number; timestamp?: string }>;
  search(query: string, limit?: number): Array<{ id: string; data: Record<string, unknown>; score: number }>;
  stats(): Record<string, unknown>;
  getActorId(): string;
  buildVectorIndex?(): number;
  // New procedures API
  execDsl(query: string): { nodes?: Array<{ id: string; data: Record<string, unknown> }>; aggregate?: unknown; mutated?: number };
  execIr(steps: Array<Record<string, unknown>>): { nodes?: Array<{ id: string; data: Record<string, unknown> }>; aggregate?: unknown; mutated?: number };
}

/** Insight data about memory relationships and clusters */
export interface InsightData {
  totalMemories: number;
  totalEdges: number;
  isolatedMemories: number;
  connectedMemories: number;
  clusters: Array<{ rootId: string; size: number; categories: string[] }>;
  topCategories: Array<{ category: string; count: number }>;
  timespan?: string;
}

interface PluresDatabaseConstructor {
  new (actorId?: string, dbPath?: string): PluresDatabaseNAPI;
  newWithEmbeddings(model: string, actorId?: string, dbPath?: string): PluresDatabaseNAPI;
}

function loadNativeModule(): PluresDatabaseConstructor {
  console.log(`[PluresDBBackend] Attempting to load native module...`);
  const require = createRequire(import.meta.url);
  // Try multiple resolution paths:
  // 1. @plures/pluresdb/embedded (npm package - production)
  // 2. Direct path to workspace build (development)
  const candidates = [
    () => {
      console.log(`[PluresDBBackend] Trying @plures/pluresdb/embedded (npm package)...`);
      return require("@plures/pluresdb/embedded");
    },
    () => {
      // Workspace path — look for the built .node file (development)
      const workspacePluresDB = path.resolve(
        import.meta.url.replace("file://", ""),
        "..", "..", "..", "..", "pluresdb",
      );
      console.log(`[PluresDBBackend] Trying workspace path: ${workspacePluresDB}`);
      const modulePath = path.join(workspacePluresDB, "embedded.js");
      console.log(`[PluresDBBackend] Loading from: ${modulePath}`);
      return require(modulePath);
    },
  ];

  let lastError: Error | null = null;
  for (const tryLoad of candidates) {
    try {
      console.log(`[PluresDBBackend] Executing load attempt...`);
      const mod = tryLoad();
      console.log(`[PluresDBBackend] Module loaded, exports:`, Object.keys(mod));
      if (mod.PluresDatabase) return mod.PluresDatabase;
      if (mod.default?.PluresDatabase) return mod.default.PluresDatabase;
      return mod;
    } catch (e) {
      lastError = e as Error;
      console.log(`[PluresDBBackend] Load attempt failed:`, e);
    }
  }

  throw new Error(
    `Failed to load PluresDB native bindings. This usually means the native binary needs to be built.\n\n` +
    `For customers: This should auto-install. If you're seeing this error, please report it.\n` +
    `For developers: Build with: cd pluresdb/crates/pluresdb-node && npm run build\n\n` +
    `Last error: ${lastError?.message}\n` +
    `Platform: ${process.platform}-${process.arch}`
  );
}

export class PluresDBBackend {
  private readonly dbPath: string;
  private readonly vectorDimension: number;
  private db: PluresDatabaseNAPI | null = null;
  private closed = false;
  private initPromise: Promise<void> | null = null;
  private embeddingModel: string;
  private actorId: string;

  constructor(dbPath: string, vectorDimension: number, opts?: { embeddingModel?: string; actorId?: string; dbBaseDir?: string }) {
    // Process-specific isolation: {dbBaseDir}/{processName}/
    this.dbPath = this.resolveProcessSpecificPath(dbPath, opts?.dbBaseDir);
    this.vectorDimension = vectorDimension;
    this.embeddingModel = opts?.embeddingModel ?? "BAAI/bge-small-en-v1.5";
    this.actorId = opts?.actorId ?? "pluresLM";
  }

  /**
   * Resolve database path with intelligent process handling.
   * 
   * Strategy:
   * - Gateway: Owns the main database (full read/write)
   * - CLI: Shares gateway database (read-mostly, careful writes)  
   * - Dashboard: Shares gateway database (read-mostly)
   * - Dev: Separate isolated database for safety
   */
  private resolveProcessSpecificPath(originalPath: string, customBaseDir?: string): string {
    const homeDir = process.env.OPENCLAW_HOME || process.env.HOME || process.env.USERPROFILE || "/tmp";
    
    // Analyze current process type and access pattern
    const processInfo = this.analyzeProcess();
    
    // Use custom base directory or smart default
    let baseDir: string;
    if (customBaseDir) {
      // Support tilde expansion in custom base dir
      baseDir = customBaseDir.startsWith("~/") 
        ? path.join(homeDir, customBaseDir.slice(2))
        : customBaseDir;
    } else {
      baseDir = path.join(homeDir, ".pluresLM");
    }
    
    // Determine database path strategy
    let processDir: string;
    
    if (processInfo.isGateway) {
      // Gateway owns the main database
      processDir = path.join(baseDir, "openclaw-gateway");
    } else if (processInfo.isCLI || processInfo.isDashboard) {
      // CLI and Dashboard share gateway database for data consistency
      processDir = path.join(baseDir, "openclaw-gateway");
    } else {
      // Development/testing gets isolated database for safety
      processDir = path.join(baseDir, processInfo.name);
    }
    
    // Ensure directory exists
    try {
      require("fs").mkdirSync(processDir, { recursive: true });
    } catch (err) {
      console.warn(`[PluresDBBackend] Failed to create process directory ${processDir}:`, err);
    }
    
    const resolvedPath = path.join(processDir, "db");
    
    console.log(`[PluresDBBackend] Process: ${processInfo.name} (${processInfo.type})`);
    console.log(`[PluresDBBackend] Database: ${originalPath} → ${resolvedPath}`);
    if (processInfo.isCLI || processInfo.isDashboard) {
      console.log(`[PluresDBBackend] Mode: Shared access to gateway database`);
    }
    if (customBaseDir) {
      console.log(`[PluresDBBackend] Using custom dbBaseDir: ${customBaseDir}`);
    }
    
    return resolvedPath;
  }

  private analyzeProcess(): { name: string; type: string; isGateway: boolean; isCLI: boolean; isDashboard: boolean } {
    const serviceKind = process.env.OPENCLAW_SERVICE_KIND;
    const processType = process.env.OPENCLAW_PROCESS_TYPE;
    const argv = process.argv.join(' ');
    const title = process.title || "";
    const cwd = process.cwd();
    
    // Development/testing (isolated for safety)
    if (cwd.includes("pluresLM") && !serviceKind) {
      return { name: "pluresLM-dev", type: "development", isGateway: false, isCLI: false, isDashboard: false };
    }
    
    // CLI commands (shared access to gateway data)  
    if (argv.includes('pluresLM') || argv.includes('query') || argv.includes('stats')) {
      return { name: "openclaw-cli", type: "cli", isGateway: false, isCLI: true, isDashboard: false };
    }
    
    // Dashboard (shared access to gateway data)
    if (title.includes("node") && (cwd.includes("dashboard") || argv.includes("dashboard"))) {
      return { name: "openclaw-dashboard", type: "dashboard", isGateway: false, isCLI: false, isDashboard: true };
    }
    
    // Gateway (owns the database)
    return { name: "openclaw-gateway", type: "gateway", isGateway: true, isCLI: false, isDashboard: false };
  }

  /**
   * Detect current process name for database isolation
   */
  /**
   * Detect current process name for database isolation (DEPRECATED - use analyzeProcess)
   */
  private detectProcessName(): string {
    return this.analyzeProcess().name;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    console.log(`[PluresDBBackend] Starting initialization...`);
    console.log(`[PluresDBBackend] dbPath: ${this.dbPath}`);
    console.log(`[PluresDBBackend] vectorDimension: ${this.vectorDimension}`);
    console.log(`[PluresDBBackend] embeddingModel: ${this.embeddingModel}`);
    console.log(`[PluresDBBackend] actorId: ${this.actorId}`);

    try {
      console.log(`[PluresDBBackend] Loading native module...`);
      const PluresDatabase = loadNativeModule();
      console.log(`[PluresDBBackend] Native module loaded successfully`);

      // Try with embeddings first, fall back to plain DB
      // Analyze process type for lock handling strategy
      const processInfo = this.analyzeProcess();
      const isSharedAccess = processInfo.isCLI || processInfo.isDashboard;

      try {
        console.log(`[PluresDBBackend] Attempting to create database with embeddings...`);
        this.db = PluresDatabase.newWithEmbeddings(this.embeddingModel, this.actorId, this.dbPath);
        console.log(`[PluresDBBackend] initialized with native embeddings (${this.embeddingModel})`);
      } catch (embedErr) {
        if (isSharedAccess && (embedErr as Error).message?.includes("could not acquire lock")) {
          console.log("[PluresDBBackend] Database locked by gateway - implementing fallback for CLI access");
          await this.handleSharedAccessFailure(processInfo, embedErr);
          return; // Exit early - fallback is active
        }
        
        console.warn(
          `[PluresDBBackend] native embeddings unavailable (${(embedErr as Error).message}), using plain store`,
        );
        
        try {
          console.log(`[PluresDBBackend] Attempting to create plain database...`);
          this.db = new PluresDatabase(this.actorId, this.dbPath);
          console.log(`[PluresDBBackend] Plain database created successfully`);
        } catch (plainErr) {
          if (isSharedAccess && (plainErr as Error).message?.includes("could not acquire lock")) {
            console.log("[PluresDBBackend] Plain database also locked - implementing fallback");
            await this.handleSharedAccessFailure(processInfo, plainErr);
            return; // Exit early - fallback is active
          }
          throw plainErr; // Re-throw if not a lock issue
        }
      }

      console.log(`[PluresDBBackend] Testing basic database operations...`);
      // Test basic operation
      const testId = "test:" + Date.now();
      this.db.put(testId, { test: true });
      const retrieved = this.db.get(testId);
      console.log(`[PluresDBBackend] Test operation successful, retrieved:`, retrieved);
      this.db.delete(testId);
      console.log(`[PluresDBBackend] Test cleanup complete`);

      this.closed = false;
      console.log(`[PluresDBBackend] Initialization complete!`);

      // Build vector index in background — don't block gateway startup
      const db = this.db;
      if (db && typeof (db as any).buildVectorIndex === "function") {
        setImmediate(() => {
          try {
            const indexed = (db as any).buildVectorIndex() as number;
            console.log(`[PluresDBBackend] Background vector index built: ${indexed} entries`);
          } catch (err) {
            console.warn(`[PluresDBBackend] Background vector index failed: ${(err as Error).message}`);
          }
        });
      }
    } catch (error) {
      console.error(`[PluresDBBackend] Initialization failed:`, error);
      throw new Error(
        `Failed to initialize PluresDB native backend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  private getDB(): PluresDatabaseNAPI {
    if (!this.db) throw new Error("PluresDB not initialized");
    return this.db;
  }

  async reopen(): Promise<void> {
    await this.close();
    this.initPromise = null;
    await this.ensureInitialized();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db = null;
    this.initPromise = null;
  }

  async isOpen(): Promise<boolean> {
    return !this.closed && this.db !== null;
  }

  // ── Core operations ──────────────────────────────────────────────────────────

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
      originator_id?: string;
      originator_name?: string;
      destination?: string;
      status?: string;
      assigned_to?: string;
      due_at?: number;
      last_checkin?: number;
    },
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
    await this.ensureInitialized();

    const tags = opts.tags ?? [];
    const category = opts.category ?? "other";
    const priority = opts.priority ?? determinePriority(category, tags);
    const importanceScore = opts.importanceScore ?? 1.0;
    const threshold = opts.dedupeThreshold ?? 0.95;

    // Deduplication via native vector search
    const dupeResults = await this.vectorSearch(embedding, 1, threshold);
    if (dupeResults.length > 0) {
      const ex = dupeResults[0].entry;
      const now = Date.now();

      const mergedTags = [...new Set([...(ex.tags ?? []), ...(opts.tags ?? [])])];
      const mergedCategory = opts.category ?? ex.category ?? "other";
      const mergedImportanceScore = Math.max(opts.importanceScore ?? 1.0, ex.importance_score ?? 1.0);
      const mergedSource = opts.source ?? ex.source ?? "";
      const mergedPriority = opts.priority ?? determinePriority(mergedCategory, mergedTags);

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
      const db = this.getDB();
      if (embedding.length > 0) {
        db.putWithEmbedding(MEM + ex.id, this.entryToNode(updated), embedding);
      } else {
        db.put(MEM + ex.id, this.entryToNode(updated));
      }
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
      originator_id: opts.originator_id || undefined,
      originator_name: opts.originator_name || undefined,
      destination: opts.destination || undefined,
      status: opts.status || undefined,
      assigned_to: opts.assigned_to || undefined,
      due_at: opts.due_at,
      last_checkin: opts.last_checkin,
    };

    const db = this.getDB();
    if (embedding.length > 0) {
      db.putWithEmbedding(MEM + id, this.entryToNode(entry), embedding);
    } else {
      db.put(MEM + id, this.entryToNode(entry));
    }
    return { entry, isDuplicate: false };
  }

  async storeContent(
    content: string,
    opts: StoreContentOpts,
  ): Promise<{ entry: MemoryEntry; isDuplicate: boolean; updatedId?: string }> {
    await this.ensureInitialized();

    const tags = opts.tags ?? [];
    const category = opts.category ?? "other";
    const priority = opts.priority ?? determinePriority(category, tags);
    const db = this.getDB();

    // Exact content dedup via text search
    const existing = db.search(content, 1);
    if (existing.length > 0 && existing[0].data?.content === content) {
      const match = existing[0];
      const memId = match.id.startsWith(MEM) ? match.id.slice(MEM.length) : match.id;
      const entry = this.nodeToEntry(match.data, memId);
      return { entry, isDuplicate: true, updatedId: entry.id };
    }

    const id = randomUUID();
    const now = Date.now();

    const entry: MemoryEntry = {
      id, content, embedding: [], created_at: now,
      source: opts.source ?? "", tags, category, priority,
      importance_score: 1.0,
      originator_id: opts.originator_id || undefined,
      originator_name: opts.originator_name || undefined,
      destination: opts.destination || undefined,
      status: opts.status || undefined,
      assigned_to: opts.assigned_to || undefined,
      due_at: opts.due_at,
      last_checkin: opts.last_checkin,
    };

    // PluresDB with auto-embedding will embed the text content on put()
    db.put(MEM + id, this.entryToNode(entry));
    return { entry, isDuplicate: false };
  }

  async vectorSearch(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.3,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();
    const db = this.getDB();

    // Native HNSW vector search
    const candidates = db.vectorSearch(queryEmbedding, limit * 3 + 10, minScore);

    const results: MemorySearchResult[] = [];
    for (const node of candidates) {
      const nodeId = node.id;
      if (!nodeId.startsWith(MEM)) continue;

      const d = node.data;
      const importanceScore = typeof d.importance_score === "number" ? d.importance_score : 1.0;
      const finalScore = (node.score ?? 0) * importanceScore;
      if (finalScore < minScore) continue;

      results.push({
        entry: this.nodeToEntry(d, nodeId.slice(MEM.length)),
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
    this.getDB().put(EDGE + id, { id, from_id: fromId, to_id: toId, relation, created_at: Date.now() });
  }

  async getRelated(memoryId: string, relation?: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const db = this.getDB();
    const all = db.list();

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
      const data = db.get(MEM + rid);
      if (data) entries.push(this.nodeToEntry(data, rid));
    }
    return entries;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!id || /[\/\\<>|&;`"']/.test(id)) {
      throw new Error(`Invalid memory ID: ${id}`);
    }

    const db = this.getDB();
    const all = db.list();

    // Remove edges referencing this memory
    for (const node of all) {
      if (node.id.startsWith(EDGE) && (node.data.from_id === id || node.data.to_id === id)) {
        db.delete(node.id);
      }
    }

    db.delete(MEM + id);
    return true;
  }

  async deleteBySource(source: string): Promise<number> {
    await this.ensureInitialized();
    const db = this.getDB();
    const all = db.list();
    const toDelete = all.filter((n) => n.id.startsWith(MEM) && n.data.source === source);
    if (toDelete.length === 0) return 0;

    const memIds = new Set(toDelete.map((n) => n.id.slice(MEM.length)));
    for (const node of all) {
      if (node.id.startsWith(EDGE) && (memIds.has(node.data.from_id as string) || memIds.has(node.data.to_id as string))) {
        db.delete(node.id);
      }
    }
    for (const n of toDelete) db.delete(n.id);
    return toDelete.length;
  }

  async deleteByQuery(embedding: number[], threshold: number = 0.8): Promise<number> {
    const matches = await this.vectorSearch(embedding, 10, threshold);
    for (const match of matches) await this.delete(match.entry.id);
    return matches.length;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.getDB().list().filter((n) => n.id.startsWith(MEM)).length;
  }

  async getAllContent(limit: number = 100): Promise<string[]> {
    await this.ensureInitialized();
    return this.getDB().list()
      .filter((n) => n.id.startsWith(MEM))
      .sort((a, b) => (b.data.created_at as number) - (a.data.created_at as number))
      .slice(0, limit)
      .map((n) => n.data.content as string);
  }

  async getLastCaptureTime(): Promise<number | null> {
    await this.ensureInitialized();
    let max: number | null = null;
    for (const n of this.getDB().list()) {
      if (!n.id.startsWith(MEM)) continue;
      const t = n.data.created_at as number;
      if (max === null || t > max) max = t;
    }
    return max;
  }

  async getProfile(): Promise<ProfileData | null> {
    await this.ensureInitialized();
    const data = this.getDB().get(PROFILE_KEY);
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
    this.getDB().put(PROFILE_KEY, {
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
    this.getDB().put(PROFILE_KEY, {
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
    const all = this.getDB().list();

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
    const all = this.getDB().list();
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

  async listMemories(): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    return this.getDB().list()
      .filter((n) => n.id.startsWith(MEM))
      .map((n) => this.nodeToEntry(n.data, n.id.slice(MEM.length)));
  }

  // ── Memory Analysis & Context Management ─────────────────────────────────────

  async getMemoriesSince(timestamp: number): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    await this.ensureInitialized();
    return this.getDB().list()
      .filter((n) => n.id.startsWith(MEM) && (n.data.created_at as number) > timestamp)
      .sort((a, b) => (a.data.created_at as number) - (b.data.created_at as number))
      .map((n) => this.nodeToEntryNoEmbedding(n.data, n.id.slice(MEM.length)));
  }

  async getAllMemoryIds(): Promise<Array<{ id: string; created_at: number }>> {
    await this.ensureInitialized();
    return this.getDB().list()
      .filter((n) => n.id.startsWith(MEM))
      .map((n) => ({ id: n.id.slice(MEM.length), created_at: n.data.created_at as number }));
  }

  async getMemoriesByIds(ids: string[]): Promise<Array<Omit<MemoryEntry, "embedding">>> {
    if (ids.length === 0) return [];
    await this.ensureInitialized();
    const db = this.getDB();
    const results: Array<Omit<MemoryEntry, "embedding">> = [];
    for (const id of ids) {
      const data = db.get(MEM + id);
      if (data) results.push(this.nodeToEntryNoEmbedding(data, id));
    }
    return results;
  }

  async storeRaw(entry: Omit<MemoryEntry, "embedding">): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.getDB();

    const existing = db.get(MEM + entry.id);
    if (existing) {
      db.put(MEM + entry.id, {
        ...(existing as Record<string, unknown>),
        content: entry.content,
        created_at: entry.created_at,
        source: entry.source ?? "",
        tags: entry.tags ?? [],
        category: entry.category ?? "other",
        originator_id: entry.originator_id ?? "",
        originator_name: entry.originator_name ?? "",
        destination: entry.destination ?? "",
        status: entry.status ?? "",
        assigned_to: entry.assigned_to ?? "",
        ...(entry.due_at !== undefined ? { due_at: entry.due_at } : {}),
        ...(entry.last_checkin !== undefined ? { last_checkin: entry.last_checkin } : {}),
      });
      return true;
    }

    // Duplicate content check
    const searchResults = db.search(entry.content, 1);
    if (searchResults.length > 0 && searchResults[0].data?.content === entry.content) {
      return false;
    }

    db.put(MEM + entry.id, {
      id: entry.id,
      content: entry.content,
      created_at: entry.created_at,
      source: entry.source ?? "",
      tags: entry.tags ?? [],
      category: entry.category ?? "other",
      originator_id: entry.originator_id ?? "",
      originator_name: entry.originator_name ?? "",
      destination: entry.destination ?? "",
      status: entry.status ?? "",
      assigned_to: entry.assigned_to ?? "",
      ...(entry.due_at !== undefined ? { due_at: entry.due_at } : {}),
      ...(entry.last_checkin !== undefined ? { last_checkin: entry.last_checkin } : {}),
    });
    return true;
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.ensureInitialized();
    const db = this.getDB();
    const existing = db.get(MEM + id);
    if (!existing) return;
    db.putWithEmbedding(MEM + id, { ...(existing as Record<string, unknown>), vector: embedding }, embedding);
  }

  async getLastSyncTime(peerId: string): Promise<number> {
    await this.ensureInitialized();
    const data = this.getDB().get(SYNC + peerId);
    return (data?.last_sync_at as number) ?? 0;
  }

  async setLastSyncTime(peerId: string, timestamp: number): Promise<void> {
    await this.ensureInitialized();
    this.getDB().put(SYNC + peerId, { last_sync_at: timestamp });
  }

  async updateAttribution(id: string, opts: { status?: string; assigned_to?: string; due_at?: number | null; last_checkin?: number | null; destination?: string }): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.getDB();
    const existing = db.get(MEM + id);
    if (!existing) return false;

    const patch: Record<string, unknown> = {};
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.assigned_to !== undefined) patch.assigned_to = opts.assigned_to;
    if ("due_at" in opts) patch.due_at = opts.due_at ?? null;
    if ("last_checkin" in opts) patch.last_checkin = opts.last_checkin ?? null;
    if (opts.destination !== undefined) patch.destination = opts.destination;

    if (Object.keys(patch).length === 0) return false;

    db.put(MEM + id, { ...(existing as Record<string, unknown>), ...patch });
    return true;
  }

  async setImportanceScore(id: string, score: number): Promise<void> {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error("importance_score must be a finite non-negative number between 0 and 100");
    }
    await this.ensureInitialized();
    const db = this.getDB();
    const existing = db.get(MEM + id);
    if (!existing) return;
    db.put(MEM + id, { ...(existing as Record<string, unknown>), importance_score: score });
  }

  async getEmbeddingByteLength(): Promise<number | null> {
    await this.ensureInitialized();
    const all = this.getDB().list();
    for (const n of all) {
      if (!n.id.startsWith(MEM)) continue;
      const vec = toNumberArray(n.data.vector);
      if (vec.length > 0) return vec.length * 8;
    }
    return null;
  }

  // ── Daily summaries ──────────────────────────────────────────────────────────

  async generateDailySummary(date: string): Promise<DailySummary> {
    await this.ensureInitialized();
    const db = this.getDB();

    const dateObj = new Date(date + "T00:00:00.000Z");
    const startOfDay = dateObj.getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    const all = db.list();
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
      if (!categorizedMemories.has(mem.category)) categorizedMemories.set(mem.category, []);
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

    const summaryId = `daily-summary:${date}`;
    db.put(MEM + summaryId, {
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
    const all = this.getDB().list();

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

        return { date, summary: content, memoryCount: totalCount, categories, created_at: n.data.created_at as number };
      });
  }

  // ── Consolidation / world state / stale detection ────────────────────────────

  async findStaleMemories(daysThreshold: number = 30): Promise<Array<{ id: string; content: string; category: string; priority: MemoryPriority; daysSinceAccess: number }>> {
    await this.ensureInitialized();
    const threshold = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
    const all = this.getDB().list();

    return all
      .filter((n) => n.id.startsWith(MEM) && (n.data.created_at as number) < threshold)
      .map((n) => ({
        id: n.id.slice(MEM.length),
        content: (n.data.content as string) ?? "",
        category: (n.data.category as string) ?? "other",
        priority: (n.data.priority as MemoryPriority) ?? "normal",
        daysSinceAccess: Math.floor((Date.now() - (n.data.created_at as number)) / (1000 * 60 * 60 * 24)),
      }))
      .sort((a, b) => b.daysSinceAccess - a.daysSinceAccess);
  }

  async runConsolidation(opts: {
    dryRun?: boolean;
    stalenessDays?: number;
    dedupeThreshold?: number;
  }): Promise<{ merged: number; demoted: number; promoted: number }> {
    await this.ensureInitialized();
    const dryRun = opts.dryRun ?? true;
    const dedupeThreshold = opts.dedupeThreshold ?? 0.95;
    let merged = 0, demoted = 0, promoted = 0;

    const db = this.getDB();
    const all = db.list().filter((n) => n.id.startsWith(MEM));

    // Find near-duplicates via pairwise comparison
    const processed = new Set<string>();
    for (const node of all) {
      if (processed.has(node.id)) continue;
      const vec = toNumberArray(node.data.vector);
      if (vec.length === 0) continue;

      const similar = db.vectorSearch(vec, 5, dedupeThreshold);
      for (const match of similar) {
        if (match.id === node.id || processed.has(match.id)) continue;
        if ((match.score ?? 0) >= dedupeThreshold) {
          processed.add(match.id);
          if (!dryRun) {
            db.delete(match.id);
          }
          merged++;
        }
      }
    }

    return { merged, demoted, promoted };
  }

  async generateWorldState(): Promise<string> {
    await this.ensureInitialized();
    const all = this.getDB().list().filter((n) => n.id.startsWith(MEM));

    const highPriority = all
      .filter((n) => {
        const p = n.data.priority as string;
        const imp = (n.data.importance_score as number) ?? 1.0;
        return p === "critical" || p === "high" || imp >= 2.0;
      })
      .sort((a, b) => (b.data.created_at as number) - (a.data.created_at as number))
      .slice(0, 50);

    const sections: string[] = ["# World State Summary", "", `Generated: ${new Date().toISOString()}`, ""];
    const byCategory = new Map<string, string[]>();

    for (const n of highPriority) {
      const cat = (n.data.category as string) ?? "other";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(n.data.content as string);
    }

    for (const [cat, items] of byCategory) {
      const title = cat.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      sections.push(`## ${title}`, "");
      for (const item of items) sections.push(`- ${item}`);
      sections.push("");
    }

    return sections.join("\n");
  }

  // ── Conversation tagging ─────────────────────────────────────────────────────

  private generateTagLabel(content: string): string {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4);
    return words.length > 0 ? words.join(" ") : content.slice(0, 40).trim();
  }

  private getTagNode(tagId: string): (ConversationTag & { _node: Record<string, unknown> }) | null {
    const data = this.getDB().get(CONV_TAG + tagId);
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

  private putTagNode(tag: ConversationTag): void {
    this.getDB().put(CONV_TAG + tag.id, {
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

  private addMemoryToTag(tagId: string, memoryId: string, newEmbedding: number[]): void {
    const tag = this.getTagNode(tagId);
    if (!tag) return;
    if (tag.message_ids.includes(memoryId)) return;

    const messageIds = [...tag.message_ids, memoryId];
    const count = messageIds.length;
    const updatedEmbedding = tag.embedding.map(
      (v, i) => (v * (count - 1) + newEmbedding[i]) / count,
    );

    this.putTagNode({
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
    if (embedding.length === 0) return [];

    const db = this.getDB();
    const all = db.list();
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
      this.addMemoryToTag(bestMatchId, memoryId, embedding);
      return [bestMatchId];
    }

    const newTagId = randomUUID();
    const now = Date.now();
    this.putTagNode({
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
    const all = this.getDB().list();
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
    const tag = this.getTagNode(tagId);
    if (!tag || tag.message_ids.length === 0) return [];

    const db = this.getDB();
    const entries: MemoryEntry[] = [];
    for (const memId of tag.message_ids) {
      const data = db.get(MEM + memId);
      if (data) entries.push(this.nodeToEntry(data, memId));
    }

    return entries.sort((a, b) => a.created_at - b.created_at);
  }

  async getRelatedTags(tagId: string): Promise<ConversationTag[]> {
    await this.ensureInitialized();
    const tag = this.getTagNode(tagId);
    if (!tag) return [];

    const all = this.getDB().list();
    const related = new Map<string, ConversationTag>();

    for (const node of all) {
      if (!node.id.startsWith(CONV_TAG)) continue;
      const d = node.data;
      const id = node.id.slice(CONV_TAG.length);
      if (id === tagId) continue;

      if (d.parent_tag_id === tagId) {
        related.set(id, this.nodeToTag(d, id));
        continue;
      }
      if (tag.parent_tag_id) {
        if (id === tag.parent_tag_id || d.parent_tag_id === tag.parent_tag_id) {
          related.set(id, this.nodeToTag(d, id));
        }
      }
    }

    return Array.from(related.values());
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private entryToNode(entry: MemoryEntry): Record<string, unknown> {
    return {
      id: entry.id,
      content: entry.content,
      vector: entry.embedding,
      created_at: entry.created_at,
      source: entry.source ?? "",
      tags: entry.tags ?? [],
      category: entry.category ?? "other",
      priority: entry.priority ?? "normal",
      importance_score: entry.importance_score ?? 1.0,
      conversation_tag_ids: entry.conversation_tag_ids ?? [],
      originator_id: entry.originator_id ?? "",
      originator_name: entry.originator_name ?? "",
      destination: entry.destination ?? "",
      status: entry.status ?? "",
      assigned_to: entry.assigned_to ?? "",
      ...(entry.last_accessed_at !== undefined ? { last_accessed_at: entry.last_accessed_at } : {}),
      ...(entry.merge_count !== undefined ? { merge_count: entry.merge_count } : {}),
      ...(entry.due_at !== undefined ? { due_at: entry.due_at } : {}),
      ...(entry.last_checkin !== undefined ? { last_checkin: entry.last_checkin } : {}),
    };
  }

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
      originator_id: (data.originator_id as string) || undefined,
      originator_name: (data.originator_name as string) || undefined,
      destination: (data.destination as string) || undefined,
      status: (data.status as string) || undefined,
      assigned_to: (data.assigned_to as string) || undefined,
      due_at: typeof data.due_at === "number" ? data.due_at : undefined,
      last_checkin: typeof data.last_checkin === "number" ? data.last_checkin : undefined,
      ...(data.last_accessed_at !== undefined ? { last_accessed_at: data.last_accessed_at as number } : {}),
      ...(data.merge_count !== undefined ? { merge_count: data.merge_count as number } : {}),
    };
  }

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
      originator_id: (data.originator_id as string) || undefined,
      originator_name: (data.originator_name as string) || undefined,
      destination: (data.destination as string) || undefined,
      status: (data.status as string) || undefined,
      assigned_to: (data.assigned_to as string) || undefined,
      due_at: typeof data.due_at === "number" ? data.due_at : undefined,
      last_checkin: typeof data.last_checkin === "number" ? data.last_checkin : undefined,
    };
  }

  private nodeToTag(data: Record<string, unknown>, id: string): ConversationTag {
    return {
      id,
      label: (data.label as string) ?? "",
      embedding: toNumberArray(data.embedding),
      parent_tag_id: (data.parent_tag_id as string | undefined) ?? undefined,
      message_ids: Array.isArray(data.message_ids) ? (data.message_ids as string[]) : [],
      created_at: (data.created_at as number) ?? 0,
      updated_at: (data.updated_at as number) ?? 0,
      similarity_threshold: typeof data.similarity_threshold === "number" ? data.similarity_threshold : 0.85,
    };
  }

  /**
   * Execute PluresDB procedures query DSL
   * @param query DSL string (e.g., 'filter(category == "decision") |> sort(by: "score", dir: "desc") |> limit(10)')
   * @returns Query result with nodes or aggregation
   */
  async execDsl(query: string): Promise<{ nodes?: MemoryEntry[]; aggregate?: unknown; mutated?: number }> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const result = this.db.execDsl(query);
      
      // Convert nodes if present
      if (result.nodes) {
        const entries = result.nodes
          .filter((item) => item.id.startsWith(MEM))
          .map((item) => this.nodeToEntry(item.data, item.id.slice(MEM.length)));
        return { nodes: entries, mutated: result.mutated };
      }
      
      // Return aggregation if present
      if (result.aggregate !== undefined) {
        return { aggregate: result.aggregate, mutated: result.mutated };
      }
      
      return { nodes: [], mutated: result.mutated };
    } catch (error) {
      throw new Error(`PluresDB query failed: ${String(error)}`);
    }
  }

  /**
   * Execute PluresDB procedures IR (JSON format)
   * @param steps Array of operation objects
   * @returns Query result with nodes or aggregation
   */
  async execIr(steps: Array<Record<string, unknown>>): Promise<{ nodes?: MemoryEntry[]; aggregate?: unknown; mutated?: number }> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const result = this.db.execIr(steps);
      
      // Convert nodes if present
      if (result.nodes) {
        const entries = result.nodes
          .filter((item) => item.id.startsWith(MEM))
          .map((item) => this.nodeToEntry(item.data, item.id.slice(MEM.length)));
        return { nodes: entries, mutated: result.mutated };
      }
      
      // Return aggregation if present
      if (result.aggregate !== undefined) {
        return { aggregate: result.aggregate, mutated: result.mutated };
      }
      
      return { nodes: [], mutated: result.mutated };
    } catch (error) {
      throw new Error(`PluresDB IR query failed: ${String(error)}`);
    }
  }

  // ============================================================================
  // Shared Access Handling
  // ============================================================================

  private async handleSharedAccessFailure(processInfo: any, error: any): Promise<void> {
    console.log("[PluresDBBackend] Handling shared access failure...");
    
    if (error.message?.includes("could not acquire lock")) {
      console.log("[PluresDBBackend] Database locked by gateway");
      
      if (processInfo.isCLI) {
        // For CLI: Don't create fallback database - throw error to trigger retry
        console.log("[PluresDBBackend] CLI detected - will retry database access");
        throw new Error("Database temporarily locked - retry needed");
      } else {
        // For other processes, still create fallback if needed
        console.log("[PluresDBBackend] Creating fallback database for non-CLI process");
        const fallbackPath = this.dbPath.replace("/openclaw-gateway/", "/openclaw-fallback/");
        require("fs").mkdirSync(require("path").dirname(fallbackPath), { recursive: true });
        
        const PluresDatabase = loadNativeModule();
        try {
          this.db = PluresDatabase.newWithEmbeddings(this.embeddingModel, this.actorId, fallbackPath);
          console.log("[PluresDBBackend] Fallback database with embeddings initialized");
        } catch (err) {
          this.db = new PluresDatabase(this.actorId, fallbackPath);
          console.log("[PluresDBBackend] Fallback plain database initialized");
        }
        
        (this as any).__readOnlyMode = true;
        console.log("[PluresDBBackend] Operating in read-only fallback mode");
      }
    } else {
      // Re-throw other errors
      throw error;
    }
  }

  private isReadOnlyMode(): boolean {
    return !!(this as any).__readOnlyMode;
  }


  /**
   * Find memories related to a given memory via graph traversal.
   * Uses graph_neighbors DSL when available; falls back to edge-based traversal.
   * @param memoryId UUID of the memory (without "memory:" prefix)
   * @param options Traversal options (depth, minStrength, linkTypes)
   */
  async findRelated(
    memoryId: string,
    options?: { depth?: number; minStrength?: number; linkTypes?: string[] },
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const depth = options?.depth ?? 2;
    const minStrength = options?.minStrength;

    try {
      // Try graph DSL first (PluresDB v2.1.0+ Phase 2A)
      let dslQuery = `graph_neighbors("${MEM}${memoryId}", depth: ${depth})`;
      if (minStrength !== undefined) {
        dslQuery = `graph_neighbors("${MEM}${memoryId}", depth: ${depth}, min_strength: ${minStrength})`;
      }
      const result = await this.execDsl(dslQuery);
      return result.nodes ?? [];
    } catch {
      // Fall back to simple direct-edge traversal for compatibility
      const relation = options?.linkTypes?.[0];
      return this.getRelated(memoryId, relation);
    }
  }

  /**
   * Trigger automatic relationship discovery between memories.
   * Uses auto_link DSL when available; no-op on older PluresDB builds.
   * @param options Algorithm selection and target memory
   * @returns Number of new links created
   */
  async autoLink(options?: {
    algorithms?: string[];
    thresholds?: Record<string, number>;
    memoryId?: string;
  }): Promise<{ linksCreated: number }> {
    await this.ensureInitialized();

    try {
      let dsl: string;
      if (options?.memoryId) {
        dsl = `filter(id == "${MEM}${options.memoryId}") |> auto_link()`;
      } else {
        dsl = `auto_link()`;
      }
      const result = await this.execDsl(dsl);
      return { linksCreated: result.mutated ?? 0 };
    } catch {
      // auto_link DSL not available in this build — report 0 links created
      return { linksCreated: 0 };
    }
  }

  /**
   * Analyze memory relationship patterns to produce insight data.
   * Computed from stored memories and edges; no graph DSL required.
   * @param timespan Optional human-readable timespan label (e.g. "7d")
   */
  async getMemoryInsights(timespan?: string): Promise<InsightData> {
    await this.ensureInitialized();
    const db = this.getDB();
    const all = db.list();

    const memoryNodes = all.filter((n) => n.id.startsWith(MEM));
    const edgeNodes = all.filter((n) => n.id.startsWith(EDGE));

    // Build adjacency sets to identify connected vs isolated memories
    const connectedIds = new Set<string>();
    for (const edge of edgeNodes) {
      const fromId = edge.data.from_id as string | undefined;
      const toId = edge.data.to_id as string | undefined;
      if (fromId) connectedIds.add(fromId);
      if (toId) connectedIds.add(toId);
    }

    // Build neighbor map for cluster detection (BFS / union-find style)
    const neighbors = new Map<string, Set<string>>();
    for (const edge of edgeNodes) {
      const fromId = edge.data.from_id as string | undefined;
      const toId = edge.data.to_id as string | undefined;
      if (!fromId || !toId) continue;
      if (!neighbors.has(fromId)) neighbors.set(fromId, new Set());
      if (!neighbors.has(toId)) neighbors.set(toId, new Set());
      neighbors.get(fromId)!.add(toId);
      neighbors.get(toId)!.add(fromId);
    }

    // BFS to find connected clusters (size ≥ 2)
    const visited = new Set<string>();
    const clusters: InsightData["clusters"] = [];
    for (const node of memoryNodes) {
      const id = node.id.slice(MEM.length);
      if (visited.has(id) || !neighbors.has(id)) continue;

      const queue: string[] = [id];
      const clusterIds: string[] = [];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        clusterIds.push(cur);
        for (const neighbor of neighbors.get(cur) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }

      if (clusterIds.length >= 2) {
        const categories = [
          ...new Set(
            clusterIds.map((cid) => {
              const n = db.get(MEM + cid);
              return (n?.category as string) ?? "other";
            }),
          ),
        ];
        clusters.push({ rootId: clusterIds[0], size: clusterIds.length, categories });
      }
    }

    // Category frequency
    const catCounts = new Map<string, number>();
    for (const node of memoryNodes) {
      const cat = (node.data.category as string) ?? "other";
      catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    }
    const topCategories = Array.from(catCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }));

    const totalMemories = memoryNodes.length;
    const totalEdges = edgeNodes.length;
    const connectedMemories = connectedIds.size;
    const isolatedMemories = totalMemories - connectedMemories;

    return {
      totalMemories,
      totalEdges,
      isolatedMemories: Math.max(0, isolatedMemories),
      connectedMemories,
      clusters,
      topCategories,
      timespan,
    };
  }
}
