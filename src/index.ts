/**
 * Superlocalmemory Plugin for OpenClaw
 *
 * A local-first alternative to cloud-based supermemory using better-sqlite3 for
 * storage + vector search, with OpenAI/Ollama dual embeddings.
 *
 * Enhanced with coding intelligence:
 * - Auto-capture code patterns, type definitions, architecture decisions
 * - Project context indexing
 * - Error→fix pair memory with graph edges
 * - Cross-session WIP continuity
 * - Codebase indexing commands
 */

import { Type } from "@sinclair/typebox";
import { MemoryDB } from "./memory-db.js";
import { DualEmbeddings } from "./embeddings.js";
import { MemorySync } from "./sync.js";
import { createBackend, isBackendAvailable, type IMemoryBackend, type BackendType } from "./backend-factory.js";
import { parseMemoryMd, parseDailyFile, parseDailyDirectory, importMemories, verifyMigration } from "./migration.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  dbPath: string;
  /** Backend to use: 'better-sqlite3' (default) or 'pluresdb' */
  backend?: "better-sqlite3" | "pluresdb";
  embeddingProvider: "openai" | "ollama";
  embeddingModel: string;
  /** Optional OpenAI API key. If unset, plugin falls back to process.env.OPENAI_API_KEY */
  openaiApiKey?: string;
  embeddingDimension: number;
  ollamaModel: string;
  ollamaEndpoint: string;
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallResults: number;
  profileFrequency: number;
  dedupeThreshold: number;
  decayHalfLifeDays: number;
  debug: boolean;
  projectContextPaths: string[];
  projectIndexOnStart: boolean;
  projectIndexGlobs: string[];

  // Sync (Hyperswarm P2P)
  syncEnabled: boolean;
  syncKey: string;
}

const DEFAULTS: PluginConfig = {
  dbPath: "~/.openclaw/superlocalmemory.db",
  backend: "better-sqlite3", // Default to better-sqlite3 for backward compatibility
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  openaiApiKey: undefined,
  embeddingDimension: 1536,
  ollamaModel: "nomic-embed-text",
  ollamaEndpoint: "http://localhost:11434",
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  profileFrequency: 50,
  dedupeThreshold: 0.95,
  decayHalfLifeDays: 30,
  debug: false,
  projectContextPaths: [],
  projectIndexOnStart: true,
  projectIndexGlobs: ["**/README.md", "**/src/types/**/*.ts", "**/docs/architecture.md"],

  syncEnabled: false,
  syncKey: "",
};

const configSchema = {
  parse(value: unknown): PluginConfig {
    const c = (value ?? {}) as Partial<PluginConfig>;
    return { ...DEFAULTS, ...c };
  },
};

// ============================================================================
// Capture filtering
// ============================================================================

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|sure|yes|no|yep|nope|bye|gm|gn)[\s!.]*$/i,
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^\/\w+/,
];

function isTrivial(text: string): boolean {
  if (text.length < 20) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(text.trim()));
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want|don't like|favorite/i.test(lower)) return "preference";
  if (/decided|will use|going to|plan to|let's use/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|named|called/i.test(lower)) return "entity";
  if (/project|repo|codebase|building|working on/i.test(lower)) return "project";
  if (/remember|note|important/i.test(lower)) return "explicit";
  return "conversation";
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const people = text.match(/(?:@\w+|(?:named?|called)\s+(\w+))/gi);
  if (people) tags.push(...people.map((p) => `person:${p.replace(/^@/, "")}`));
  const tech = text.match(/\b(typescript|python|rust|react|node|docker|kubernetes|git|api|graphql|postgres|redis|nextjs|svelte|vue|angular)\b/gi);
  if (tech) tags.push(...tech.map((t) => `tech:${t.toLowerCase()}`));
  return [...new Set(tags)];
}

// ============================================================================
// Code Pattern Extraction
// ============================================================================

interface ExtractedPattern {
  content: string;
  category: string;
  tags: string[];
  language?: string;
}

/**
 * Extract code blocks from markdown text. Returns array of {code, language}.
 */
function extractCodeBlocks(text: string): Array<{ code: string; language: string }> {
  const blocks: Array<{ code: string; language: string }> = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1] || "unknown";
    const code = match[2].trim();
    // Skip trivial blocks (< 3 lines) and output/log blocks
    const lines = code.split("\n");
    if (lines.length < 3) continue;
    if (/^\$\s|^>\s|^\[.*\]\s/.test(code)) continue; // shell output, logs
    blocks.push({ code, language: lang });
  }
  return blocks;
}

/**
 * Parse conversation text for code patterns and return structured extractions.
 */
function extractCodePatterns(text: string): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];
  const blocks = extractCodeBlocks(text);

  for (const { code, language } of blocks) {
    const langTag = language !== "unknown" ? `lang:${language}` : undefined;
    const baseTags = [...extractTags(code), ...(langTag ? [langTag] : [])];

    // Function signatures
    if (/(?:export\s+)?(?:async\s+)?function\s+\w+|(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(/.test(code)) {
      patterns.push({ content: code, category: "code-pattern", tags: [...baseTags, "pattern:function"], language });
    }

    // Type definitions
    if (/(?:export\s+)?(?:interface|type|class|enum)\s+\w+/.test(code)) {
      patterns.push({ content: code, category: "type-definition", tags: [...baseTags, "pattern:type"], language });
    }

    // Module composition (import/export patterns)
    const importLines = code.split("\n").filter((l) => /^(?:import|export)\s/.test(l.trim()));
    if (importLines.length >= 2) {
      patterns.push({ content: importLines.join("\n"), category: "module-composition", tags: [...baseTags, "pattern:module"], language });
    }

    // API patterns
    if (/(?:fetch|axios|\.get|\.post|\.put|\.delete|app\.(get|post|put|delete|use)|router\.|endpoint|@(Get|Post|Put|Delete)|createServer)/.test(code)) {
      patterns.push({ content: code, category: "api-pattern", tags: [...baseTags, "pattern:api"], language });
    }
  }

  // Architecture decisions (plain text, not code blocks)
  const plainText = text.replace(/```[\s\S]*?```/g, "");
  const archPatterns = [
    /(?:we decided|let's use|the approach is|instead of .{3,40} we'll use|architecture:|design decision:)[^\n]*/gi,
  ];
  for (const pat of archPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pat.exec(plainText)) !== null) {
      const content = match[0].trim();
      if (content.length > 20) {
        patterns.push({
          content,
          category: "architecture-decision",
          tags: [...extractTags(content), "pattern:architecture"],
        });
      }
    }
  }

  return patterns;
}

