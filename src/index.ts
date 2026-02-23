/**
 * Plures LM Plugin for OpenClaw
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
import { createBackend, createLazyBackend, getDefaultBackendType, type IMemoryBackend, type BackendType } from "./backend-factory.js";
import { parseMemoryMd, parseDailyFile, parseDailyDirectory, importMemories, verifyMigration } from "./migration.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  dbPath: string;
  /** Backend to use: 'pluresdb' (preferred) or 'better-sqlite3' (legacy). Auto-detected when omitted. */
  backend?: "better-sqlite3" | "pluresdb";
  embeddingProvider: "ollama";
  embeddingModel: string;
  /** Optional OpenAI API key (legacy, kept for config compat) */
  openaiApiKey?: string;
  embeddingDimension: number;
  ollamaModel: string;
  ollamaEndpoint: string;
  ollamaFallbackEndpoint: string;
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

  // Agent identity for multi-agent coordination
  /** Unique identifier for this agent instance (e.g. "desktop", "surface-laptop-uuid") */
  agentId: string;
  /** Human-readable name for this agent (e.g. "Desktop", "Surface") */
  agentName: string;

  // Session-start context injection
  sessionStartRecall: {
    enabled: boolean;
    maxMemories: number;
    priorityCategories: string[];
    recencyBias: number;
  };
}