// ============================================================================
// Error→Fix Detection
// ============================================================================

interface ErrorFixPair {
  error: string;
  fix: string;
  errorTags: string[];
}

const ERROR_PATTERNS = [
  /^Error:\s*.+/m,
  /^TypeError:\s*.+/m,
  /^ReferenceError:\s*.+/m,
  /^SyntaxError:\s*.+/m,
  /^\s+at\s+.+/m,
  /^Uncaught\s+.+/m,
  /^ENOENT|EACCES|ECONNREFUSED/m,
  /^panic:|^thread '.+' panicked/m,
  /^Traceback \(most recent call last\)/m,
];

function containsError(text: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(text));
}

function containsFix(text: string): boolean {
  const lower = text.toLowerCase();
  return /(?:fix|solved|solution|resolved|the issue was|the problem was|try this|change .+ to|replace .+ with|you need to|should be)/.test(lower);
}

/**
 * Scan sequential messages for error→fix pairs.
 */
function detectErrorFixPairs(messages: string[]): ErrorFixPair[] {
  const pairs: ErrorFixPair[] = [];

  for (let i = 0; i < messages.length - 1; i++) {
    if (!containsError(messages[i])) continue;

    // Look ahead up to 3 messages for a fix
    for (let j = i + 1; j < Math.min(i + 4, messages.length); j++) {
      if (containsFix(messages[j])) {
        // Extract the core error (first few error lines)
        const errorLines = messages[i].split("\n").filter((l) =>
          ERROR_PATTERNS.some((p) => p.test(l))
        ).slice(0, 5);
        const errorContent = errorLines.length > 0 ? errorLines.join("\n") : messages[i].slice(0, 500);

        pairs.push({
          error: errorContent,
          fix: messages[j].slice(0, 1000),
          errorTags: extractTags(messages[i] + " " + messages[j]),
        });
        break;
      }
    }
  }

  return pairs;
}

// ============================================================================
// WIP Detection
// ============================================================================

const WIP_PATTERNS = [
  /(?:i'll continue|continue this tomorrow|next steps?:|TODO:|FIXME:|need to figure out|still need to|haven't finished|work in progress|WIP:|left off at|pick up where)/i,
  /(?:next session|come back to|unfinished|remaining work|blocked on|waiting for)/i,
];

function isWorkInProgress(text: string): boolean {
  return WIP_PATTERNS.some((p) => p.test(text));
}

// ============================================================================
// Project File Indexing
// ============================================================================

/**
 * Chunk a markdown file by headings.
 */
function chunkMarkdown(content: string, filePath: string): Array<{ text: string; heading: string }> {
  const chunks: Array<{ text: string; heading: string }> = [];
  const sections = content.split(/(?=^#{1,3}\s)/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < 30) continue;
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    const heading = headingMatch ? headingMatch[2] : path.basename(filePath);

    // If section is too long, split further (~2000 chars ≈ 500 tokens)
    if (trimmed.length > 2000) {
      const paragraphs = trimmed.split(/\n\n+/);
      let chunk = "";
      for (const para of paragraphs) {
        if (chunk.length + para.length > 2000 && chunk.length > 100) {
          chunks.push({ text: chunk.trim(), heading });
          chunk = "";
        }
        chunk += para + "\n\n";
      }
      if (chunk.trim().length > 30) {
        chunks.push({ text: chunk.trim(), heading });
      }
    } else {
      chunks.push({ text: trimmed, heading });
    }
  }

  return chunks;
}

/**
 * Chunk a TypeScript/code file by top-level declarations.
 */
function chunkCodeFile(content: string, filePath: string): Array<{ text: string; heading: string }> {
  const chunks: Array<{ text: string; heading: string }> = [];
  // Split on top-level export/function/class/interface/type/const declarations
  const parts = content.split(/(?=^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s)/m);

  let currentChunk = "";
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length > 2000 && currentChunk.length > 100) {
      const heading = extractDeclName(currentChunk) || path.basename(filePath);
      chunks.push({ text: currentChunk.trim(), heading });
      currentChunk = "";
    }
    currentChunk += trimmed + "\n\n";
  }

  if (currentChunk.trim().length > 30) {
    const heading = extractDeclName(currentChunk) || path.basename(filePath);
    chunks.push({ text: currentChunk.trim(), heading });
  }

  return chunks;
}

function extractDeclName(code: string): string | null {
  const match = code.match(/(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+(\w+)/);
  return match ? match[1] : null;
}

/**
 * Recursively find files matching extensions.
 */
function findFiles(dir: string, extensions: string[], maxDepth: number = 10, depth: number = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common non-source dirs
        if (/^(node_modules|\.git|dist|build|target|\.next|__pycache__|\.venv)$/.test(entry.name)) continue;
        results.push(...findFiles(fullPath, extensions, maxDepth, depth + 1));
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission denied or other FS error
  }

  return results;
}

// ============================================================================
// Plugin
// ============================================================================

let turnCounter = 0;

const superlocalmemory = {
  id: "superlocalmemory",
  name: "Superlocalmemory",
  description: "Local-first long-term memory with vector search, graph edges, and coding intelligence",
  kind: "memory" as const,
  configSchema,

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    
    // Create backend based on configuration
    const backendType = cfg.backend || "better-sqlite3";
    const db: IMemoryBackend = createBackend({
      type: backendType,
      dbPath: resolvedDbPath,
      vectorDimension: cfg.embeddingDimension,
      decayHalfLifeDays: cfg.decayHalfLifeDays,
    });

    const resolvedOpenAIKey = process.env.OPENAI_API_KEY || cfg.openaiApiKey;

    const embeddings = new DualEmbeddings(
      {
        openaiKey: resolvedOpenAIKey,
        openaiModel: cfg.embeddingModel,
        ollamaEndpoint: cfg.ollamaEndpoint,
        ollamaModel: cfg.ollamaModel,
        dimension: cfg.embeddingDimension,
        debug: cfg.debug,
      },
      api.logger,
    );

    const debug = (msg: string) => cfg.debug && api.logger.info(`[superlocalmemory] ${msg}`);

    const DB_CLOSED_RE = /database connection is not open/i;

    const isDbClosedError = (err: unknown): boolean => {
      const msg = String(err);
      return DB_CLOSED_RE.test(msg) || msg.includes("SQLITE_MISUSE");
    };

    const ensureDbOpen = async (): Promise<void> => {
      if (await db.isOpen()) return;
      api.logger.warn("superlocalmemory: db handle was closed/stale; reopening...");
      await db.reopen();
    };

    const withDbRetry = async <T>(op: () => Promise<T>): Promise<T> => {
      await ensureDbOpen();
      try {
        return await op();
      } catch (err) {
        if (!isDbClosedError(err)) throw err;
        api.logger.warn(`superlocalmemory: db operation failed (${String(err)}); reopening and retrying once...`);
        db.reopen();
        return await op();
      }
    };

    const maskSyncKey = (key: string) => {
      if (!key) return "(unset)";
      if (key.length <= 12) return `${key.slice(0, 4)}…${key.slice(-2)}`;
      return `${key.slice(0, 6)}…${key.slice(-6)}`;
    };

    let sync: MemorySync | null = null;

    api.logger.info(`superlocalmemory: initialized (db: ${resolvedDbPath})`);

    // ========================================================================
    // Project File Indexing Helper
    // ========================================================================

    async function indexProjectFile(filePath: string): Promise<number> {
      const resolvedPath = api.resolvePath(filePath);
      if (!fs.existsSync(resolvedPath)) {
        debug(`indexProjectFile: file not found: ${resolvedPath}`);
        return 0;
      }

      const content = fs.readFileSync(resolvedPath, "utf-8");
      if (!content.trim()) return 0;

      const ext = path.extname(resolvedPath).toLowerCase();
      const isMarkdown = ext === ".md";
      const chunks = isMarkdown
        ? chunkMarkdown(content, resolvedPath)
        : chunkCodeFile(content, resolvedPath);

      // Delete existing chunks from this file before re-indexing
      const sourceTag = `project-file:${resolvedPath}`;
      await db.deleteBySource(sourceTag);

      let stored = 0;
      for (const chunk of chunks) {
        const embedding = await embeddings.embed(chunk.text);
        const result = await db.store(chunk.text, embedding, {
          source: sourceTag,
          tags: [`file:${path.basename(resolvedPath)}`, `heading:${chunk.heading}`, ...extractTags(chunk.text)],
          category: "project-context",
          dedupeThreshold: cfg.dedupeThreshold,
        });
        if (!result.isDuplicate) stored++;
      }

      debug(`indexed ${stored} chunks from ${resolvedPath}`);
      return stored;
    }

    async function indexDirectory(dirPath: string): Promise<{ files: number; chunks: number }> {
      const resolvedDir = api.resolvePath(dirPath);
      const files = findFiles(resolvedDir, [".ts", ".tsx", ".md", ".rs", ".py", ".js", ".jsx"]);
      let totalChunks = 0;

      for (const file of files) {
        const chunks = await indexProjectFile(file);
        totalChunks += chunks;
      }

      return { files: files.length, chunks: totalChunks };
    }

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "superlocalmemory_store",
        label: "Store Memory",
        description:
          "Store information in long-term memory. Use for facts, preferences, decisions, or anything the user wants remembered.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
          category: Type.Optional(
            Type.String({ description: "Category: preference, decision, entity, project, explicit, conversation, code-pattern, type-definition, module-composition, api-pattern, architecture-decision, error-fix, work-in-progress, project-context" }),
          ),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { text, tags, category } = params as { text: string; tags?: string[]; category?: string };
            const embedding = await embeddings.embed(text);
            const allTags = [...(tags ?? []), ...extractTags(text)];
            const cat = category ?? detectCategory(text);

            const result = await db.store(text, embedding, {
              tags: allTags, category: cat, dedupeThreshold: cfg.dedupeThreshold,
            });

            if (result.isDuplicate) {
              return {
                content: [{ type: "text", text: `Updated existing memory: "${result.entry.content.slice(0, 80)}..."` }],
              };
            }

            await db.incrementCaptureCount();
            return { content: [{ type: "text", text: `Stored memory [${cat}]: "${text.slice(0, 80)}..."` }] };
          });
        },
      },
      { name: "superlocalmemory_store" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_search",
        label: "Search Memory",
        description: "Search long-term memories by semantic similarity.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { query, limit } = params as { query: string; limit?: number };
            const embedding = await embeddings.embed(query);
            const results = await db.vectorSearch(embedding, limit ?? cfg.maxRecallResults, 0.3);

            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }] };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.entry.category}] ${r.entry.content} (${(r.score * 100).toFixed(0)}% match)`)
              .join("\n");

            return { content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }] };
          });
        },
      },
      { name: "superlocalmemory_search" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_forget",
        label: "Forget Memory",
        description: "Delete memories by ID or semantic search.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search query to find memories to delete" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { query, memoryId } = params as { query?: string; memoryId?: string };

            if (memoryId) {
              await db.delete(memoryId);
              return { content: [{ type: "text", text: `Memory ${memoryId} deleted.` }] };
            }

            if (query) {
              const embedding = await embeddings.embed(query);
              const results = await db.vectorSearch(embedding, 5, 0.7);

              if (results.length === 0) {
                return { content: [{ type: "text", text: "No matching memories found." }] };
              }

              if (results.length === 1 && results[0].score > 0.9) {
                await db.delete(results[0].entry.id);
                return { content: [{ type: "text", text: `Deleted: "${results[0].entry.content.slice(0, 80)}"` }] };
              }

              const list = results
                .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.content.slice(0, 60)}... (${(r.score * 100).toFixed(0)}%)`)
                .join("\n");
              return { content: [{ type: "text", text: `Found ${results.length} candidates. Specify memoryId:\n${list}` }] };
            }

            return { content: [{ type: "text", text: "Provide a query or memoryId." }] };
          });
        },
      },
      { name: "superlocalmemory_forget" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_profile",
        label: "User Profile",
        description: "View the user's distilled profile built from memory.",
        parameters: Type.Object({}),
        async execute() {
          return await withDbRetry(async () => {
            const profile = await db.getProfile();
            if (!profile || !profile.summary) {
              const stats = await db.stats();
              return {
                content: [{
                  type: "text",
                  text: `No profile built yet. ${stats.totalMemories} memories stored. Profile builds every ${cfg.profileFrequency} captures.`,
                }],
              };
            }

            const factsStr = profile.facts.length > 0 ? "\n\nKey facts:\n" + profile.facts.map((f) => `- ${f}`).join("\n") : "";
            return {
              content: [{
                type: "text",
                text: `User Profile (updated ${new Date(profile.updated_at).toLocaleDateString()}):\n\n${profile.summary}${factsStr}`,
              }],
            };
          });
        },
      },
      { name: "superlocalmemory_profile" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_index",
        label: "Index Project",
        description: "Index a project directory into memory. Recursively finds .ts, .md, .rs, .py files, chunks them, and stores as project-context memories.",
        parameters: Type.Object({
          path: Type.String({ description: "Path to project directory to index" }),
        }),
        async execute(_id, params) {
          const { path: dirPath } = params as { path: string };

          try {
            return await withDbRetry(async () => {
              const result = await indexDirectory(dirPath);
              return {
                content: [{
                  type: "text",
                  text: `Indexed project at ${dirPath}:\n- Files scanned: ${result.files}\n- Chunks stored: ${result.chunks}`,
                }],
              };
            });
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to index project: ${String(err)}` }],
            };
          }
        },
      },
      { name: "superlocalmemory_index" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_sync_keygen",
        label: "Generate Sync Key",
        description: "Generate a new 32-byte (64 hex char) Hyperswarm sync key for P2P memory sync.",
        parameters: Type.Object({}),
        async execute() {
          const key = MemorySync.generateKey();
          return { content: [{ type: "text", text: key }] };
        },
      },
      { name: "superlocalmemory_sync_keygen" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_sync_status",
        label: "Sync Status",
        description: "Show Hyperswarm sync status (peer count, last sync time, key).",
        parameters: Type.Object({}),
        async execute() {
          return await withDbRetry(async () => {
            const peers = sync?.peerCount ?? 0;
            const last = await db.getLastSyncTime("__global__");
            const lastStr = last ? new Date(last).toLocaleString() : "never";
            const enabled = Boolean(cfg.syncEnabled && cfg.syncKey);

            const lines = [
              `enabled: ${enabled}`,
              `peerCount: ${peers}`,
              `lastSync: ${lastStr}`,
              `syncKey: ${maskSyncKey(cfg.syncKey)}`,
            ];
            return { content: [{ type: "text", text: lines.join("\n") }] };
          });
        },
      },
      { name: "superlocalmemory_sync_status" },
    );

    // ========================================================================
    // Lifecycle Hooks — Auto-Recall (with WIP boosting)
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;
        if (isTrivial(event.prompt)) return;

        try {
          return await withDbRetry(async () => {
            const embedding = await embeddings.embed(event.prompt);

            // Boost WIP memories so they surface first in new sessions
            const results = await db.vectorSearchBoosted(
              embedding,
              cfg.maxRecallResults,
              0.3,
              { "work-in-progress": 1.3 },
            );

            const parts: string[] = [];

            turnCounter++;
            if (turnCounter % cfg.profileFrequency === 0) {
              const profile = await db.getProfile();
              if (profile?.summary) {
                parts.push(`<user-profile>\n${profile.summary}\n</user-profile>`);
              }
            }

            if (results.length > 0) {
              const memoryLines = results
                .map((r) => `- [${r.entry.category}] ${r.entry.content}`)
                .join("\n");
              parts.push(`<relevant-memories>\n${memoryLines}\n</relevant-memories>`);
            }

            if (parts.length === 0) return;

            debug(`injecting ${results.length} memories into context`);

            return { prependContext: parts.join("\n\n") };
          });
        } catch (err) {
          api.logger.warn(`superlocalmemory: recall failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Lifecycle Hooks — Auto-Capture (enhanced with code intelligence)
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          await withDbRetry(async () => {
            const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const m = msg as Record<string, unknown>;
            if (m.role !== "user" && m.role !== "assistant") continue;

            if (typeof m.content === "string") {
              texts.push(m.content);
            } else if (Array.isArray(m.content)) {
              for (const block of m.content) {
                if (
                  block && typeof block === "object" &&
                  (block as Record<string, unknown>).type === "text" &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          const capturable = texts.filter((t) => !isTrivial(t) && !t.includes("<relevant-memories>"));
          if (capturable.length === 0) return;

          let stored = 0;

          // --- Original conversation capture ---
          for (const text of capturable.slice(0, 3)) {
            const embedding = await embeddings.embed(text);
            const cat = detectCategory(text);
            const result = await db.store(text, embedding, {
              source: "auto-capture",
              tags: extractTags(text),
              category: cat,
              dedupeThreshold: cfg.dedupeThreshold,
            });
            if (!result.isDuplicate) stored++;
          }

          // --- Code pattern extraction ---
          const fullText = capturable.join("\n\n");
          const codePatterns = extractCodePatterns(fullText);
          for (const pattern of codePatterns) {
            const embedding = await embeddings.embed(pattern.content);
            const result = await db.store(pattern.content, embedding, {
              source: "auto-capture:code",
              tags: pattern.tags,
              category: pattern.category,
              dedupeThreshold: cfg.dedupeThreshold,
            });
            if (!result.isDuplicate) stored++;
          }

          // --- Error→fix pair detection ---
          const errorFixPairs = detectErrorFixPairs(capturable);
          for (const pair of errorFixPairs) {
            const errorEmbedding = await embeddings.embed(pair.error);
            const errorResult = await db.store(pair.error, errorEmbedding, {
              source: "auto-capture:error",
              tags: [...pair.errorTags, "type:error"],
              category: "error-fix",
              dedupeThreshold: cfg.dedupeThreshold,
            });

            const fixEmbedding = await embeddings.embed(pair.fix);
            const fixResult = await db.store(pair.fix, fixEmbedding, {
              source: "auto-capture:fix",
              tags: [...pair.errorTags, "type:fix"],
              category: "error-fix",
              dedupeThreshold: cfg.dedupeThreshold,
            });

            // Link error→fix via graph edge
            if (!errorResult.isDuplicate && !fixResult.isDuplicate) {
              await db.addEdge(errorResult.entry.id, fixResult.entry.id, "fixed-by");
              stored += 2;
            } else if (!errorResult.isDuplicate || !fixResult.isDuplicate) {
              const errorId = errorResult.updatedId ?? errorResult.entry.id;
              const fixId = fixResult.updatedId ?? fixResult.entry.id;
              await db.addEdge(errorId, fixId, "fixed-by");
              if (!errorResult.isDuplicate) stored++;
              if (!fixResult.isDuplicate) stored++;
            }
          }

          // --- WIP detection ---
          for (const text of capturable) {
            if (isWorkInProgress(text)) {
              const embedding = await embeddings.embed(text);
              const result = await db.store(text, embedding, {
                source: "auto-capture:wip",
                tags: [...extractTags(text), "wip"],
                category: "work-in-progress",
                dedupeThreshold: cfg.dedupeThreshold,
              });
              if (!result.isDuplicate) stored++;
            }
          }

          if (stored > 0) {
            const newCount = await db.incrementCaptureCount();
            debug(`auto-captured ${stored} memories (total captures: ${newCount})`);

            if (newCount > 0 && newCount % cfg.profileFrequency === 0) {
              debug("triggering profile rebuild...");
              void rebuildProfile();
            }
          }
        });
        } catch (err) {
          api.logger.warn(`superlocalmemory: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Profile Building
    // ========================================================================

    async function rebuildProfile(): Promise<void> {
      try {
        await withDbRetry(async () => {
          const allContent = await db.getAllContent(100);
        if (allContent.length < 5) return;

        const facts = new Set<string>();
        const topics = new Map<string, number>();

        for (const content of allContent) {
          if (/prefer|like|love|hate|favorite/i.test(content)) facts.add(content.slice(0, 200));
          if (/project|building|working on|repo/i.test(content)) facts.add(content.slice(0, 200));
          if (/my name|i am|i'm a/i.test(content)) facts.add(content.slice(0, 200));

          const techMatches = content.match(/\b(typescript|python|rust|react|node|docker|git|graphql|postgres|redis|nextjs|svelte|vue|angular)\b/gi);
          if (techMatches) {
            for (const t of techMatches) {
              const key = t.toLowerCase();
              topics.set(key, (topics.get(key) ?? 0) + 1);
            }
          }
        }

        const topTopics = [...topics.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([t, c]) => `${t} (mentioned ${c}x)`);

        const summary = [
          `Profile built from ${allContent.length} memories.`,
          topTopics.length > 0 ? `Top topics: ${topTopics.join(", ")}` : "",
          `${facts.size} key facts extracted.`,
        ].filter(Boolean).join("\n");

        await db.setProfile({
          summary,
          facts: [...facts].slice(0, 50),
          updated_at: Date.now(),
          capture_count: await db.count(),
        });

        debug(`profile rebuilt: ${facts.size} facts, ${topTopics.length} topics`);
      });
      } catch (err) {
        api.logger.warn(`superlocalmemory: profile rebuild failed: ${String(err)}`);
      }
    }

    // ========================================================================
    // Dashboard Helpers
    // ========================================================================

    /**
     * Test an Ollama endpoint and return latency in milliseconds.
     * Returns null if the endpoint is unreachable.
     */
    async function testOllamaEndpoint(endpoint: string, model: string): Promise<number | null> {
      try {
        const start = Date.now();
        const response = await fetch(`${endpoint}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "test" }),
          signal: AbortSignal.timeout(5000), // 5 second timeout
        });
        
        if (!response.ok) return null;
        await response.json();
        return Date.now() - start;
      } catch {
        return null;
      }
    }

    /**
     * Render a horizontal bar chart using box-drawing characters.
     */
    function renderHistogram(data: Array<{ date: string; count: number }>): string {
      if (data.length === 0) return "(no data)";
      
      const maxCount = Math.max(...data.map(d => d.count), 1);
      const maxBarWidth = 10;
      
      return data.map(({ date, count }) => {
        if (count === 0) return `  ${date}: (no data)`;
        const barLength = Math.ceil((count / maxCount) * maxBarWidth);
        const bar = "█".repeat(barLength);
        return `  ${date}: ${bar} ${count}`;
      }).join("\n");
    }

    /**
     * Format bytes to human-readable size.
     */
    function formatBytes(bytes: number): string {
      if (bytes === 0) return "0 B";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const slm = program.command("slm").description("Superlocalmemory commands");

        slm.command("stats").description("Show memory stats").action(async () => {
          await ensureDbOpen();
          const stats = await db.stats();
          const profile = await db.getProfile();
          const output = {
            ...stats,
            lastCaptureTime: stats.lastCaptureTime ? new Date(stats.lastCaptureTime).toISOString() : null,
            profileSummary: profile?.summary?.slice(0, 200) ?? "No profile yet",
          };
          console.log(JSON.stringify(output, null, 2));
        });

        slm.command("search").description("Search memories").argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            return await withDbRetry(async () => {
              const embedding = await embeddings.embed(query);
              const results = await db.vectorSearch(embedding, parseInt(opts.limit), 0.3);
              const output = results.map((r) => ({
              id: r.entry.id, content: r.entry.content.slice(0, 100),
              category: r.entry.category, score: r.score,
            }));
              console.log(JSON.stringify(output, null, 2));
            });
          });

        slm.command("profile").description("Show user profile").action(async () => {
          await ensureDbOpen();
          const profile = await db.getProfile();
          console.log(profile ? JSON.stringify(profile, null, 2) : "No profile yet.");
        });

        slm.command("dashboard").description("Show memory system health dashboard").action(async () => {
          ensureDbOpen();
          const stats = await db.stats();
          const profile = await db.getProfile();
          const topTopics = (db as MemoryDB).getTopTopics(3);
          const captureRate = (db as MemoryDB).getCaptureRateHistory(7);
          const dbSize = (db as MemoryDB).getDbSize();

          console.log("\n📊 Superlocalmemory Dashboard");
          console.log("═══════════════════════════════════════");
          console.log(`Total memories:     ${stats.totalMemories.toLocaleString()}`);

          // Category breakdown
          const total = stats.totalMemories || 1; // Avoid division by zero
          const sortedCategories = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]);
          
          for (const [category, count] of sortedCategories) {
            const percentage = Math.round((count / total) * 100);
            console.log(`  ${category}:`.padEnd(22) + `${count.toLocaleString()} (${percentage}%)`);
          }

          // Add categories with 0 count
          const defaultCategories = ["conversation", "code-pattern", "error-fix", "work-in-progress"];
          for (const cat of defaultCategories) {
            if (!stats.categories[cat]) {
              console.log(`  ${cat}:`.padEnd(22) + "0 (0%)");
            }
          }

          console.log("\nEmbedding health:");
          console.log(`  Provider: ${cfg.embeddingProvider === "ollama" ? "Ollama" : "OpenAI"} (${cfg.embeddingProvider === "ollama" ? cfg.ollamaModel : cfg.embeddingModel})`);

          // Test Ollama endpoints if using Ollama
          if (cfg.embeddingProvider === "ollama") {
            const primaryLatency = await testOllamaEndpoint(cfg.ollamaEndpoint, cfg.ollamaModel);
            const primaryStatus = primaryLatency !== null ? `✅ ${cfg.ollamaEndpoint} (${primaryLatency}ms)` : `❌ ${cfg.ollamaEndpoint} (unreachable)`;
            console.log(`  Endpoint: ${primaryStatus}`);
            
            // Test fallback endpoint if different from primary
            const OLLAMA_CPU_FALLBACK = "http://127.0.0.1:11435";
            if (cfg.ollamaEndpoint !== OLLAMA_CPU_FALLBACK) {
              const fallbackLatency = await testOllamaEndpoint(OLLAMA_CPU_FALLBACK, cfg.ollamaModel);
              const fallbackStatus = fallbackLatency !== null ? `✅ ${OLLAMA_CPU_FALLBACK} (${fallbackLatency}ms)` : `❌ ${OLLAMA_CPU_FALLBACK} (unreachable)`;
              console.log(`  CPU fallback: ${fallbackStatus}`);
            }
          }

          console.log(`  Dimension: ${cfg.embeddingDimension}`);

          console.log("\nCapture rate (last 7 days):");
          console.log(renderHistogram(captureRate));

          console.log(`\nTop topics: ${topTopics.length > 0 ? topTopics.map(t => `${t.topic} (${t.count}x)`).join(", ") : "none"}`);

          console.log(`\nGraph edges: ${stats.edgeCount}`);
          
          const requiredCaptures = cfg.profileFrequency || 50;
          const captureCount = profile?.capture_count ?? 0;
          const hasSummary = !!profile?.summary;
          const isBuilt = hasSummary && captureCount >= requiredCaptures;
          const remainingCaptures = Math.max(0, requiredCaptures - captureCount);
          const profileStatus = isBuilt
            ? "Built"
            : `Not built yet (need ${remainingCaptures} more captures)`;
          console.log(`Profile: ${profileStatus}`);

          console.log(`Sync: ${cfg.syncEnabled ? "enabled" : "disabled"}`);
          console.log(`DB size: ${formatBytes(dbSize)}`);
          console.log("");
        });
        slm.command("dedup")
          .description("Find and merge duplicate memories")
          .option("--dry-run", "Preview merges without applying them")
          .action(async (opts: { dryRun?: boolean }) => {
            const dryRun = opts.dryRun ?? false;
            console.log(dryRun ? "Finding duplicate memories (dry run)..." : "Finding and merging duplicate memories...");
            
            await withDbRetry(async () => {
              const duplicates = await (db as MemoryDB).findDuplicates(dryRun);
              
              if (duplicates.length === 0) {
                console.log("No duplicate clusters found.");
                return;
              }
              
              console.log(`\nFound ${duplicates.length} duplicate cluster(s):\n`);
              
              for (let i = 0; i < duplicates.length; i++) {
                const dup = duplicates[i];
                console.log(`Cluster ${i + 1}:`);
                console.log(`  Target: ${dup.targetId}`);
                console.log(`  Content: "${dup.targetContent}..."`);
                console.log(`  Duplicates (${dup.duplicates.length}):`);
                dup.duplicates.forEach(d => {
                  console.log(`    - ${d.id} (similarity: ${(d.similarity * 100).toFixed(1)}%)`);
                  console.log(`      "${d.content}..."`);
                });
                console.log(`  Merged tags: ${dup.mergedTags.join(", ")}`);
                console.log();
              }
              
              if (dryRun) {
                console.log(`Run without --dry-run to apply these merges.`);
              } else {
                console.log(`Merged ${duplicates.length} cluster(s).`);
              }
            });
          });

        slm.command("index")
          .description("Index a project directory into memory")
          .argument("<path>", "Project directory path")
          .action(async (dirPath: string) => {
            console.log(`Indexing ${dirPath}...`);
            await withDbRetry(async () => {
              const result = await indexDirectory(dirPath);
              console.log(`Done. Files scanned: ${result.files}, Chunks stored: ${result.chunks}`);
            });
          });

        slm.command("migrate-from-files")
          .description("Import existing memory files into SLM")
          .option("--source <path>", "Path to MEMORY.md file or memory directory")
          .option("--priority <level>", "Memory priority (critical, high, normal)", "critical")
          .option("--category <name>", "Memory category", "migrated-memory")
          .option("--dry-run", "Preview imports without storing")
          .action(async (opts: { source?: string; priority?: string; category?: string; dryRun?: boolean }) => {
            if (!opts.source) {
              console.error("Error: --source flag is required");
              return;
            }

            const sourcePath = path.resolve(opts.source);
            const isDryRun = opts.dryRun ?? false;

            console.log(`\n📥 Migrating from: ${sourcePath}`);
            console.log(`Priority: ${opts.priority}, Category: ${opts.category}`);
            if (isDryRun) console.log("Mode: DRY RUN (no changes will be made)\n");

            try {
              await withDbRetry(async () => {
                let memories;

                // Detect if source is a file or directory
                const stat = fs.statSync(sourcePath);
                if (stat.isFile()) {
                  if (sourcePath.endsWith("MEMORY.md") || path.basename(sourcePath) === "MEMORY.md") {
                    console.log("Detected MEMORY.md file");
                    memories = parseMemoryMd(sourcePath);
                  } else {
                    console.log("Detected daily memory file");
                    memories = parseDailyFile(sourcePath);
                  }
                } else if (stat.isDirectory()) {
                  console.log("Detected directory with daily memory files");
                  memories = parseDailyDirectory(sourcePath);
                } else {
                  throw new Error("Source must be a file or directory");
                }

                console.log(`Found ${memories.length} memory items to import\n`);

                if (memories.length === 0) {
                  console.log("No memories to import");
                  return;
                }

                // Override category and priority if specified
                if (opts.category && opts.category !== "migrated-memory") {
                  memories = memories.map(m => ({ ...m, category: opts.category! }));
                }
                if (opts.priority && opts.priority !== "critical") {
                  memories = memories.map(m => ({ 
                    ...m, 
                    priority: opts.priority as "critical" | "high" | "normal"
                  }));
                }

                const result = await importMemories(memories, db, embeddings, {
                  dryRun: isDryRun,
                  dedupeThreshold: cfg.dedupeThreshold,
                });

                console.log("\n✅ Migration complete!");
                console.log(`  Imported: ${result.imported}`);
                console.log(`  Duplicates (merged): ${result.duplicates}`);
                console.log(`  Skipped (errors): ${result.skipped}`);

                if (isDryRun) {
                  console.log("\nRun without --dry-run to apply these imports.");
                }
              });
            } catch (err) {
              console.error(`\n❌ Migration failed: ${String(err)}`);
            }
          });

        slm.command("verify-migration")
          .description("Verify migrated content is in the database")
          .option("--source <path>", "Path to original MEMORY.md file or memory directory")
          .option("--threshold <n>", "Minimum coverage threshold (0.0-1.0)", "0.9")
          .action(async (opts: { source?: string; threshold?: string }) => {
            if (!opts.source) {
              console.error("Error: --source flag is required");
              return;
            }

            const sourcePath = path.resolve(opts.source);
            const thresholdValue = parseFloat(opts.threshold ?? "0.9");

            console.log(`\n🔍 Verifying migration from: ${sourcePath}`);
            console.log(`Coverage threshold: ${(thresholdValue * 100).toFixed(0)}%\n`);

            try {
              await withDbRetry(async () => {
                let memories;

                // Detect if source is a file or directory
                const stat = fs.statSync(sourcePath);
                if (stat.isFile()) {
                  if (sourcePath.endsWith("MEMORY.md") || path.basename(sourcePath) === "MEMORY.md") {
                    memories = parseMemoryMd(sourcePath);
                  } else {
                    memories = parseDailyFile(sourcePath);
                  }
                } else if (stat.isDirectory()) {
                  memories = parseDailyDirectory(sourcePath);
                } else {
                  throw new Error("Source must be a file or directory");
                }

                console.log(`Checking ${memories.length} memory items...\n`);

                const verification = await verifyMigration(memories, db, embeddings, thresholdValue);

                console.log("✅ Verification complete!");
                console.log(`  Total items: ${verification.total}`);
                console.log(`  Found in DB: ${verification.found}`);
                console.log(`  Missing: ${verification.missing}`);
                console.log(`  Coverage: ${(verification.coverage * 100).toFixed(1)}%`);

                if (verification.coverage >= thresholdValue) {
                  console.log(`\n✅ Migration verified! Coverage meets threshold.`);
                } else {
                  console.log(`\n❌ Migration incomplete. Coverage below ${(thresholdValue * 100).toFixed(0)}% threshold.`);
                  
                  if (verification.missingItems.length > 0) {
                    console.log(`\nMissing items (showing up to 5):`);
                    verification.missingItems.slice(0, 5).forEach((item, i) => {
                      console.log(`  ${i + 1}. ${item}`);
                    });
                  }
                }
              });
            } catch (err) {
              console.error(`\n❌ Verification failed: ${String(err)}`);
            }
          });
      },
      { commands: ["slm"] },
    );

    // ========================================================================
    // Slash Commands
    // ========================================================================

    api.on("slash_command", async (event) => {
      const cmd = event.command?.trim();
      if (!cmd) return;

      // /index-project <path>
      if (cmd.startsWith("/index-project")) {
        const dirPath = cmd.replace("/index-project", "").trim();
        if (!dirPath) {
          return { response: "Usage: /index-project <path>" };
        }
        try {
          const result = await withDbRetry(async () => indexDirectory(dirPath));
          return {
            response: `✅ Indexed project at ${dirPath}\n- Files scanned: ${result.files}\n- Chunks stored: ${result.chunks}`,
          };
        } catch (err) {
          return { response: `❌ Failed to index: ${String(err)}` };
        }
      }

      // /sync-status
      if (cmd === "/sync-status") {
        const peers = sync?.peerCount ?? 0;
        await ensureDbOpen();
        const last = await db.getLastSyncTime("__global__");
        const lastStr = last ? new Date(last).toLocaleString() : "never";
        const enabled = Boolean(cfg.syncEnabled && cfg.syncKey);

        return {
          response: [
            `🔁 **Sync Status**`,
            `Enabled: ${enabled}`,
            `Peer count: ${peers}`,
            `Last sync: ${lastStr}`,
            `Key: ${maskSyncKey(cfg.syncKey)}`,
          ].join("\n"),
        };
      }

      // /memory-stats
      if (cmd === "/memory-stats") {
        await ensureDbOpen();
        const stats = await db.stats();
        const profile = await db.getProfile();
        const lastCapture = stats.lastCaptureTime
          ? new Date(stats.lastCaptureTime).toLocaleString()
          : "never";

        const catLines = Object.entries(stats.categories)
          .sort(([, a], [, b]) => b - a)
          .map(([cat, count]) => `  ${cat}: ${count}`)
          .join("\n");

        // Top topics from profile
        const topTopics = profile?.summary?.match(/Top topics: (.+)/)?.[1] ?? "none";

        return {
          response: [
            `📊 **Memory Stats**`,
            `Total memories: ${stats.totalMemories}`,
            `Graph edges: ${stats.edgeCount}`,
            `Last capture: ${lastCapture}`,
            ``,
            `**By category:**`,
            catLines || "  (none)",
            ``,
            `**Profile:** ${profile?.summary?.split("\n")[0] ?? "Not built yet"}`,
            `**Top topics:** ${topTopics}`,
          ].join("\n"),
        };
      }
    });

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "superlocalmemory",
      start: async () => {
        ensureDbOpen();
        api.logger.info(`superlocalmemory: started (db: ${resolvedDbPath}, dim: ${cfg.embeddingDimension})`);

        // Start Hyperswarm sync (optional)
        if (cfg.syncEnabled && cfg.syncKey) {
          try {
            sync = new MemorySync(db, { key: cfg.syncKey, debug: cfg.debug });
            sync.on("sync:error", (err: unknown) => {
              api.logger.warn(`superlocalmemory: sync error: ${String(err)}`);
            });
            await sync.start();
          } catch (err) {
            api.logger.warn(`superlocalmemory: failed to start sync: ${String(err)}`);
            sync = null;
          }
        }

        // Index project context files on start if configured
        if (cfg.projectIndexOnStart && cfg.projectContextPaths.length > 0) {
          debug("indexing project context files on start...");
          for (const p of cfg.projectContextPaths) {
            try {
              const resolvedPath = api.resolvePath(p);
              const stat = fs.statSync(resolvedPath);
              if (stat.isDirectory()) {
                const result = await indexDirectory(p);
                debug(`indexed directory ${p}: ${result.files} files, ${result.chunks} chunks`);
              } else {
                const chunks = await indexProjectFile(p);
                debug(`indexed file ${p}: ${chunks} chunks`);
              }
            } catch (err) {
              api.logger.warn(`superlocalmemory: failed to index ${p}: ${String(err)}`);
            }
          }
        }
      },
      stop: async () => {
        try {
          void sync?.stop();
        } catch {
          // ignore
        } finally {
          sync = null;
        }
        await db.close();
        api.logger.info("superlocalmemory: stopped");
      },
    });
  },
};

export default superlocalmemory;