const DEFAULTS: PluginConfig = {
  dbPath: "~/.openclaw/superlocalmemory.db",
  backend: undefined, // Auto-detect: prefer PluresDB, fall back to better-sqlite3
  embeddingProvider: "ollama",
  embeddingModel: "BAAI/bge-small-en-v1.5",
  openaiApiKey: undefined,
  embeddingDimension: 384,
  ollamaModel: "BAAI/bge-small-en-v1.5",
  ollamaEndpoint: "http://172.21.176.1:11434",
  ollamaFallbackEndpoint: "http://127.0.0.1:11435",
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

  agentId: "",
  agentName: "",

  sessionStartRecall: {
    enabled: true,
    maxMemories: 20,
    priorityCategories: ["decision", "preference", "explicit", "work-in-progress"],
    recencyBias: 0.7,
  },
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
// Compaction Context Detection
// ============================================================================

// Minimum line length for extracting important context from compaction summaries
const MIN_COMPACTION_LINE_LENGTH = 30;

// Maximum number of code patterns to extract from compaction summary
// Limits storage to most significant patterns to avoid bloating the database
const MAX_COMPACTION_PATTERNS = 5;

/**
 * Checks if a line contains important context that should be preserved during compaction.
 * Matches decision-making language, key terms, and explicit memory instructions.
 */
function containsImportantContext(line: string): boolean {
  return /decided|will use|going to|plan to|key|important|critical|remember|note|context/i.test(line);
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

const pluresLM = {
  id: "pluresLM",
  name: "Plures LM",
  description: "Local-first long-term memory with vector search, graph edges, and coding intelligence",
  kind: "extension" as const,
  configSchema,

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    
    // Create backend based on configuration
    const db: IMemoryBackend = cfg.backend
      ? createBackend({
          type: cfg.backend,
          dbPath: resolvedDbPath,
          vectorDimension: cfg.embeddingDimension,
          decayHalfLifeDays: cfg.decayHalfLifeDays,
        })
      : createLazyBackend(async () => {
          const detectedType = await getDefaultBackendType();
          api.logger.info(`pluresLM: auto-detected backend: ${detectedType}`);
          return createBackend({
            type: detectedType,
            dbPath: resolvedDbPath,
            vectorDimension: cfg.embeddingDimension,
            decayHalfLifeDays: cfg.decayHalfLifeDays,
          });
        });

    const embeddings = new DualEmbeddings(
      {
        ollamaEndpoint: cfg.ollamaEndpoint,
        ollamaModel: cfg.ollamaModel,
        ollamaFallbackEndpoint: cfg.ollamaFallbackEndpoint,
        dimension: cfg.embeddingDimension,
        debug: cfg.debug,
      },
      api.logger,
    );

    const debug = (msg: string) => cfg.debug && api.logger.info(`[pluresLM] ${msg}`);

    const DB_CLOSED_RE = /database connection is not open/i;

    const isDbClosedError = (err: unknown): boolean => {
      const msg = String(err);
      return DB_CLOSED_RE.test(msg) || msg.includes("SQLITE_MISUSE");
    };

    const ensureDbOpen = async (): Promise<void> => {
      if (await db.isOpen()) return;
      api.logger.warn("pluresLM: db handle was closed/stale; reopening...");
      await db.reopen();
    };

    const withDbRetry = async <T>(op: () => Promise<T>): Promise<T> => {
      await ensureDbOpen();
      try {
        return await op();
      } catch (err) {
        if (!isDbClosedError(err)) throw err;
        api.logger.warn(`pluresLM: db operation failed (${String(err)}); reopening and retrying once...`);
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

    // ========================================================================
    // Startup Self-Test
    // ========================================================================

    interface SelfTestCheck {
      name: string;
      passed: boolean;
      warning?: boolean;
      message: string;
    }

    /** Accumulated hard errors from the last self-test run (empty = all passed). */
    let selfTestErrors: string[] = [];

    async function runSelfTest(): Promise<SelfTestCheck[]> {
      const checks: SelfTestCheck[] = [];
      selfTestErrors = [];

      // Resolve the package root (dist/../ at runtime, src/../ during tsx)
      const pkgRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

      // ── 3. Kind + id assertion ────────────────────────────────────────────
      try {
        const manifestPath = path.join(pkgRoot, "openclaw.plugin.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { id: string; kind: string; version: string };
        if (pluresLM.id !== manifest.id || pluresLM.kind !== manifest.kind) {
          const msg = `Kind/id mismatch: code has id="${pluresLM.id}" kind="${pluresLM.kind}", manifest has id="${manifest.id}" kind="${manifest.kind}"`;
          checks.push({ name: "kind-assertion", passed: false, message: msg });
          selfTestErrors.push(msg);
        } else {
          checks.push({ name: "kind-assertion", passed: true, message: `id="${pluresLM.id}" kind="${pluresLM.kind}" match manifest` });
        }

        // ── 4. Version match ───────────────────────────────────────────────
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8")) as { version: string };
          if (pkg.version !== manifest.version) {
            const msg = `Version mismatch: package.json="${pkg.version}", openclaw.plugin.json="${manifest.version}"`;
            checks.push({ name: "version-match", passed: false, message: msg });
            selfTestErrors.push(msg);
          } else {
            checks.push({ name: "version-match", passed: true, message: `version="${pkg.version}" matches manifest` });
          }
        } catch (err) {
          const msg = `Could not read package.json: ${String(err)}`;
          checks.push({ name: "version-match", passed: false, message: msg });
          selfTestErrors.push(msg);
        }
      } catch (err) {
        const msg = `Could not read openclaw.plugin.json: ${String(err)}`;
        checks.push({ name: "kind-assertion", passed: false, message: msg });
        selfTestErrors.push(msg);
      }

      // ── 1. Embedding dimension check ──────────────────────────────────────
      try {
        const vec = await embeddings.embed("self-test");
        if (vec.length !== cfg.embeddingDimension) {
          const msg = `Embedding dimension mismatch: model returned ${vec.length} dims, config.embeddingDimension=${cfg.embeddingDimension}`;
          checks.push({ name: "embedding-dimension", passed: false, message: msg });
          selfTestErrors.push(msg);
        } else {
          checks.push({ name: "embedding-dimension", passed: true, message: `model returns ${vec.length} dims ✓` });
        }
      } catch (err) {
        const msg = `Embedding self-test failed: ${String(err)}`;
        checks.push({ name: "embedding-dimension", passed: false, message: msg });
        selfTestErrors.push(msg);
      }

      // ── 2. DB embedding dimension check ──────────────────────────────────
      try {
        const byteLen = await db.getEmbeddingByteLength();
        if (byteLen !== null) {
          // MemoryDB uses Float64Array (8 bytes/value)
          const bytesPerValue = 8;
          if (byteLen % bytesPerValue !== 0) {
            const msg = `DB corruption detected: embedding byte length (${byteLen} bytes) is not a multiple of ${bytesPerValue}. Expected embeddings stored as Float64Array (${bytesPerValue} bytes per value).`;
            checks.push({ name: "db-dimension", passed: false, message: msg });
            selfTestErrors.push(msg);
          } else {
            const expectedBytes = cfg.embeddingDimension * bytesPerValue;
            if (byteLen !== expectedBytes) {
              const actualDim = byteLen / bytesPerValue;
              const msg = `DB dimension mismatch: existing embeddings are ${actualDim}-dim (${byteLen} bytes), config expects ${cfg.embeddingDimension}-dim (${expectedBytes} bytes). Migration required.`;
              checks.push({ name: "db-dimension", passed: false, message: msg });
              selfTestErrors.push(msg);
            } else {
              checks.push({ name: "db-dimension", passed: true, message: `DB embeddings are ${cfg.embeddingDimension}-dim ✓` });
            }
          }
        } else {
          checks.push({ name: "db-dimension", passed: true, message: "No existing embeddings — no dimension check needed" });
        }
      } catch (err) {
        const msg = `DB integrity check failed: ${String(err)}`;
        checks.push({ name: "db-dimension", passed: false, message: msg });
        selfTestErrors.push(msg);
      }

      // ── 5. Dist freshness (warning only) ─────────────────────────────────
      try {
        const srcDir = path.join(pkgRoot, "src");
        const distDir = path.join(pkgRoot, "dist");
        if (fs.existsSync(srcDir) && fs.existsSync(distDir)) {
          const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
          const stale: string[] = [];
          for (const f of distFiles) {
            const tsFile = path.join(srcDir, f.replace(/\.js$/, ".ts"));
            const jsFile = path.join(distDir, f);
            if (fs.existsSync(tsFile)) {
              const tsMtime = fs.statSync(tsFile).mtimeMs;
              const jsMtime = fs.statSync(jsFile).mtimeMs;
              if (tsMtime > jsMtime) stale.push(f);
            }
          }
          if (stale.length > 0) {
            checks.push({ name: "dist-freshness", passed: true, warning: true, message: `Stale dist files (run \`npm run build\`): ${stale.join(", ")}` });
          } else {
            checks.push({ name: "dist-freshness", passed: true, message: "All dist files are up-to-date" });
          }
        }
      } catch {
        // Non-fatal: src/ may not be present in production installs
      }

      return checks;
    }

    api.logger.info(`pluresLM: initialized (db: ${resolvedDbPath}, backend: ${cfg.backend ?? "auto-detect"})`);
    try { fs.appendFileSync("/home/kbristol/.openclaw/slm-debug.log", `${new Date().toISOString()} register() called. autoRecall=${cfg.autoRecall} autoCapture=${cfg.autoCapture}\n`); } catch(e) {}

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
        name: "pluresLM_store",
        label: "Store Memory",
        description:
          "Store information in long-term memory. Use for facts, preferences, decisions, or anything the user wants remembered.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
          category: Type.Optional(
            Type.String({ description: "Category: preference, decision, entity, project, explicit, conversation, code-pattern, type-definition, module-composition, api-pattern, architecture-decision, error-fix, work-in-progress, project-context" }),
          ),
          destination: Type.Optional(Type.String({ description: "Target agent ID or scope for this memory (empty = all agents)" })),
          status: Type.Optional(Type.String({ description: "Task status: claimed, in-progress, completed, or abandoned" })),
          assigned_to: Type.Optional(Type.String({ description: "Agent ID responsible for this task" })),
          due_at: Type.Optional(Type.Number({ description: "Task deadline as Unix millisecond timestamp" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { text, tags, category, destination, status, assigned_to, due_at } = params as { text: string; tags?: string[]; category?: string; destination?: string; status?: string; assigned_to?: string; due_at?: number };
            const embedding = await embeddings.embed(text);
            const allTags = [...(tags ?? []), ...extractTags(text)];
            const cat = category ?? detectCategory(text);

            const result = await db.store(text, embedding, {
              tags: allTags, category: cat, dedupeThreshold: cfg.dedupeThreshold,
              originator_id: cfg.agentId || undefined,
              originator_name: cfg.agentName || undefined,
              destination,
              status,
              assigned_to,
              due_at,
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
      { name: "pluresLM_store" },
    );

    api.registerTool(
      {
        name: "pluresLM_search",
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
              .map((r, i) => {
                const attribution = r.entry.originator_name
                  ? ` [by: ${r.entry.originator_name}]`
                  : r.entry.originator_id
                  ? ` [by: ${r.entry.originator_id}]`
                  : "";
                const statusStr = r.entry.status ? ` [${r.entry.status}]` : "";
                return `${i + 1}. [${r.entry.category}]${attribution}${statusStr} ${r.entry.content} (${(r.score * 100).toFixed(0)}% match)`;
              })
              .join("\n");

            return { content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }] };
          });
        },
      },
      { name: "pluresLM_search" },
    );

    api.registerTool(
      {
        name: "pluresLM_task_update",
        label: "Update Task Status",
        description: "Update the status, assignment, or deadline of a task memory. Use to claim tasks, mark progress, or record completion.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "Memory ID of the task to update" }),
          status: Type.Optional(Type.String({ description: "New status: claimed, in-progress, completed, or abandoned" })),
          assigned_to: Type.Optional(Type.String({ description: "Agent ID to assign this task to (defaults to current agent when claiming)" })),
          due_at: Type.Optional(Type.Number({ description: "Task deadline as Unix millisecond timestamp" })),
          last_checkin: Type.Optional(Type.Number({ description: "Check-in timestamp (defaults to now when status is set)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { memoryId, status, assigned_to, due_at, last_checkin } = params as { memoryId: string; status?: string; assigned_to?: string; due_at?: number; last_checkin?: number };

            if (!memoryId) {
              return { content: [{ type: "text", text: "Provide a memoryId." }] };
            }

            const validStatuses = new Set(["claimed", "in-progress", "completed", "abandoned", ""]);
            if (status !== undefined && !validStatuses.has(status)) {
              return { content: [{ type: "text", text: `Invalid status "${status}". Valid values: claimed, in-progress, completed, abandoned` }] };
            }

            // When claiming/starting a task, auto-assign to current agent if not specified
            let effectiveAssignee: string | undefined;
            if (assigned_to !== undefined) {
              effectiveAssignee = assigned_to;
            } else if (status === "claimed" || status === "in-progress") {
              effectiveAssignee = cfg.agentId || undefined;
            }
            // Update last_checkin to now when status changes
            const effectiveCheckin = last_checkin ?? (status ? Date.now() : undefined);

            const opts: Parameters<typeof db.updateAttribution>[1] = {};
            if (status !== undefined) opts.status = status;
            if (effectiveAssignee !== undefined) opts.assigned_to = effectiveAssignee;
            if (due_at !== undefined) opts.due_at = due_at;
            if (effectiveCheckin !== undefined) opts.last_checkin = effectiveCheckin;

            if (Object.keys(opts).length === 0) {
              return { content: [{ type: "text", text: "No fields to update. Provide at least one of: status, assigned_to, due_at, last_checkin." }] };
            }

            const updated = await db.updateAttribution(memoryId, opts);
            if (!updated) {
              return { content: [{ type: "text", text: `Memory ${memoryId.slice(0, 8)} not found.` }] };
            }

            const updates: string[] = [];
            if (status !== undefined) updates.push(`status → ${status || "(cleared)"}`);
            if (effectiveAssignee !== undefined) updates.push(`assigned_to → ${effectiveAssignee || "(cleared)"}`);
            if (due_at !== undefined) updates.push(`due_at → ${new Date(due_at).toISOString()}`);
            if (effectiveCheckin !== undefined) updates.push(`last_checkin → now`);

            return { content: [{ type: "text", text: `Updated task ${memoryId.slice(0, 8)}: ${updates.join(", ")}` }] };
          });
        },
      },
      { name: "pluresLM_task_update" },
    );

    api.registerTool(
      {
        name: "pluresLM_forget",
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
      { name: "pluresLM_forget" },
    );

    api.registerTool(
      {
        name: "pluresLM_profile",
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
      { name: "pluresLM_profile" },
    );

    api.registerTool(
      {
        name: "pluresLM_index",
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
      { name: "pluresLM_index" },
    );

    api.registerTool(
      {
        name: "pluresLM_sync_keygen",
        label: "Generate Sync Key",
        description: "Generate a new 32-byte (64 hex char) Hyperswarm sync key for P2P memory sync.",
        parameters: Type.Object({}),
        async execute() {
          const key = MemorySync.generateKey();
          return { content: [{ type: "text", text: key }] };
        },
      },
      { name: "pluresLM_sync_keygen" },
    );

    api.registerTool(
      {
        name: "pluresLM_sync_status",
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
      { name: "pluresLM_sync_status" },
    );

    api.registerTool(
      {
        name: "pluresLM_status",
        label: "Plugin Status & Self-Test",
        description: "Run a full diagnostic self-test: verify embedding dimensions, DB integrity, kind/version match, and dist freshness.",
        parameters: Type.Object({}),
        async execute() {
          const checks = await runSelfTest();
          const lines: string[] = ["## pluresLM Self-Test", ""];
          for (const c of checks) {
            const icon = !c.passed ? "❌" : c.warning ? "⚠️" : "✅";
            lines.push(`${icon} **${c.name}**: ${c.message}`);
          }
          lines.push("");
          if (selfTestErrors.length > 0) {
            lines.push(`**STATUS: ${selfTestErrors.length} error(s) — auto-recall and auto-capture are DISABLED**`);
            lines.push("");
            lines.push("Errors:");
            for (const e of selfTestErrors) lines.push(`- ${e}`);
          } else {
            lines.push("**STATUS: All checks passed ✅**");
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        },
      },
      { name: "pluresLM_status" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_consolidate",
        label: "Consolidate Memories",
        description: "Run memory consolidation: merge duplicates, demote stale memories, promote reinforced facts.",
        parameters: Type.Object({
          dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without applying them (default: true)" })),
          stalenessDays: Type.Optional(Type.Number({ description: "Days threshold for staleness detection (default: 30)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { dryRun = true, stalenessDays = 30 } = params as { dryRun?: boolean; stalenessDays?: number };
            
            // Type-check that db is MemoryDB (consolidation not available on PluresDB yet)
            if (!('runConsolidation' in db)) {
              return {
                content: [{ type: "text", text: "Consolidation is only available with better-sqlite3 backend" }],
              };
            }
            
            const stats = await (db as any).runConsolidation({ dryRun, stalenessDays });
            
            const lines = [
              dryRun ? "# Consolidation Preview (Dry Run)" : "# Consolidation Complete",
              ``,
              `Duplicates ${dryRun ? "would be" : ""} merged: ${stats.duplicatesMerged}`,
              `Memories ${dryRun ? "would be" : ""} demoted: ${stats.memoriesDemoted}`,
              `Memories ${dryRun ? "would be" : ""} promoted: ${stats.memoriesPromoted}`,
              ``,
              dryRun ? "Run with dryRun=false to apply changes." : "Changes applied successfully.",
            ];
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          });
        },
      },
      { name: "superlocalmemory_consolidate" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_world_state",
        label: "Generate World State",
        description: "Generate a summary of high-priority memories (state of the world).",
        parameters: Type.Object({}),
        async execute() {
          return await withDbRetry(async () => {
            // Type-check that db is MemoryDB
            if (!('generateWorldState' in db)) {
              return {
                content: [{ type: "text", text: "World state generation is only available with better-sqlite3 backend" }],
              };
            }
            
            const summary = await (db as any).generateWorldState();
            return { content: [{ type: "text", text: summary }] };
          });
        },
      },
      { name: "superlocalmemory_world_state" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_find_stale",
        label: "Find Stale Memories",
        description: "Find memories that haven't been accessed in a specified number of days.",
        parameters: Type.Object({
          days: Type.Optional(Type.Number({ description: "Days threshold (default: 30)" })),
          limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { days = 30, limit = 10 } = params as { days?: number; limit?: number };
            
            // Type-check that db is MemoryDB
            if (!('findStaleMemories' in db)) {
              return {
                content: [{ type: "text", text: "Stale memory detection is only available with better-sqlite3 backend" }],
              };
            }
            
            const staleMemories = await (db as any).findStaleMemories(days);
            const topStale = staleMemories.slice(0, limit);
            
            if (topStale.length === 0) {
              return { content: [{ type: "text", text: `No stale memories found (threshold: ${days} days)` }] };
            }
            
            const lines = [
              `# Stale Memories (not accessed in ${days}+ days)`,
              ``,
              `Found ${staleMemories.length} stale memories, showing top ${topStale.length}:`,
              ``,
            ];
            
            for (const mem of topStale) {
              lines.push(`- [${mem.priority}] ${mem.content.slice(0, 80)}... (${mem.daysSinceAccess} days)`);
            }
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          });
        },
      },
      { name: "superlocalmemory_find_stale" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_generate_daily_summary",
        label: "Generate Daily Summary",
        description: "Generate a structured summary of all memories captured on a specific date. The summary is stored as a memory with category 'daily-summary'.",
        parameters: Type.Object({
          date: Type.String({ description: "Date in YYYY-MM-DD format (e.g., 2024-01-15)" }),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { date } = params as { date: string };
            
            // Validate date format
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              return {
                content: [{ type: "text", text: "Invalid date format. Please use YYYY-MM-DD format (e.g., 2024-01-15)." }],
              };
            }

            // Validate that the date string represents a real calendar date
            const parsed = new Date(`${date}T00:00:00.000Z`);
            if (Number.isNaN(parsed.getTime())) {
              return {
                content: [{ type: "text", text: "Invalid date value. Please provide a real calendar date in YYYY-MM-DD format (e.g., 2024-01-15)." }],
              };
            }
            const [yearStr, monthStr, dayStr] = date.split("-");
            const year = Number(yearStr);
            const month = Number(monthStr);
            const day = Number(dayStr);
            if (
              parsed.getUTCFullYear() !== year ||
              parsed.getUTCMonth() + 1 !== month ||
              parsed.getUTCDate() !== day
            ) {
              return {
                content: [{ type: "text", text: "Invalid date value. Please provide a real calendar date in YYYY-MM-DD format (e.g., 2024-01-15)." }],
              };
            }
            const summary = await db.generateDailySummary(date);
            
            if (summary.memoryCount === 0) {
              return {
                content: [{ type: "text", text: `No memories found for ${date}.` }],
              };
            }

            const categoryList = Object.entries(summary.categories)
              .map(([cat, count]) => `${cat}: ${count}`)
              .join(", ");

            return {
              content: [{
                type: "text",
                text: `Generated daily summary for ${date}:\n\n${summary.memoryCount} memories across ${Object.keys(summary.categories).length} categories (${categoryList}).\n\nSummary stored as memory with tag 'daily-summary:${date}'.`,
              }],
            };
          });
        },
      },
      { name: "superlocalmemory_generate_daily_summary" },
    );

    api.registerTool(
      {
        name: "superlocalmemory_get_daily_summaries",
        label: "Get Daily Summaries",
        description: "Retrieve daily summaries for the last N days. Returns structured summaries of memories grouped by category.",
        parameters: Type.Object({
          days: Type.Optional(Type.Number({ description: "Number of days to look back (default: 7)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { days } = params as { days?: number };
            const lookbackDays = days ?? 7;

            const summaries = await db.getDailySummaries(lookbackDays);

            if (summaries.length === 0) {
              return {
                content: [{ type: "text", text: `No daily summaries found in the last ${lookbackDays} days.` }],
              };
            }

            const lines = [`Found ${summaries.length} daily summaries:\n`];
            
            for (const summary of summaries) {
              const categoryList = Object.entries(summary.categories)
                .map(([cat, count]) => `${cat}: ${count}`)
                .join(", ");
              
              lines.push(`### ${summary.date}`);
              lines.push(`- Memories: ${summary.memoryCount}`);
              lines.push(`- Categories: ${categoryList}`);
              lines.push('');
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
            };
          });
        },
      },
      { name: "superlocalmemory_get_daily_summaries" },
    );

    // ========================================================================
    // Lifecycle Hooks — Auto-Recall (with WIP boosting)
    // ========================================================================

    // Log hook registration diagnostic
    fs.appendFileSync("/home/kbristol/.openclaw/slm-debug.log", `${new Date().toISOString()} about to register hooks. autoRecall=${cfg.autoRecall} autoCapture=${cfg.autoCapture}\n`);

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        // Disable auto-recall if self-test found hard errors
        if (selfTestErrors.length > 0) {
          // Surface diagnostic on first interaction
          if (turnCounter === 0) {
            turnCounter++;
            return {
              prependContext: `⚠️ **pluresLM self-test FAILED — auto-recall/auto-capture disabled**\n\nErrors:\n${selfTestErrors.map((e) => `- ${e}`).join("\n")}\n\nRun \`pluresLM_status\` for full diagnostics.`,
            };
          }
          return;
        }

        const ts = new Date().toISOString();
        fs.appendFileSync("/home/kbristol/.openclaw/slm-debug.log", `${ts} before_agent_start fired: prompt=${(event.prompt ?? "").slice(0, 50)}\n`);
        
        // Session-start context injection (fires on first turn or when no prompt)
        if (cfg.sessionStartRecall.enabled && turnCounter === 0) {
          try {
            return await withDbRetry(async () => {
              const parts: string[] = [];

              // Always include profile at session start
              const profile = await db.getProfile();
              if (profile?.summary) {
                parts.push(`<user-profile>\n${profile.summary}\n</user-profile>`);
              }

              // Retrieve priority memories by category
              const priorityMemories = await db.getMemoriesByCategories(
                cfg.sessionStartRecall.priorityCategories,
                cfg.sessionStartRecall.maxMemories,
                cfg.sessionStartRecall.recencyBias
              );

              if (priorityMemories.length > 0) {
                const memoryLines = priorityMemories
                  .map((m) => {
                    const attribution = m.originator_name
                      ? ` [by: ${m.originator_name}]`
                      : m.originator_id
                      ? ` [by: ${m.originator_id}]`
                      : "";
                    const statusStr = m.status ? ` [${m.status}]` : "";
                    return `- [${m.category}]${attribution}${statusStr} ${m.content}`;
                  })
                  .join("\n");
                parts.push(`<session-context>\n${memoryLines}\n</session-context>`);
              }

              turnCounter++;

              if (parts.length === 0) return;

              debug(`session-start: injecting profile and ${priorityMemories.length} priority memories`);

              return { prependContext: parts.join("\n\n") };
            });
          } catch (err) {
            api.logger.warn(`pluresLM: session-start injection failed: ${String(err)}`);
          }
        }

        // Regular auto-recall on subsequent turns
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
                .map((r) => {
                  const attribution = r.entry.originator_name
                    ? ` [by: ${r.entry.originator_name}]`
                    : r.entry.originator_id
                    ? ` [by: ${r.entry.originator_id}]`
                    : "";
                  const statusStr = r.entry.status ? ` [${r.entry.status}]` : "";
                  return `- [${r.entry.category}]${attribution}${statusStr} ${r.entry.content}`;
                })
                .join("\n");
              parts.push(`<relevant-memories>\n${memoryLines}\n</relevant-memories>`);
            }

            if (parts.length === 0) return;

            debug(`injecting ${results.length} memories into context`);

            return { prependContext: parts.join("\n\n") };
          });
        } catch (err) {
          api.logger.warn(`pluresLM: recall failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Lifecycle Hooks — Auto-Capture (enhanced with code intelligence)
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        // Disable auto-capture if self-test found hard errors
        if (selfTestErrors.length > 0) return;

        const ts = new Date().toISOString();
        fs.appendFileSync("/home/kbristol/.openclaw/slm-debug.log", `${ts} agent_end fired: success=${event.success} msgs=${event.messages?.length ?? 0}\n`);
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

          // Attribution opts for all auto-captured memories
          const captureAttribution = {
            originator_id: cfg.agentId || undefined,
            originator_name: cfg.agentName || undefined,
          };

          // --- Original conversation capture ---
          for (const text of capturable.slice(0, 3)) {
            const embedding = await embeddings.embed(text);
            const cat = detectCategory(text);
            const result = await db.store(text, embedding, {
              source: "auto-capture",
              tags: extractTags(text),
              category: cat,
              dedupeThreshold: cfg.dedupeThreshold,
              ...captureAttribution,
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
              ...captureAttribution,
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
              ...captureAttribution,
            });

            const fixEmbedding = await embeddings.embed(pair.fix);
            const fixResult = await db.store(pair.fix, fixEmbedding, {
              source: "auto-capture:fix",
              tags: [...pair.errorTags, "type:fix"],
              category: "error-fix",
              dedupeThreshold: cfg.dedupeThreshold,
              ...captureAttribution,
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
                ...captureAttribution,
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
          api.logger.warn(`pluresLM: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Lifecycle Hooks — Before Compaction (snapshot critical context)
    // ========================================================================

    api.on("before_compaction", async (event) => {
      // Extract compaction context from event
      // Type-safe access to event properties
      const compactionEvent = event as { summary?: string; sessionKey?: string; messageCount?: number };
      const summary = compactionEvent.summary;
      const sessionKey = compactionEvent.sessionKey;
      const messageCount = compactionEvent.messageCount;

      if (!summary || typeof summary !== "string" || summary.length < 20) {
        debug("skipping compaction capture: no summary or too short");
        return;
      }

      try {
        await withDbRetry(async () => {
          const timestamp = new Date().toISOString();
          const compactionMetadata = [
            sessionKey ? `Session: ${sessionKey}` : null,
            messageCount ? `Messages: ${messageCount}` : null,
            `Timestamp: ${timestamp}`,
          ].filter(Boolean).join(" | ");

          debug(`capturing compaction snapshot: ${messageCount ?? 'unknown'} messages compacted`);

          // Attribution opts for all compaction-captured memories
          const compactionAttribution = {
            originator_id: cfg.agentId || undefined,
            originator_name: cfg.agentName || undefined,
          };

          // Store the full compaction summary as a memory
          const summaryContent = `${compactionMetadata}\n\n${summary}`;
          const summaryEmbedding = await embeddings.embed(summaryContent);
          
          const summaryResult = await db.store(summaryContent, summaryEmbedding, {
            source: "compaction-snapshot",
            tags: ["compaction", "snapshot", `timestamp:${timestamp}`, ...(sessionKey ? [`session:${sessionKey}`] : [])],
            category: "compaction-snapshot",
            dedupeThreshold: cfg.dedupeThreshold,
            ...compactionAttribution,
          });

          let stored = summaryResult.isDuplicate ? 0 : 1;

          // Extract key facts, decisions, and patterns from the summary
          // Patterns are ordered by appearance; we take the first MAX_COMPACTION_PATTERNS
          // as they typically represent the most significant architectural decisions
          const extractedPatterns = extractCodePatterns(summary);
          for (const pattern of extractedPatterns.slice(0, MAX_COMPACTION_PATTERNS)) {
            const embedding = await embeddings.embed(pattern.content);
            const result = await db.store(pattern.content, embedding, {
              source: "compaction-snapshot:code",
              tags: [...pattern.tags, "compaction", `timestamp:${timestamp}`],
              category: "compaction-snapshot",
              dedupeThreshold: cfg.dedupeThreshold,
              ...compactionAttribution,
            });
            if (!result.isDuplicate) stored++;
          }

          // Extract decisions and important context
          const lines = summary.split("\n");
          for (const line of lines) {
            if (line.length < MIN_COMPACTION_LINE_LENGTH) continue;
            
            if (containsImportantContext(line)) {
              const embedding = await embeddings.embed(line);
              const result = await db.store(line, embedding, {
                source: "compaction-snapshot:decision",
                tags: ["compaction", "decision", `timestamp:${timestamp}`, ...extractTags(line)],
                category: "compaction-snapshot",
                dedupeThreshold: cfg.dedupeThreshold,
                ...compactionAttribution,
              });
              if (!result.isDuplicate) stored++;
            }
          }

          // Extract WIP items from summary
          for (const line of lines) {
            if (line.length < MIN_COMPACTION_LINE_LENGTH) continue;
            if (isWorkInProgress(line)) {
              const embedding = await embeddings.embed(line);
              const result = await db.store(line, embedding, {
                source: "compaction-snapshot:wip",
                tags: ["compaction", "wip", `timestamp:${timestamp}`, ...extractTags(line)],
                category: "compaction-snapshot",
                dedupeThreshold: cfg.dedupeThreshold,
                ...compactionAttribution,
              });
              if (!result.isDuplicate) stored++;
            }
          }

          if (stored > 0) {
            const newCount = await db.incrementCaptureCount();
            debug(`compaction snapshot: stored ${stored} memories (total captures: ${newCount})`);

            // Trigger profile rebuild if needed
            if (newCount > 0 && newCount % cfg.profileFrequency === 0) {
              debug("triggering profile rebuild after compaction...");
              void rebuildProfile();
            }
          }
        });
      } catch (err) {
        api.logger.warn(`superlocalmemory: compaction capture failed: ${String(err)}`);
      }
    });

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
        api.logger.warn(`pluresLM: profile rebuild failed: ${String(err)}`);
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

        slm.command("consolidate")
          .description("Run memory consolidation (merge duplicates, demote stale, promote reinforced)")
          .option("--apply", "Apply changes (default is dry run)", false)
          .option("--staleness-days <n>", "Days threshold for staleness detection", "30")
          .action(async (opts: { apply: boolean; stalenessDays: string }) => {
            await ensureDbOpen();
            
            // Type-check that db is MemoryDB
            if (!('runConsolidation' in db)) {
              console.log("Consolidation is only available with better-sqlite3 backend");
              return;
            }
            
            const dryRun = !opts.apply;
            const stalenessDays = parseInt(opts.stalenessDays);
            
            console.log(`\n🔄 Running memory consolidation ${dryRun ? "(DRY RUN)" : "(APPLYING CHANGES)"}...\n`);
            
            const stats = await (db as any).runConsolidation({ dryRun, stalenessDays });
            
            console.log("Results:");
            console.log(`  Duplicates ${dryRun ? "would be" : ""} merged: ${stats.duplicatesMerged}`);
            console.log(`  Memories ${dryRun ? "would be" : ""} demoted: ${stats.memoriesDemoted}`);
            console.log(`  Memories ${dryRun ? "would be" : ""} promoted: ${stats.memoriesPromoted}`);
            console.log();
            
            if (dryRun) {
              console.log("Run with --apply to apply these changes.");
            } else {
              console.log("✅ Changes applied successfully.");
            }
          });

        slm.command("world-state")
          .description("Generate a summary of high-priority memories")
          .action(async () => {
            await ensureDbOpen();
            
            // Type-check that db is MemoryDB
            if (!('generateWorldState' in db)) {
              console.log("World state generation is only available with better-sqlite3 backend");
              return;
            }
            
            const summary = await (db as any).generateWorldState();
            console.log(summary);
          });

        slm.command("find-stale")
          .description("Find memories that haven't been accessed recently")
          .option("--days <n>", "Days threshold", "30")
          .option("--limit <n>", "Maximum results", "20")
          .action(async (opts: { days: string; limit: string }) => {
            await ensureDbOpen();
            
            // Type-check that db is MemoryDB
            if (!('findStaleMemories' in db)) {
              console.log("Stale memory detection is only available with better-sqlite3 backend");
              return;
            }
            
            const days = parseInt(opts.days);
            const limit = parseInt(opts.limit);
            
            const staleMemories = await (db as any).findStaleMemories(days);
            const topStale = staleMemories.slice(0, limit);
            
            console.log(`\n🕰️  Stale Memories (not accessed in ${days}+ days)\n`);
            
            if (topStale.length === 0) {
              console.log("No stale memories found!");
              return;
            }
            
            console.log(`Found ${staleMemories.length} stale memories, showing top ${topStale.length}:\n`);
            
            for (const mem of topStale) {
              console.log(`[${mem.priority.toUpperCase()}] ${mem.content.slice(0, 80)}...`);
              console.log(`  Category: ${mem.category}, Stale: ${mem.daysSinceAccess} days\n`);
            }
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
          console.log(`  Provider: Ollama (query-side embedding)`);
          console.log(`  Model: ${cfg.ollamaModel}`);
          const primaryLatency = await testOllamaEndpoint(cfg.ollamaEndpoint, cfg.ollamaModel);
          const primaryStatus = primaryLatency !== null ? `✅ ${cfg.ollamaEndpoint} (${primaryLatency}ms)` : `❌ ${cfg.ollamaEndpoint} (unreachable)`;
          console.log(`  Endpoint: ${primaryStatus}`);
          console.log(`  Note: Storage-side embedding handled by PluresDB (BAAI/bge-small-en-v1.5 via fastembed)`);

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
                if (opts.priority) {
                  const validPriorities = new Set<"critical" | "high" | "normal">([
                    "critical",
                    "high",
                    "normal",
                  ]);

                  if (!validPriorities.has(opts.priority as any)) {
                    throw new Error(
                      `Invalid priority "${opts.priority}". Valid priorities are: critical, high, normal.`
                    );
                  }

                  if (opts.priority !== "critical") {
                    memories = memories.map(m => ({
                      ...m,
                      priority: opts.priority as "critical" | "high" | "normal",
                    }));
                  }
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

    // Post-hook-registration diagnostic
    fs.appendFileSync("/home/kbristol/.openclaw/slm-debug.log",
      `${new Date().toISOString()} all hooks registered via api.on(). autoRecall=${cfg.autoRecall} autoCapture=${cfg.autoCapture}. If hooks never fire, the issue is in OpenClaw's hook runner, not our plugin.\n`);

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
      id: "pluresLM",
      start: async () => {
        await ensureDbOpen();
        api.logger.info(`pluresLM: started (db: ${resolvedDbPath}, dim: ${cfg.embeddingDimension})`);

        // Run startup self-test on every load
        try {
          const checks = await runSelfTest();
          if (selfTestErrors.length > 0) {
            for (const e of selfTestErrors) {
              api.logger.warn(`pluresLM self-test FAILED: ${e}`);
            }
            api.logger.warn(`pluresLM: ${selfTestErrors.length} self-test error(s) — auto-recall and auto-capture are DISABLED. Run pluresLM_status for full diagnostics.`);
          } else {
            const warnings = checks.filter((c) => c.warning);
            if (warnings.length > 0) {
              for (const w of warnings) api.logger.warn(`pluresLM self-test warning: ${w.message}`);
            }
            debug("self-test passed");
          }
        } catch (err) {
          api.logger.warn(`pluresLM: self-test threw unexpectedly: ${String(err)}`);
        }

        // Start Hyperswarm sync (optional)
        if (cfg.syncEnabled && cfg.syncKey) {
          try {
            sync = new MemorySync(db, { key: cfg.syncKey, debug: cfg.debug });
            sync.on("sync:error", (err: unknown) => {
              api.logger.warn(`pluresLM: sync error: ${String(err)}`);
            });
            await sync.start();
          } catch (err) {
            api.logger.warn(`pluresLM: failed to start sync: ${String(err)}`);
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
              api.logger.warn(`pluresLM: failed to index ${p}: ${String(err)}`);
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
        api.logger.info("pluresLM: stopped");
      },
    });
  },
};

export default pluresLM;
