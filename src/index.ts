/**
 * Plures LM Plugin for OpenClaw
 *
 * Local-first long-term memory powered by PluresDB (native Rust CRDT store
 * with HNSW vector search and fastembed embeddings via NAPI).
 *
 * Enhanced with coding intelligence:
 * - Auto-capture code patterns, type definitions, architecture decisions
 * - Project context indexing
 * - Error→fix pair memory with graph edges
 * - Cross-session WIP continuity
 * - Codebase indexing commands
 */

import { Type } from "@sinclair/typebox";
import { DualEmbeddings } from "./embeddings.js";
import { MemorySync } from "./sync.js";
import { PluresDBBackend, type InsightData } from "./pluresdb-backend.js";
import { parseMemoryMd, parseDailyFile, parseDailyDirectory, importMemories, verifyMigration } from "./migration.js";
import { PatternEngine, type PatternMatch } from "./patterns.js";
import { MemoryMdGenerator } from "./memory-md-generator.js";
import { ContextManager } from "./context-manager.js";
import { OpenClawCompatibilityDetector, type OperatingMode, type CompatibilityConfig } from "./compatibility.js";
import { CompatibilityLayer } from "./compatibility-layer.js";
import { DatabaseRetryClient, GatewayIpcClient, createGatewayClientOrFallback } from "./gateway-api-client.js";
import { GatewayIpcHandler } from "./gateway-ipc-handler.js";
import { shouldCapture, DEFAULT_CAPTURE_QUALITY_CONFIG, type CaptureQualityConfig } from "./capture-quality.js";
import { DocumentProcessor } from "./document-processor.js";
import type { DocumentMetadata, DocumentSource, TrainingFormat, TrainingStats, MemoryOutcome } from "./types.js";
export type { DocumentMetadata, DocumentSource, TrainingFormat, TrainingStats, SftRecord, DpoRecord, RlhfRecord } from "./types.js";
import {
  extractClassifierSignals,
  signalsToJsonl,
  CLASSIFIER_SIGNAL_SCHEMA_VERSION,
  type ClassifierSignal,
  type ClassifierFeatures,
  type ClassifierLabel,
  type SignalQuality,
  type SignalQualityOptions,
  type ClassifierExportOptions,
} from "./classifier-signal.js";
export type {
  ClassifierSignal,
  ClassifierFeatures,
  ClassifierLabel,
  SignalQuality,
  SignalQualityOptions,
  ClassifierExportOptions,
} from "./classifier-signal.js";
export { CLASSIFIER_SIGNAL_SCHEMA_VERSION } from "./classifier-signal.js";
import { generateEvalReport, type ClassifierEvalReport, type ClassMetrics, type QualityStats, type DriftResult, type ClassBreakdown } from "./classifier-eval.js";
export type { ClassifierEvalReport, ClassMetrics, QualityStats, DriftResult, ClassBreakdown } from "./classifier-eval.js";
import { ingestState } from "./ingest-state.js";
import { DEFAULT_ARCHIVE_POLICY, type ArchivePolicy, type ArchiveBundle, type ClassifyResult, type RestoreResult } from "./memory-archive.js";
export type { MemoryTier, ArchivePolicy, ArchiveBundle, BundleEntry, BundleManifest, RestoreResult, ClassifyResult } from "./memory-archive.js";
import { _archive } from "./archive-state.js";
import {
  signPack,
  verifyPackSignature,
  checkPackCompatibility,
  type MemoryPack,
  type PackProvenance,
  type PackEmbeddingMeta,
  type PackImportResult,
  type InstalledPackInfo,
} from "./memory-pack.js";
export type { MemoryPack, PackProvenance, PackEmbeddingMeta, PackImportResult, InstalledPackInfo } from "./memory-pack.js";
import { _packRegistry } from "./pack-state.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fork } from "node:child_process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Simple gateway detection - no retry, no fallback
function isGatewayRunning(): boolean {
  try {
    const result = execSync('pgrep -f "openclaw-gateway"', { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  dbPath: string;
  /** Override base directory for all PluresLM databases (default: ~/.pluresLM) */
  dbBaseDir?: string;
  /** Operating mode: auto-detect, enhanced, or compatible */
  operatingMode: "auto" | "enhanced" | "compatible";
  /** Compatibility configuration for vanilla OpenClaw support */
  compatibility: CompatibilityConfig;
  embeddingProvider: "pluresdb" | "ollama" | "transformers";
  embeddingModel: string;
  transformersModel: string;
  /** Optional OpenAI API key (legacy, unused with Transformers.js) */
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

  /** Forked project indexer settings (to prevent gateway unresponsiveness). */
  projectIndexBatchSize: number;
  /** Max disk read operations per second in the indexer worker. */
  projectIndexReadOpsPerSecond: number;
  /** Skip files larger than this many bytes (IPC + chunking protection). */
  projectIndexMaxFileBytes: number;
  /** Retry transient fs errors up to N times (worker side). */
  projectIndexRetries: number;

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

  // YAML-extensible operational memory patterns
  /** Additional directories to scan for user .yml pattern files. */
  patternsDirs: string[];
  /** Whether to hot-reload pattern YAML files when they change. */
  patternsWatch: boolean;

  // Auto-recall filtering
  /** Categories excluded from auto-recall injection (still stored, just not injected). */
  recallExcludeCategories: string[];

  // Graph / auto-linking
  /** Automatically trigger relationship discovery when a memory is stored. */
  autoLinkOnStore: boolean;
  /** Algorithms to use for auto-linking (e.g. "semantic", "category", "temporal"). */
  autoLinkAlgorithms: string[];
  /** Per-algorithm strength thresholds for auto-linking (0.0–1.0). */
  autoLinkThresholds: Record<string, number>;
  /** Maximum traversal depth for graph_neighbors queries. */
  maxAutoLinkDepth: number;

  /** Capture quality gate configuration. */
  captureQuality: CaptureQualityConfig;
}

const DEFAULTS: PluginConfig = {
  dbPath: "~/.openclaw/pluresLM.db",
  dbBaseDir: undefined, // Use smart default: ~/.pluresLM/{processName}
  operatingMode: "auto", // Auto-detect best mode
  compatibility: {
    operatingMode: "auto",
  },
  embeddingProvider: "pluresdb",
  embeddingModel: "BAAI/bge-small-en-v1.5",
  transformersModel: "Xenova/bge-small-en-v1.5",
  openaiApiKey: undefined,
  embeddingDimension: 384,
  ollamaModel: "snowflake-arctic-embed2",
  ollamaEndpoint: "http://172.21.176.1:11434",
  ollamaFallbackEndpoint: "http://127.0.0.1:11435",
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  profileFrequency: 50,
  dedupeThreshold: 0.85,
  decayHalfLifeDays: 30,
  debug: false,
  projectContextPaths: [],
  projectIndexOnStart: false,
  projectIndexGlobs: ["**/README.md", "**/src/types/**/*.ts", "**/docs/architecture.md"],

  // Forked indexing defaults: conservative to keep gateway responsive.
  projectIndexBatchSize: 5,
  projectIndexReadOpsPerSecond: 15,
  projectIndexMaxFileBytes: 1_000_000, // 1MB
  projectIndexRetries: 3,

  syncEnabled: false,
  syncKey: "",

  agentId: "",
  agentName: "",

  sessionStartRecall: {
    enabled: true,
    maxMemories: 15,
    priorityCategories: ["decision", "preference", "explicit", "work-in-progress"],
    recencyBias: 0.7,
  },

  recallExcludeCategories: ["project-context"],

  patternsDirs: [],
  patternsWatch: true,

  autoLinkOnStore: false,
  autoLinkAlgorithms: ["semantic", "category"],
  autoLinkThresholds: { semantic: 0.7, category: 0.6, temporal: 0.5 },
  maxAutoLinkDepth: 2,

  captureQuality: DEFAULT_CAPTURE_QUALITY_CONFIG,
};

const configSchema = {
  parse(value: unknown): PluginConfig {
    const c = (value ?? {}) as Partial<PluginConfig>;
    const config = { ...DEFAULTS, ...c };
    
    // Validate dbBaseDir if provided
    if (config.dbBaseDir !== undefined) {
      if (typeof config.dbBaseDir !== "string" || config.dbBaseDir.trim() === "") {
        throw new Error("pluresLM: dbBaseDir must be a non-empty string");
      }
      
      // Warn about potentially problematic paths
      const normalized = config.dbBaseDir.toLowerCase();
      if (normalized.includes("tmp") && !normalized.includes("openclaw")) {
        console.warn("[pluresLM] Warning: dbBaseDir contains 'tmp' - databases may be lost on reboot");
      }
    }
    
    return config;
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
  // Stricter patterns: require sentence-start or strong signal words to avoid
  // false positives (e.g. "I want to" in a technical explanation → not a preference)
  if (/\b(?:i prefer|i like|i love|i hate|i don't like|my favorite|i'd rather)\b/i.test(lower)) return "preference";
  if (/\b(?:we decided|i decided|decision:|will use|let's use|going with)\b/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|\b(?:named|called)\s+[A-Z]/i.test(text)) return "entity";
  if (/\b(?:remember this|note:|important:)\b/i.test(lower)) return "explicit";
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

/**
 * Hard character budget for context injection.
 * This is the absolute maximum chars we'll ever inject via prependContext.
 * ~30k chars ≈ ~7,500 tokens — safe headroom for any model (Opus 200k, GPT 128k).
 * The ContextManager may use a tighter budget; this is the final safety net.
 */
const MAX_CONTEXT_CHARS = 30_000;

// Maximum number of code patterns to extract from compaction summary
// Limits storage to most significant patterns to avoid bloating the database
const MAX_COMPACTION_PATTERNS = 3;

/** Hard cap on total new memories stored per compaction event to prevent feedback loops. */
const MAX_COMPACTION_MEMORIES = 8;

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
// Context Budget Enforcement
// ============================================================================

/**
 * Enforce a hard character budget on assembled context.
 * Truncates at the last complete memory line that fits within the budget.
 * Returns null if the input is empty/null.
 */
function enforceContextBudget(context: string | null | undefined, budget: number = MAX_CONTEXT_CHARS): string | null {
  if (!context || context.length === 0) return null;
  if (context.length <= budget) return context;

  // Truncate at last newline that fits within budget
  const truncated = context.slice(0, budget);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > budget * 0.5) {
    return truncated.slice(0, lastNewline) + "\n\n[... context truncated to fit model limits]";
  }
  return truncated + "\n\n[... context truncated to fit model limits]";
}

/**
 * Format memories into context lines, respecting a character budget.
 * Stops adding memories once the budget would be exceeded.
 */
function formatMemoriesWithBudget(
  memories: Array<{ category: string; content: string; originator_name?: string; originator_id?: string; status?: string }>,
  budget: number,
): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const m of memories) {
    const attribution = m.originator_name
      ? ` [by: ${m.originator_name}]`
      : m.originator_id
      ? ` [by: ${m.originator_id}]`
      : "";
    const statusStr = m.status ? ` [${m.status}]` : "";
    const line = `- [${m.category}]${attribution}${statusStr} ${m.content}`;
    
    if (totalChars + line.length + 1 > budget) break;
    lines.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  return lines.join("\n");
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

// Smart memory management systems (module-level for proper scoping)
let memoryMdGenerator: MemoryMdGenerator | null = null;
let contextManager: ContextManager | null = null;
let compatibilityDetector: OpenClawCompatibilityDetector | null = null;
let compatibilityLayer: CompatibilityLayer | null = null;
let operatingMode: OperatingMode = 'compatible'; // Default fallback

const pluresLM = {
  id: "plureslm",
  name: "Plures LM",
  description: "Local-first long-term memory with vector search, graph edges, and coding intelligence",
  kind: "extension" as const,
  configSchema,

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    
    // Create PluresDB native backend
    const db = new PluresDBBackend(resolvedDbPath, cfg.embeddingDimension, {
      embeddingModel: cfg.embeddingModel,
      actorId: cfg.agentId,
      dbBaseDir: cfg.dbBaseDir,
    });

    // Start IPC handler for CLI → gateway communication
    const ipcHandler = new GatewayIpcHandler(db);
    ipcHandler.start();
    api.logger.info("[pluresLM] IPC handler started");

    // Embeddings via PluresDB native fastembed (lazy init after db.open)
    let embeddingsReady: DualEmbeddings | null = null;

    // Rate-limiting flag: at most one auto-link operation at a time
    let autoLinkInProgress = false;
    const getEmbeddings = async (): Promise<DualEmbeddings> => {
      if (embeddingsReady) return embeddingsReady;
      await (db as any).ensureInitialized();
      const dbHandle = (db as any).getDB();
      embeddingsReady = new DualEmbeddings(
        {
          provider: cfg.embeddingProvider === "transformers" ? "pluresdb" : cfg.embeddingProvider,
          pluresdb: dbHandle,
          ollamaEndpoint: cfg.ollamaEndpoint,
          ollamaModel: cfg.ollamaModel,
          dimension: cfg.embeddingDimension,
          debug: cfg.debug,
        },
        api.logger,
      );
      return embeddingsReady;
    };
    const embedText = async (text: string): Promise<number[]> => {
      const e = await getEmbeddings();
      return e.embed(text);
    };

    // Expose db and embedText for the module-level public API functions
    ingestState.db = db;
    ingestState.embedText = embedText;

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
    // Pattern Engine
    // ========================================================================

    // Built-in patterns ship alongside the compiled module in dist/patterns/
    const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const builtinPatternsDir = path.join(__moduleDir, "patterns");

    // User patterns live in ~/.openclaw/pluresLM/patterns/ by default
    const userPatternsDir = api.resolvePath("~/.openclaw/pluresLM/patterns");

    const allPatternsDirs = [
      builtinPatternsDir,
      userPatternsDir,
      ...cfg.patternsDirs.map((d) => api.resolvePath(d)),
    ];

    const patternEngine = new PatternEngine({
      patternsDirs: allPatternsDirs,
      watch: cfg.patternsWatch,
      debug: cfg.debug,
      store: async (content: string, opts: Record<string, unknown>) => {
        try {
          await ensureDbOpen();
          const vec = await embedText(content);

          // Build base tags from opts.tags, then encode structured fields so
          // they survive storage (backend only persists fixed columns + tags).
          const baseTags: string[] = Array.isArray(opts.tags)
            ? (opts.tags as unknown[]).map(String)
            : [];

          if (opts.repository != null) {
            baseTags.push(`repo:${String(opts.repository)}`);
          }
          if (opts.workflow != null) {
            baseTags.push(`workflow:${String(opts.workflow)}`);
          }
          const metadata = opts.metadata;
          if (metadata !== null && typeof metadata === "object") {
            for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
              if (v == null) continue;
              baseTags.push(`meta:${k}:${String(v)}`);
            }
          }

          // Spread opts first (keeps any extra fields that db.store accepts),
          // then override the normalised fields so they are never silently replaced.
          await db.store(content, vec, {
            ...opts,
            source: String(opts.source ?? "pattern-engine"),
            category: String(opts.category ?? "pattern"),
            tags: baseTags,
          });
        } catch (err) {
          debug(`PatternEngine store error: ${String(err)}`);
        }
      },
      search: async (
        query: string,
        filter?: Record<string, unknown>,
        limit = 5,
        minSimilarity = 0.7,
      ): Promise<PatternMatch[]> => {
        try {
          await ensureDbOpen();
          const vec = await embedText(query);
          // Fetch more results so client-side filter has enough to work with
          const fetchLimit = filter ? Math.max(limit * 4, 20) : limit;
          const results = await db.vectorSearch(vec, fetchLimit, minSimilarity);

          let filtered = results;
          if (filter) {
            filtered = results.filter((r) => {
              // category filter
              if (filter.category != null && r.entry.category !== String(filter.category)) {
                return false;
              }
              // repository filter (stored as repo:<name> tag)
              if (filter.repository != null) {
                const repoTag = `repo:${String(filter.repository)}`;
                if (!r.entry.tags.includes(repoTag)) return false;
              }
              // actor filter (stored as tag if present)
              if (filter.actor != null) {
                const actorTag = `actor:${String(filter.actor)}`;
                if (!r.entry.tags.includes(actorTag)) return false;
              }
              // delegator filter
              if (filter.delegator != null) {
                const delegatorTag = `delegator:${String(filter.delegator)}`;
                if (!r.entry.tags.includes(delegatorTag)) return false;
              }
              return true;
            });
          }

          return filtered.slice(0, limit).map((r) => ({
            content: r.entry.content,
            metadata: {
              id: r.entry.id,
              category: r.entry.category,
              tags: r.entry.tags,
              source: r.entry.source,
            },
            score: r.score,
          }));
        } catch (err) {
          debug(`PatternEngine search error: ${String(err)}`);
          return [];
        }
      },
    });

    patternEngine.load();

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
        const vec = await embedText("self-test");
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
          // PluresDB stores embeddings (8 bytes/value for f64)
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

    // Pre-compute recall exclusion set for hot path
    const recallExcludeSet = new Set(cfg.recallExcludeCategories);

    api.logger.info(`pluresLM: initialized (db: ${resolvedDbPath}, backend: pluresdb-native, recallExclude: [${cfg.recallExcludeCategories.join(",")}])`);

    // ========================================================================
    // Project File Indexing Helper
    // ========================================================================

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /**
     * Retry wrapper for transient fs errors (used for non-forked/manual indexing).
     */
    const withFsRetry = async <T>(op: () => Promise<T>, label: string): Promise<T> => {
      let attempt = 0;
      let delayMs = 40;
      // Keep this conservative; the forked worker has its own retry layer.
      const maxAttempts = Math.max(1, cfg.projectIndexRetries ?? 3) + 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          return await op();
        } catch (err: any) {
          attempt++;
          const code = err?.code ? ` (${err.code})` : "";
          if (attempt >= maxAttempts) {
            api.logger.warn(`pluresLM: fs op failed${code} after ${attempt} attempt(s) [${label}]: ${String(err)}`);
            throw err;
          }
          // Exponential backoff with jitter
          const jitter = Math.floor(Math.random() * 25);
          await sleep(Math.min(1000, delayMs + jitter));
          delayMs *= 2;
        }
      }
    };

    /**
     * Index a file's content into memory (parent process side).
     *
     * Important: this function does embedding + DB writes, but does NOT do disk IO.
     */
    async function indexProjectFileContent(resolvedPath: string, content: string): Promise<number> {
      if (!content.trim()) return 0;

      const ext = path.extname(resolvedPath).toLowerCase();
      const isMarkdown = ext === ".md";
      const chunks = isMarkdown ? chunkMarkdown(content, resolvedPath) : chunkCodeFile(content, resolvedPath);

      // Delete existing chunks from this file before re-indexing
      const sourceTag = `project-file:${resolvedPath}`;
      await db.deleteBySource(sourceTag);

      let stored = 0;
      for (const chunk of chunks) {
        const embedding = await embedText(chunk.text);
        const result = await db.store(chunk.text, embedding, {
          source: sourceTag,
          tags: [`file:${path.basename(resolvedPath)}`, `heading:${chunk.heading}`, ...extractTags(chunk.text)],
          category: "project-context",
          dedupeThreshold: cfg.dedupeThreshold,
        });
        if (!result.isDuplicate) stored++;
      }

      return stored;
    }

    // REMOVED: indexProjectFile function - only accessible through safe forked worker
    // This prevents direct file processing that bypasses safety mechanisms

    // REMOVED: indexDirectory function - all indexing must go through safe forked worker
    // This prevents bypassing throttling/safety mechanisms

    /**
     * Forked project indexing: perform disk IO + directory traversal in a child process.
     * This avoids blocking the OpenClaw gateway event loop on startup.
     */
    const startProjectIndexingForked = (pathsToIndex: string[]) => {
      if (!pathsToIndex || pathsToIndex.length === 0) return;

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const workerPath = path.join(__dirname, "indexing-worker.js");

      let child;
      try {
        child = fork(workerPath, [], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: { ...process.env },
        });
      } catch (err) {
        api.logger.warn(`pluresLM: failed to fork indexing worker (${workerPath}): ${String(err)}`);
        return;
      }

      const startedAt = Date.now();
      api.logger.info(`pluresLM: forked project indexer (pid=${child.pid})`);

      child.stdout?.on("data", (d) => {
        // Worker may emit progress logs.
        const msg = String(d).trim();
        if (msg) api.logger.info(`pluresLM:indexer: ${msg}`);
      });
      child.stderr?.on("data", (d) => {
        const msg = String(d).trim();
        if (msg) api.logger.warn(`pluresLM:indexer: ${msg}`);
      });

      // Parent-side throttling: yield between files so embeddings+DB writes don't starve the loop.
      let processedFiles = 0;
      let storedChunks = 0;

      child.on("message", async (m: any) => {
        if (!m || typeof m !== "object") return;

        if (m.type === "batch") {
          const files = Array.isArray(m.files) ? m.files : [];
          for (const f of files) {
            try {
              if (!f?.path || typeof f.content !== "string") continue;
              const stored = await indexProjectFileContent(f.path, f.content);
              processedFiles++;
              storedChunks += stored;

              // Yield periodically to keep the gateway responsive.
              if (processedFiles % 3 === 0) await new Promise<void>((r) => setImmediate(r));
            } catch (err) {
              api.logger.warn(`pluresLM: project indexing failed for ${String(f?.path)}: ${String(err)}`);
            }
          }

          if (m.progress) {
            api.logger.info(`pluresLM: project indexing progress: ${m.progress}`);
          }
        }

        if (m.type === "done") {
          const elapsedMs = Date.now() - startedAt;
          api.logger.info(`pluresLM: project indexing complete: ${processedFiles} file(s), ${storedChunks} chunk(s) stored (${elapsedMs}ms)`);
          try {
            child.disconnect();
          } catch {
            // ignore
          }
        }

        if (m.type === "error") {
          api.logger.warn(`pluresLM: project indexing worker error: ${String(m.error ?? "(unknown)")}`);
        }
      });

      child.on("exit", (code, signal) => {
        if (code === 0) return;
        api.logger.warn(`pluresLM: project indexing worker exited (code=${code}, signal=${signal ?? ""})`);
      });

      const resolved = pathsToIndex.map((p) => api.resolvePath(p));
      child.send({
        type: "start",
        paths: resolved,
        batchSize: cfg.projectIndexBatchSize,
        readOpsPerSecond: cfg.projectIndexReadOpsPerSecond,
        maxFileBytes: cfg.projectIndexMaxFileBytes,
        retries: cfg.projectIndexRetries,
      });
    };

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
            Type.String({ description: "Category: preference, decision, entity, project, explicit, conversation, code-pattern, type-definition, module-composition, api-pattern, architecture-decision, error-fix, work-in-progress, project-context, document, document-chunk, note, reference, insight" }),
          ),
          destination: Type.Optional(Type.String({ description: "Target agent ID or scope for this memory (empty = all agents)" })),
          status: Type.Optional(Type.String({ description: "Task status: claimed, in-progress, completed, or abandoned" })),
          assigned_to: Type.Optional(Type.String({ description: "Agent ID responsible for this task" })),
          due_at: Type.Optional(Type.Number({ description: "Task deadline as Unix millisecond timestamp" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { text, tags, category, destination, status, assigned_to, due_at } = params as { text: string; tags?: string[]; category?: string; destination?: string; status?: string; assigned_to?: string; due_at?: number };
            const embedding = await embedText(text);
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

            // Background auto-link on new memory store when configured.
            // A simple in-progress flag prevents concurrent auto-link storms
            // if memories are stored in rapid succession.
            if (cfg.autoLinkOnStore && !autoLinkInProgress) {
              const memId = result.entry.id;
              autoLinkInProgress = true;
              setImmediate(() => {
                db.autoLink({ algorithms: cfg.autoLinkAlgorithms, memoryId: memId })
                  .catch((err) => {
                    debug(`autoLink on store failed: ${String(err)}`);
                  })
                  .finally(() => {
                    autoLinkInProgress = false;
                  });
              });
            }

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
            const embedding = await embedText(query);
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
        name: "pluresLM_query",
        label: "Execute Memory Query",
        description: "Execute advanced PluresDB procedures query with filtering, sorting, aggregation, and graph operations.",
        parameters: Type.Object({
          query: Type.String({ 
            description: "Query DSL string. Examples: 'filter(category == \"decision\")', 'filter(category == \"project\") |> sort(by: \"score\", dir: \"desc\") |> limit(5)', 'aggregate(count)', 'graph_neighbors(\"memory:UUID\", depth: 2)', 'auto_link()'" 
          }),
          format: Type.Optional(Type.String({ description: "Output format: table, json, compact (default: table)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { query, format = "table" } = params as { query: string; format?: string };
            
            try {
              const result = await db.execDsl(query);
              
              // Handle aggregation results
              if (result.aggregate !== undefined) {
                return { 
                  content: [{ 
                    type: "text", 
                    text: `Aggregate Result: ${JSON.stringify(result.aggregate)}` 
                  }] 
                };
              }
              
              const memories = result.nodes || [];
              if (memories.length === 0) {
                return { content: [{ type: "text", text: "No memories found matching query." }] };
              }
              
              // Format output based on requested format
              let text: string;
              if (format === "json") {
                text = JSON.stringify(memories, null, 2);
              } else if (format === "compact") {
                text = memories.map((mem, i) => {
                  const preview = mem.content?.substring(0, 100) + (mem.content && mem.content.length > 100 ? "..." : "");
                  return `${i + 1}. [${mem.category}] ${preview}`;
                }).join('\n');
              } else {
                // table format (default)
                text = memories.map((mem, i) => {
                  const lines = [];
                  lines.push(`${i + 1}. Memory ID: ${mem.id}`);
                  lines.push(`   Category: ${mem.category}`);
                  if (mem.tags && mem.tags.length > 0) {
                    lines.push(`   Tags: ${mem.tags.join(", ")}`);
                  }
                  if (typeof mem.importance_score === "number") {
                    lines.push(`   Score: ${mem.importance_score.toFixed(3)}`);
                  }
                  const preview = mem.content?.substring(0, 150) + (mem.content && mem.content.length > 150 ? "..." : "");
                  lines.push(`   Content: ${preview}`);
                  if (mem.created_at) {
                    lines.push(`   Created: ${new Date(mem.created_at).toLocaleString()}`);
                  }
                  return lines.join('\n');
                }).join('\n\n');
              }
              
              return { content: [{ type: "text", text: `Found ${memories.length} memories:\n\n${text}` }] };
              
            } catch (error) {
              const errorMsg = [
                `Query failed: ${String(error)}`,
                "",
                "Example queries:",
                '• filter(category == "decision")',
                '• filter(category == "decision") |> sort(by: "score", dir: "desc") |> limit(5)',
                '• filter(tags.contains("rust"))',
                '• aggregate(count)',
                '• filter(created_at > 1640995200000) |> project(["id", "category", "text"])',
                '• graph_neighbors("memory:UUID", depth: 2)',
                '• auto_link()',
              ].join('\n');
              
              return { content: [{ type: "text", text: errorMsg }] };
            }
          });
        },
      },
      { name: "pluresLM_query" },
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
              const embedding = await embedText(query);
              const results = await db.vectorSearch(embedding, 5, 0.7);

              if (results.length === 0) {
                return { content: [{ type: "text", text: "No matching memories found." }] };
              }

              if (results.length === 1 && results[0].score > 0.9) {
                await db.delete(results[0].entry.id);
                return { content: [{ type: "text", text: `Deleted: "${results[0].entry.content.slice(0, 80)}"` }] };
              }

              const list = results
                .map((r) => `- [${r.entry.id}] ${r.entry.content.slice(0, 60)}... (${(r.score * 100).toFixed(0)}%)`)
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
        description: "Index a project directory into memory. Uses safe forked worker with throttling. For large directories, indexing runs in background.",
        parameters: Type.Object({
          path: Type.String({ description: "Path to project directory to index" }),
        }),
        async execute(_id, params) {
          const { path: dirPath } = params as { path: string };

          try {
            // ONLY safe path: use forked worker for ALL indexing
            // This ensures throttling, yields, and safety limits are always applied
            return await withDbRetry(async () => {
              const resolvedDir = api.resolvePath(dirPath);
              
              // Start the safe forked indexer
              startProjectIndexingForked([resolvedDir]);
              
              return {
                content: [{
                  type: "text",
                  text: `Started safe background indexing for ${dirPath}. Monitor progress in logs - large directories may take several minutes with throttling to prevent gateway blocking.`,
                }],
              };
            });
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to start indexing: ${String(err)}` }],
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
            const lastSyncTime = sync?.lastSyncTime ?? 0;
            const last = lastSyncTime !== 0 ? lastSyncTime : await db.getLastSyncTime("__global__");
            const lastStr = last ? new Date(last).toLocaleString() : "never";
            const enabled = Boolean(cfg.syncEnabled && cfg.syncKey);

            const lines = [
              `enabled: ${enabled}`,
              `peerCount: ${peers}`,
              `lastSyncTime: ${lastSyncTime}`,
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
        name: "pluresLM_consolidate",
        label: "Consolidate Memories",
        description: "Run memory consolidation: merge duplicates, demote stale memories, promote reinforced facts.",
        parameters: Type.Object({
          dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without applying them (default: true)" })),
          stalenessDays: Type.Optional(Type.Number({ description: "Days threshold for staleness detection (default: 30)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { dryRun = true, stalenessDays = 30 } = params as { dryRun?: boolean; stalenessDays?: number };
            
            const stats = await db.runConsolidation({ dryRun, stalenessDays });
            
            const lines = [
              dryRun ? "# Consolidation Preview (Dry Run)" : "# Consolidation Complete",
              ``,
              `Duplicates ${dryRun ? "would be" : ""} merged: ${stats.merged}`,
              `Memories ${dryRun ? "would be" : ""} demoted: ${stats.demoted}`,
              `Memories ${dryRun ? "would be" : ""} promoted: ${stats.promoted}`,
              ``,
              dryRun ? "Run with dryRun=false to apply changes." : "Changes applied successfully.",
            ];
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          });
        },
      },
      { name: "pluresLM_consolidate" },
    );

    api.registerTool(
      {
        name: "pluresLM_world_state",
        label: "Generate World State",
        description: "Generate a summary of high-priority memories (state of the world).",
        parameters: Type.Object({}),
        async execute() {
          return await withDbRetry(async () => {
            const summary = await db.generateWorldState();
            return { content: [{ type: "text", text: summary }] };
          });
        },
      },
      { name: "pluresLM_world_state" },
    );

    api.registerTool(
      {
        name: "pluresLM_find_stale",
        label: "Find Stale Memories",
        description: "Find memories that haven't been accessed in a specified number of days.",
        parameters: Type.Object({
          days: Type.Optional(Type.Number({ description: "Days threshold (default: 30)" })),
          limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10)" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { days = 30, limit = 10 } = params as { days?: number; limit?: number };
            
            const staleMemories = await db.findStaleMemories(days);
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
      { name: "pluresLM_find_stale" },
    );

    api.registerTool(
      {
        name: "pluresLM_generate_daily_summary",
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
      { name: "pluresLM_generate_daily_summary" },
    );

    api.registerTool(
      {
        name: "pluresLM_get_daily_summaries",
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
      { name: "pluresLM_get_daily_summaries" },
    );

    // ========================================================================
    // Pattern Engine Tools
    // ========================================================================

    api.registerTool(
      {
        name: "pluresLM_pattern_dispatch",
        label: "Dispatch Pattern Event",
        description:
          "Dispatch a named event through the YAML pattern engine. " +
          "Matching patterns will perform recall → capture → action automatically. " +
          "Returns action results (suggest-fix, apply-preference, context-inject, store-new, etc.).",
        parameters: Type.Object({
          event: Type.String({ description: "Event type to dispatch (e.g. 'ci-failure', 'human-override', 'repo-interaction')" }),
          context: Type.Object(
            {},
            {
              description: "Template variables injected into all Mustache templates for matching patterns",
              additionalProperties: true,
            },
          ),
        }),
        async execute(_id, params) {
          const { event, context } = params as {
            event: string;
            context: Record<string, unknown>;
          };
          const results = await patternEngine.dispatch(event, context);
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No patterns matched event '${event}'.` }],
            };
          }
          const lines = results.map((r) => {
            let line = `**${r.patternName}** → \`${r.action}\``;
            if (r.message) line += `\n> ${r.message}`;
            if (r.matches?.length) {
              line += `\nMatches: ${r.matches.length} (top score: ${r.matches[0].score.toFixed(3)})`;
            }
            return line;
          });
          return {
            content: [{ type: "text", text: lines.join("\n\n") }],
          };
        },
      },
      { name: "pluresLM_pattern_dispatch" },
    );

    api.registerTool(
      {
        name: "pluresLM_pattern_list",
        label: "List Loaded Patterns",
        description: "List all YAML operational memory patterns currently loaded by the pattern engine.",
        parameters: Type.Object({}),
        async execute(_id, _params) {
          const names = patternEngine.getPatternNames();
          if (names.length === 0) {
            return { content: [{ type: "text", text: "No patterns loaded." }] };
          }
          const lines = names.map((name) => {
            const p = patternEngine.getPattern(name)!;
            return `- **${name}** (v${p.version}) — event: \`${p.trigger.event}\`${p.description ? `\n  ${p.description}` : ""}`;
          });
          return {
            content: [{ type: "text", text: `Loaded patterns (${names.length}):\n\n${lines.join("\n")}` }],
          };
        },
      },
      { name: "pluresLM_pattern_list" },
    );

    api.registerTool(
      {
        name: "pluresLM_graph_neighbors",
        label: "Find Related Memories",
        description: "Find memories related to a given memory via graph traversal. Uses PluresDB Phase 2A graph_neighbors when available; falls back to direct edge traversal.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "UUID of the memory to find neighbours for (without the 'memory:' prefix)" }),
          depth: Type.Optional(Type.Number({ description: "Traversal depth (default: 2)" })),
          minStrength: Type.Optional(Type.Number({ description: "Minimum relationship strength 0.0–1.0 (default: no filter)" })),
          linkTypes: Type.Optional(Type.Array(Type.String(), { description: "Restrict to specific edge relation types (e.g. ['fixed-by', 'related'])" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { memoryId, depth, minStrength, linkTypes } = params as {
              memoryId: string;
              depth?: number;
              minStrength?: number;
              linkTypes?: string[];
            };

            const related = await db.findRelated(memoryId, { depth, minStrength, linkTypes });

            if (related.length === 0) {
              return { content: [{ type: "text", text: `No related memories found for ${memoryId.slice(0, 8)}.` }] };
            }

            const lines = related.map((m, i) => {
              const attribution = m.originator_name
                ? ` [by: ${m.originator_name}]`
                : m.originator_id
                ? ` [by: ${m.originator_id}]`
                : "";
              return `${i + 1}. [${m.category}]${attribution} ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`;
            });

            return {
              content: [{
                type: "text",
                text: `Found ${related.length} related memories (depth=${depth ?? 2}):\n\n${lines.join("\n")}`,
              }],
            };
          });
        },
      },
      { name: "pluresLM_graph_neighbors" },
    );

    api.registerTool(
      {
        name: "pluresLM_autolink",
        label: "Auto-Link Memories",
        description: "Trigger automatic relationship discovery between memories using semantic similarity, category clustering, and temporal proximity.",
        parameters: Type.Object({
          mode: Type.Union([
            Type.Literal("all"),
            Type.Literal("incremental"),
            Type.Literal("memory"),
          ], { description: "Linking mode: 'all' (all memories), 'incremental' (new/updated only — currently equivalent to 'all', reserved for future timestamp-filtered implementation), or 'memory' (specific memory)" }),
          target: Type.Optional(Type.String({ description: "Memory UUID when mode='memory'" })),
          algorithms: Type.Optional(Type.Array(Type.String(), { description: "Algorithms to use: 'semantic', 'category', 'temporal'" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { mode, target, algorithms } = params as {
              mode: "all" | "incremental" | "memory";
              target?: string;
              algorithms?: string[];
            };

            const algos = algorithms ?? cfg.autoLinkAlgorithms;

            if (mode === "memory" && !target) {
              return { content: [{ type: "text", text: "Provide a target memory UUID when mode='memory'." }] };
            }

            const memoryId = mode === "memory" ? target : undefined;
            const result = await db.autoLink({ algorithms: algos, memoryId });

            return {
              content: [{
                type: "text",
                text: `Auto-link complete (mode: ${mode}). Created ${result.linksCreated} new memory relationship${result.linksCreated !== 1 ? "s" : ""}.`,
              }],
            };
          });
        },
      },
      { name: "pluresLM_autolink" },
    );

    api.registerTool(
      {
        name: "pluresLM_graph_insights",
        label: "Memory Graph Insights",
        description: "Analyze memory relationship patterns: clusters, isolated memories, relationship strength, and category distribution.",
        parameters: Type.Object({
          timespan: Type.Optional(Type.String({ description: "Human-readable timespan label for context (e.g. '7d', '30d')" })),
        }),
        async execute(_id, params) {
          return await withDbRetry(async () => {
            const { timespan } = params as { timespan?: string };

            const insights = await db.getMemoryInsights(timespan);

            const clusterLines = insights.clusters.length > 0
              ? insights.clusters
                  .slice(0, 10)
                  .map((c, i) => `  ${i + 1}. Cluster (${c.size} memories, categories: ${c.categories.join(", ")})`)
                  .join("\n")
              : "  No clusters detected.";

            const catLines = insights.topCategories
              .map((tc) => `  ${tc.category}: ${tc.count}`)
              .join("\n");

            const lines = [
              `## Memory Graph Insights${timespan ? ` (${timespan})` : ""}`,
              ``,
              `**Memories**: ${insights.totalMemories} total, ${insights.connectedMemories} connected, ${insights.isolatedMemories} isolated`,
              `**Edges**: ${insights.totalEdges} relationships`,
              `**Clusters** (${insights.clusters.length}):`,
              clusterLines,
              ``,
              `**Top categories**:`,
              catLines,
            ];

            return { content: [{ type: "text", text: lines.join("\n") }] };
          });
        },
      },
      { name: "pluresLM_graph_insights" },
    );

    // ========================================================================
    // Compatibility & Mode Detection
    // ========================================================================

    api.registerTool(
      {
        name: "pluresLM_compatibility",
        label: "Check OpenClaw Compatibility",
        description: "Check PluresLM compatibility with current OpenClaw installation and operating mode.",
        parameters: Type.Object({
          report: Type.Optional(Type.Boolean({ description: "Generate detailed compatibility report" })),
          recommend: Type.Optional(Type.Boolean({ description: "Show installation recommendations" })),
        }),
        async execute(_id, params: any) {
          const { report = false, recommend = false } = params || {};
          
          if (!compatibilityDetector) {
            return { content: [{ type: "text", text: "Compatibility detection not initialized" }] };
          }

          const lines: string[] = [];
          
          // Basic status
          lines.push(`🔧 **PluresLM Operating Mode**: ${operatingMode.toUpperCase()}`);
          lines.push('');
          
          if (report) {
            const compatReport = await compatibilityDetector.generateCompatibilityReport();
            lines.push(compatReport);
          } else {
            // Brief status
            const capabilities = await compatibilityDetector.detectCapabilities();
            lines.push(`**OpenClaw Version**: ${capabilities.version}`);
            lines.push(`**Custom Memory Hooks**: ${capabilities.hasCustomMemoryHooks ? '✅' : '❌'}`);
            lines.push(`**Process Isolation**: ${capabilities.hasProcessIsolation ? '✅' : '❌'}`);
            lines.push(`**Extension Kind**: ${capabilities.supportsExtensionKind ? '✅' : '❌'}`);
            
            if (operatingMode === 'enhanced') {
              lines.push('');
              lines.push('🚀 **Enhanced Features Active**:');
              lines.push('• PluresLM as single source of truth');
              lines.push('• Real-time context management');
              lines.push('• Intelligent memory auto-generation');
              lines.push('• Process-specific database isolation');
            } else {
              lines.push('');
              lines.push('📦 **Compatible Mode Features**:');
              lines.push('• PluresLM + file-based memory coexistence');
              lines.push('• Enhanced compaction assistance');
              lines.push('• Hybrid recall system');
              lines.push('• Assisted memory.md generation');
            }
          }
          
          if (recommend) {
            lines.push('');
            lines.push('---');
            lines.push('');
            const recommendations = await compatibilityDetector.recommendInstallation();
            lines.push(recommendations);
          }
          
          return { content: [{ type: "text", text: lines.join('\n') }] };
        },
      },
      { name: "pluresLM_compatibility" },
    );

    // ========================================================================
    // Lifecycle Hooks — Auto-Recall (with WIP boosting)
    // ========================================================================

    // Hook registration

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

        // Session-start context injection (fires on first turn or when no prompt)
        if (cfg.sessionStartRecall.enabled && turnCounter === 0) {
          try {
            return await withDbRetry(async () => {
              const parts: string[] = [];
              let budgetRemaining = MAX_CONTEXT_CHARS;

              // Always include profile at session start
              const profile = await db.getProfile();
              if (profile?.summary) {
                const profileBlock = `<user-profile>\n${profile.summary}\n</user-profile>`;
                parts.push(profileBlock);
                budgetRemaining -= profileBlock.length;
              }

              // Reserve budget for XML wrappers (~100 chars)
              budgetRemaining -= 100;

              // Get context memories via vector-based context manager
              if (contextManager) {
                const contextMemories = await contextManager.getSessionStartContext();
                if (contextMemories.length > 0) {
                  const memoryLines = formatMemoriesWithBudget(contextMemories, Math.max(0, budgetRemaining));
                  if (memoryLines) {
                    parts.push(`<memory-context source="smart">\n${memoryLines}\n</memory-context>`);
                  }
                }
                debug(`session-start: injecting profile and ${contextMemories.length} smart context memories`);
              } else {
                const priorityMemories = await db.getMemoriesByCategories(
                  cfg.sessionStartRecall.priorityCategories,
                  cfg.sessionStartRecall.maxMemories,
                  cfg.sessionStartRecall.recencyBias
                );
                const memoryLines = formatMemoriesWithBudget(priorityMemories, Math.max(0, budgetRemaining));
                if (memoryLines) {
                  parts.push(`<session-context>\n${memoryLines}\n</session-context>`);
                }
                debug(`session-start: injecting profile and ${priorityMemories.length} priority memories`);
              }

              turnCounter++;

              // Final safety: enforce hard budget on assembled context
              const assembled = parts.join("\n\n");
              const safeContext = enforceContextBudget(assembled, MAX_CONTEXT_CHARS);
              if (!safeContext) return;

              return { prependContext: safeContext };
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
            // Use ContextManager for vector-based per-turn recall
            const memories = contextManager
              ? await contextManager.getContextForPrompt(event.prompt, embedText)
              : await db.vectorSearchBoosted(
                  await embedText(event.prompt),
                  cfg.maxRecallResults,
                  0.3,
                  { "work-in-progress": 1.3 },
                  recallExcludeSet.size > 0 ? recallExcludeSet : undefined,
                ).then((rs) => rs.map((r) => r.entry));

            const parts: string[] = [];

            turnCounter++;
            if (turnCounter % cfg.profileFrequency === 0) {
              const profile = await db.getProfile();
              if (profile?.summary) {
                parts.push(`<user-profile>\n${profile.summary}\n</user-profile>`);
              }
            }

            if (memories.length > 0) {
              const memoryLines = formatMemoriesWithBudget(memories, MAX_CONTEXT_CHARS);
              if (memoryLines) {
                parts.push(`<relevant-memories>\n${memoryLines}\n</relevant-memories>`);
              }
            }

            if (parts.length === 0) return;

            debug(`injecting ${memories.length} memories into context`);

            // Safety: enforce hard budget even on recall path
            const assembled = parts.join("\n\n");
            const safeContext = enforceContextBudget(assembled, MAX_CONTEXT_CHARS);
            if (!safeContext) return;

            return { prependContext: safeContext };
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

          const capturable = texts.filter((t) => shouldCapture(t, cfg.captureQuality));
          if (capturable.length === 0) return;

          let stored = 0;
          const maxPerTurn = cfg.captureQuality.maxCapturesPerTurn;

          // Attribution opts for all auto-captured memories
          const captureAttribution = {
            originator_id: cfg.agentId || undefined,
            originator_name: cfg.agentName || undefined,
          };

          // --- Original conversation capture ---
          for (const text of capturable.slice(0, maxPerTurn)) {
            const embedding = await embedText(text);
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
            const embedding = await embedText(pattern.content);
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
            const errorEmbedding = await embedText(pair.error);
            const errorResult = await db.store(pair.error, errorEmbedding, {
              source: "auto-capture:error",
              tags: [...pair.errorTags, "type:error"],
              category: "error-fix",
              dedupeThreshold: cfg.dedupeThreshold,
              ...captureAttribution,
            });

            const fixEmbedding = await embedText(pair.fix);
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
              const embedding = await embedText(text);
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
          const summaryEmbedding = await embedText(summaryContent);
          
          const summaryResult = await db.store(summaryContent, summaryEmbedding, {
            source: "compaction-snapshot",
            tags: ["compaction", "snapshot", `timestamp:${timestamp}`, ...(sessionKey ? [`session:${sessionKey}`] : [])],
            category: "compaction-snapshot",
            dedupeThreshold: cfg.dedupeThreshold,
            ...compactionAttribution,
          });

          let stored = summaryResult.isDuplicate ? 0 : 1;

          // Extract key facts, decisions, and patterns from the summary
          // Cap total memories per compaction to prevent feedback loops
          const extractedPatterns = extractCodePatterns(summary);
          for (const pattern of extractedPatterns.slice(0, MAX_COMPACTION_PATTERNS)) {
            if (stored >= MAX_COMPACTION_MEMORIES) break;
            const embedding = await embedText(pattern.content);
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
            if (stored >= MAX_COMPACTION_MEMORIES) break;
            if (line.length < MIN_COMPACTION_LINE_LENGTH) continue;
            
            if (containsImportantContext(line)) {
              const embedding = await embedText(line);
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
            if (stored >= MAX_COMPACTION_MEMORIES) break;
            if (line.length < MIN_COMPACTION_LINE_LENGTH) continue;
            if (isWorkInProgress(line)) {
              const embedding = await embedText(line);
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
        api.logger.warn(`pluresLM: compaction capture failed: ${String(err)}`);
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
        const slm = program.command("pluresLM").description("Plures LM commands");

        slm.command("stats").description("Show memory stats").action(async () => {
          if (isGatewayRunning()) {
            // Gateway running → use IPC (no database access allowed)
            const client = new GatewayIpcClient();
            if (!(await client.isGatewayAvailable())) {
              console.error("[PluresLM] Gateway is running but IPC is not available");
              console.error("The database is locked by the gateway and CLI cannot access it directly");
              process.exit(1);
            }
            try {
              const result = await client.getStats();
              console.log(JSON.stringify(result, null, 2));
            } catch (error) {
              console.error(`[PluresLM] Gateway IPC failed: ${String(error)}`);
              process.exit(1);
            }
          } else {
            // Gateway not running → direct database access
            await ensureDbOpen();
            const stats = await db.stats();
            const profile = await db.getProfile();
            const output = {
              ...stats,
              lastCaptureTime: stats.lastCaptureTime ? new Date(stats.lastCaptureTime).toISOString() : null,
              profileSummary: profile?.summary?.slice(0, 200) ?? "No profile yet",
            };
            console.log(JSON.stringify(output, null, 2));
          }
        });

        slm.command("search").description("Search memories").argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            return await withDbRetry(async () => {
              const embedding = await embedText(query);
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
            
            const dryRun = !opts.apply;
            const stalenessDays = parseInt(opts.stalenessDays);
            
            console.log(`\n🔄 Running memory consolidation ${dryRun ? "(DRY RUN)" : "(APPLYING CHANGES)"}...\n`);
            
            const stats = await db.runConsolidation({ dryRun, stalenessDays });
            
            console.log("Results:");
            console.log(`  Duplicates ${dryRun ? "would be" : ""} merged: ${stats.merged}`);
            console.log(`  Memories ${dryRun ? "would be" : ""} demoted: ${stats.demoted}`);
            console.log(`  Memories ${dryRun ? "would be" : ""} promoted: ${stats.promoted}`);
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
            
            const summary = await db.generateWorldState();
            console.log(summary);
          });

        slm.command("find-stale")
          .description("Find memories that haven't been accessed recently")
          .option("--days <n>", "Days threshold", "30")
          .option("--limit <n>", "Maximum results", "20")
          .action(async (opts: { days: string; limit: string }) => {
            await ensureDbOpen();
            
            const days = parseInt(opts.days);
            const limit = parseInt(opts.limit);
            
            const staleMemories = await db.findStaleMemories(days);
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
          let stats, profile;
          
          if (isGatewayRunning()) {
            // Gateway running → use IPC
            const client = new GatewayIpcClient();
            if (!(await client.isGatewayAvailable())) {
              console.error("[PluresLM] Gateway is running but IPC is not available");
              console.error("The database is locked by the gateway and CLI cannot access it directly");
              process.exit(1);
            }
            try {
              stats = await client.getStats();
              profile = await client.getProfile();
            } catch (error) {
              console.error(`[PluresLM] Gateway IPC failed: ${String(error)}`);
              process.exit(1);
            }
          } else {
            // Gateway not running → direct database access
            await ensureDbOpen();
            stats = await db.stats();
            profile = await db.getProfile();
          }
          const topTopics: string[] = [];
          const captureRate: number[] = [];
          const dbSize = "N/A";

          console.log("\n📊 Plures LM Dashboard");
          console.log("═══════════════════════════════════════");
          console.log(`Total memories:     ${(stats as any).totalMemories?.toLocaleString() ?? 'N/A'}`);

          // Category breakdown
          const total = (stats as any).totalMemories || 1; // Avoid division by zero
          const sortedCategories = Object.entries((stats as any).categories || {}).sort((a, b) => (b[1] as number) - (a[1] as number));
          
          for (const [category, count] of sortedCategories) {
            const percentage = Math.round(((count as number) / total) * 100);
            console.log(`  ${category}:`.padEnd(22) + `${(count as number).toLocaleString()} (${percentage}%)`);
          }

          // Add categories with 0 count
          const defaultCategories = ["conversation", "code-pattern", "error-fix", "work-in-progress"];
          for (const cat of defaultCategories) {
            if (!stats.categories[cat]) {
              console.log(`  ${cat}:`.padEnd(22) + "0 (0%)");
            }
          }

          console.log("\nEmbedding health:");
          if (cfg.embeddingProvider === "transformers") {
            console.log(`  Provider: Transformers.js (in-process)`);
            console.log(`  Model: ${cfg.transformersModel}`);
          } else if (cfg.embeddingProvider === "ollama") {
            console.log(`  Provider: Ollama (${cfg.ollamaModel})`);
            const primaryLatency = await testOllamaEndpoint(cfg.ollamaEndpoint, cfg.ollamaModel);
            const primaryStatus = primaryLatency !== null ? `✅ ${cfg.ollamaEndpoint} (${primaryLatency}ms)` : `❌ ${cfg.ollamaEndpoint} (unreachable)`;
            console.log(`  Endpoint: ${primaryStatus}`);
          }

          console.log(`  Dimension: ${cfg.embeddingDimension}`);

          console.log("\nCapture rate (last 7 days): N/A (PluresDB native)");

          console.log(`\nTop categories: ${Object.entries((stats as any).categories || {}).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 3).map(([cat, n]) => `${cat} (${n}x)`).join(", ") || "none"}`);

          console.log(`\nGraph edges: ${(stats as any).edgeCount ?? 'N/A'}`);
          
          const requiredCaptures = cfg.profileFrequency || 50;
          const captureCount = (profile as any)?.capture_count ?? 0;
          const hasSummary = !!(profile as any)?.summary;
          const isBuilt = hasSummary && captureCount >= requiredCaptures;
          const remainingCaptures = Math.max(0, requiredCaptures - captureCount);
          const profileStatus = isBuilt
            ? "Built"
            : `Not built yet (need ${remainingCaptures} more captures)`;
          console.log(`Profile: ${profileStatus}`);

          console.log(`Sync: ${cfg.syncEnabled ? "enabled" : "disabled"}`);
          console.log(`DB size: ${dbSize}`);
          console.log("");
        });
        slm.command("dedup")
          .description("Find and merge duplicate memories")
          .option("--dry-run", "Preview merges without applying them")
          .action(async (opts: { dryRun?: boolean }) => {
            const dryRun = opts.dryRun ?? false;
            console.log(dryRun ? "Finding duplicate memories (dry run)..." : "Finding and merging duplicate memories...");
            
            await withDbRetry(async () => {
              const result = await db.runConsolidation({ dryRun });
              const duplicates: any[] = result.merged > 0 ? [{ targetId: "batch", targetContent: `${result.merged} merged`, duplicates: [], mergedTags: [] }] : [];
              
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
                dup.duplicates.forEach((d: any) => {
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
            console.log(`ERROR: Direct CLI indexing has been disabled for safety.`);
            console.log(`Use the OpenClaw plugin tools or configure automatic startup indexing.`);
            console.log(`All indexing must go through the safe forked worker to prevent system instability.`);
            process.exit(1);
          });

        slm.command("query")
          .description("Execute PluresDB procedures query")
          .argument("<query>", "Query DSL string (e.g., 'filter(category == \"decision\") |> sort(by: \"score\", dir: \"desc\") |> limit(10)')")
          .option("--format [type]", "Output format: table, json, compact", "table")
          .action(async (queryStr: string, opts: { format?: string }) => {
            await ensureDbOpen();
            try {
              const result = await db.execDsl(queryStr);
              
              if (result.aggregate !== undefined) {
                console.log(`\n📊 Aggregate Result: ${result.aggregate}`);
                return;
              }
              
              const memories = result.nodes || [];
              if (memories.length === 0) {
                console.log("\n🔍 No memories found matching query.");
                return;
              }
              
              const format = opts.format || "table";
              console.log(`\n🔍 Found ${memories.length} memories:\n`);
              
              if (format === "json") {
                console.log(JSON.stringify(memories, null, 2));
              } else if (format === "compact") {
                memories.forEach((mem, i) => {
                  const preview = mem.content?.substring(0, 100) + (mem.content && mem.content.length > 100 ? "..." : "");
                  console.log(`${i + 1}. [${mem.category}] ${preview}`);
                });
              } else {
                // table format (default)
                memories.forEach((mem, i) => {
                  console.log(`${i + 1}. Memory ID: ${mem.id}`);
                  console.log(`   Category: ${mem.category}`);
                  if (mem.tags && mem.tags.length > 0) {
                    console.log(`   Tags: ${mem.tags.join(", ")}`);
                  }
                  if (typeof mem.importance_score === "number") {
                    console.log(`   Score: ${mem.importance_score.toFixed(3)}`);
                  }
                  const preview = mem.content?.substring(0, 150) + (mem.content && mem.content.length > 150 ? "..." : "");
                  console.log(`   Content: ${preview}`);
                  if (mem.created_at) {
                    console.log(`   Created: ${new Date(mem.created_at).toLocaleString()}`);
                  }
                  console.log();
                });
              }
            } catch (error) {
              console.error(`\n❌ Query failed: ${String(error)}`);
              console.error("Example queries:");
              console.error('  filter(category == "decision")');
              console.error('  filter(category == "decision") |> sort(by: "score", dir: "desc") |> limit(5)');
              console.error('  filter(tags.contains("rust"))');
              console.error('  aggregate(count)');
              console.error('  filter(created_at > 1640995200000) |> project(["id", "category", "text"])');
              console.error('  graph_neighbors("memory:UUID", depth: 2)');
              console.error('  auto_link()');
            }
          });

        // ── Graph sub-commands ──────────────────────────────────────────────

        const graph = slm.command("graph").description("Memory graph traversal and insight commands");

        graph.command("neighbors")
          .description("Find memories related to a given memory via graph traversal")
          .argument("<memory_id>", "Memory UUID (without 'memory:' prefix)")
          .option("--depth <n>", "Traversal depth", "2")
          .option("--min-strength <n>", "Minimum relationship strength (0.0–1.0)")
          .option("--link-types <types>", "Comma-separated list of edge relation types to filter by")
          .action(async (memoryId: string, opts: { depth: string; minStrength?: string; linkTypes?: string }) => {
            await ensureDbOpen();
            const depth = parseInt(opts.depth);
            if (Number.isNaN(depth) || depth < 1) {
              console.error("Error: depth must be a positive integer");
              return;
            }

            const minStrength = opts.minStrength !== undefined ? parseFloat(opts.minStrength) : undefined;
            if (
              minStrength !== undefined &&
              (!Number.isFinite(minStrength) || minStrength < 0.0 || minStrength > 1.0)
            ) {
              console.error("Error: min-strength must be a number between 0.0 and 1.0");
              return;
            }
            const linkTypes = opts.linkTypes ? opts.linkTypes.split(",").map((s) => s.trim()) : undefined;

            console.log(`\n🔗 Finding memories related to ${memoryId.slice(0, 8)}... (depth=${depth})\n`);

            try {
              const related = await db.findRelated(memoryId, { depth, minStrength, linkTypes });

              if (related.length === 0) {
                console.log("No related memories found.");
                return;
              }

              console.log(`Found ${related.length} related memories:\n`);
              related.forEach((m, i) => {
                console.log(`${i + 1}. [${m.category}] ${m.id.slice(0, 8)}  ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`);
              });
            } catch (err) {
              console.error(`\n❌ Graph traversal failed: ${String(err)}`);
            }
          });

        graph.command("insights")
          .description("Analyze memory relationship patterns: clusters, isolated nodes, category distribution")
          .option("--timespan <label>", "Human-readable timespan label for context (e.g. '7d', '30d')")
          .option("--type <kind>", "Focus type: 'clusters', 'isolated', or 'all' (default: all)")
          .action(async (opts: { timespan?: string; type?: string }) => {
            await ensureDbOpen();
            const focusType = opts.type ?? "all";

            console.log(`\n🔭 Memory Graph Insights${opts.timespan ? ` (${opts.timespan})` : ""}\n`);

            try {
              const insights = await db.getMemoryInsights(opts.timespan);

              console.log(`Memories : ${insights.totalMemories} total`);
              console.log(`Edges    : ${insights.totalEdges} relationships`);
              console.log(`Connected: ${insights.connectedMemories}`);
              console.log(`Isolated : ${insights.isolatedMemories}`);
              console.log();

              if (focusType === "clusters" || focusType === "all") {
                console.log(`Clusters (${insights.clusters.length}):`);
                if (insights.clusters.length === 0) {
                  console.log("  No clusters detected.");
                } else {
                  insights.clusters.slice(0, 10).forEach((c, i) => {
                    console.log(`  ${i + 1}. Size: ${c.size}, Categories: ${c.categories.join(", ")}`);
                  });
                }
                console.log();
              }

              if (focusType === "all") {
                console.log("Top categories:");
                insights.topCategories.forEach((tc) => {
                  console.log(`  ${tc.category}: ${tc.count}`);
                });
              }
            } catch (err) {
              console.error(`\n❌ Insights failed: ${String(err)}`);
            }
          });

        // ── autolink command ────────────────────────────────────────────────

        slm.command("autolink")
          .description("Trigger automatic relationship discovery between memories")
          .argument("[target]", "Memory UUID for targeted linking (requires --memory flag)")
          .option("--all", "Link all memories")
          .option("--incremental", "Link only new/recently updated memories (currently equivalent to --all; timestamp-filtered mode is reserved for a future PluresDB update)")
          .option("--memory", "Link a specific memory (provide UUID as argument)")
          .option("--algorithms <list>", "Comma-separated algorithms: semantic,category,temporal")
          .action(async (target: string | undefined, opts: { all?: boolean; incremental?: boolean; memory?: boolean; algorithms?: string }) => {
            await ensureDbOpen();

            const algos = opts.algorithms
              ? opts.algorithms.split(",").map((s) => s.trim())
              : cfg.autoLinkAlgorithms;

            let mode: "all" | "incremental" | "memory" = "incremental";
            if (opts.all) mode = "all";
            if (opts.memory) mode = "memory";

            if (mode === "memory" && !target) {
              console.error("Error: provide a memory UUID argument when using --memory");
              return;
            }

            const modeLabel = mode === "memory" ? `memory ${(target ?? "").slice(0, 8)}` : mode;
            console.log(`\n🔗 Auto-linking (${modeLabel}) using algorithms: ${algos.join(", ")}\n`);

            try {
              const result = await db.autoLink({
                algorithms: algos,
                memoryId: mode === "memory" ? target : undefined,
              });
              console.log(`✅ Created ${result.linksCreated} new memory relationship${result.linksCreated !== 1 ? "s" : ""}.`);
            } catch (err) {
              console.error(`\n❌ Auto-link failed: ${String(err)}`);
            }
          });

        slm.command("analytics")
          .description("Show memory analytics and trends")
          .option("--by-category", "Show breakdown by category")
          .option("--by-tags", "Show breakdown by tags")
          .option("--timespan [days]", "Limit to recent N days", "30")
          .action(async (opts: { byCategory?: boolean; byTags?: boolean; timespan?: string }) => {
            await ensureDbOpen();
            try {
              const days = parseInt(opts.timespan || "30");
              const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
              
              console.log(`\n📈 Memory Analytics (last ${days} days)\n`);
              
              if (opts.byCategory) {
                const result = await db.execDsl(`filter(created_at > ${cutoffTime}) |> aggregate(count, group_by: "category")`);
                console.log("📊 By Category:");
                if (typeof result.aggregate === "object" && result.aggregate !== null) {
                  Object.entries(result.aggregate as Record<string, number>).forEach(([cat, count]) => {
                    console.log(`  ${cat}: ${count}`);
                  });
                } else {
                  console.log("  No data available");
                }
                console.log();
              }
              
              if (opts.byTags) {
                const memories = await db.execDsl(`filter(created_at > ${cutoffTime} && tags.length > 0)`);
                const tagCounts = new Map<string, number>();
                (memories.nodes || []).forEach(mem => {
                  (mem.tags || []).forEach(tag => {
                    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
                  });
                });
                
                console.log("🏷️  By Tags (top 10):");
                const sortedTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
                sortedTags.forEach(([tag, count]) => {
                  console.log(`  ${tag}: ${count}`);
                });
                console.log();
              }
              
              // Basic stats
              const totalResult = await db.execDsl("aggregate(count)");
              const recentResult = await db.execDsl(`filter(created_at > ${cutoffTime}) |> aggregate(count)`);
              
              console.log("📋 Summary:");
              console.log(`  Total memories: ${totalResult.aggregate || 0}`);
              console.log(`  Recent (${days}d): ${recentResult.aggregate || 0}`);
              
            } catch (error) {
              console.error(`\n❌ Analytics failed: ${String(error)}`);
            }
          });

        if (process.env.PLURESLM_DEV) slm.command("migrate-from-files")
          .description("[dev] Import existing memory files into Plures LM")
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

                const result = await importMemories(memories, db, await getEmbeddings(), {
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

        if (process.env.PLURESLM_DEV) slm.command("verify-migration")
          .description("[dev] Verify migrated content is in the database")
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

                const verification = await verifyMigration(memories, db, await getEmbeddings(), thresholdValue);

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
      { commands: ["pluresLM"] },
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
        return {
          response: `❌ Direct indexing disabled for safety. All indexing must use the safe forked worker to prevent system instability.`,
        };
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
      id: "plureslm",
      start: async () => {
        // Auto-disable memory-core to prevent conflicts
        // Note: This requires manual configuration by user, but we warn about it
        try {
          api.logger.warn("pluresLM: If you experience gateway freezing, disable memory-core with:");
          api.logger.warn("  openclaw config set hooks.internal.entries.session-memory.enabled false");
          api.logger.warn("  openclaw gateway restart");
        } catch (err) {
          // Ignore - just a helpful warning
        }

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

        // Initialize compatibility detection and dual-mode system
        compatibilityDetector = new OpenClawCompatibilityDetector(api);
        operatingMode = await compatibilityDetector.determineOperatingMode(cfg.compatibility);
        
        api.logger.info(`pluresLM: Operating in ${operatingMode.toUpperCase()} mode`);
        
        // Initialize compatibility layer (feature gating)
        compatibilityLayer = new CompatibilityLayer(operatingMode);

        // Register memory status provider — only in enhanced mode (requires fork APIs)
        if (compatibilityLayer.shouldRegister("registerMemoryStatus") && typeof (api as any).registerMemoryStatus === "function") {
          (api as any).registerMemoryStatus(async () => {
            try {
              const stats = await db.stats();
              const totalMemories = stats?.totalMemories ?? 0;
              return {
                files: totalMemories,
                chunks: totalMemories,
                dirty: false,
                sources: ["plureslm"],
                vector: {
                  enabled: true,
                  provider: "pluresdb-native",
                  model: cfg.embeddingModel || "fastembed",
                  dimension: cfg.embeddingDimension,
                  indexed: totalMemories,
                  total: totalMemories,
                },
                fts: { enabled: false },
                cache: { enabled: true, hits: 0, misses: 0 },
                custom: {
                  backend: "pluresdb-native",
                  dbPath: resolvedDbPath,
                },
              };
            } catch (err) {
              debug(`memoryStatus provider error: ${String(err)}`);
              return null;
            }
          });
          debug("registered memoryStatus provider for openclaw status");
        }

        // Initialize smart memory management systems
        memoryMdGenerator = new MemoryMdGenerator({
          enabled: operatingMode === 'enhanced',
          intervalMinutes: operatingMode === 'enhanced' ? 30 : 60,
          priorityCategories: ["decision", "project-context", "preference", "error-fix"],
        });

        contextManager = new ContextManager(db, {
          maxContextMemories: cfg.sessionStartRecall.maxMemories,
          priorityCategories: cfg.sessionStartRecall.priorityCategories,
          recencyBias: cfg.sessionStartRecall.recencyBias,
          excludeCategories: recallExcludeSet.size > 0 ? recallExcludeSet : undefined,
        });

        // Start smart memory systems (only if self-test passed and systems initialized)
        if (selfTestErrors.length === 0) {
          try {
            // Start automatic memory.md generation
            if (memoryMdGenerator) {
              memoryMdGenerator.start(async () => {
                const allMemories = await db.listMemories();
                return allMemories;
              });
            }

            // Context manager is stateless — no start() needed
            const startedSystems = [];
            if (memoryMdGenerator) startedSystems.push("memory.md generation");
            if (contextManager) startedSystems.push("context manager");
            
            if (startedSystems.length > 0) {
              api.logger.info(`pluresLM: smart memory systems started (${startedSystems.join(" + ")})`);
            }
          } catch (err) {
            api.logger.warn(`pluresLM: failed to start smart memory systems: ${String(err)}`);
          }
        }

        // Startup consolidation — merge duplicates, demote stale memories
        if (selfTestErrors.length === 0) {
          setImmediate(async () => {
            try {
              const stats = await db.runConsolidation({ dryRun: false, stalenessDays: 30 });
              if (stats.merged > 0 || stats.demoted > 0 || stats.promoted > 0) {
                api.logger.info(`pluresLM: startup consolidation — merged ${stats.merged}, demoted ${stats.demoted}, promoted ${stats.promoted}`);
              } else {
                debug("startup consolidation: nothing to do");
              }
            } catch (err) {
              api.logger.warn(`pluresLM: startup consolidation failed: ${String(err)}`);
            }
          });
        }

        // Start Hyperswarm sync (optional)
        if (cfg.syncEnabled && cfg.syncKey) {
          sync = new MemorySync(db, { key: cfg.syncKey, debug: cfg.debug });
          sync.on("sync:error", (err: unknown) => {
            api.logger.warn(`pluresLM: sync error: ${String(err)}`);
          });
          sync.start().catch((err: unknown) => {
            api.logger.warn(`pluresLM: failed to start sync: ${String(err)}`);
            sync = null;
          });
        }

        // Index project context files on start if configured
        // IMPORTANT: do this in a forked worker to avoid blocking the gateway event loop.
        if (cfg.projectIndexOnStart && cfg.projectContextPaths.length > 0) {
          debug("starting forked project context indexing on start...");
          try {
            startProjectIndexingForked(cfg.projectContextPaths);
          } catch (err) {
            api.logger.warn(`pluresLM: failed to start forked project indexing: ${String(err)}`);
          }
        }
      },
      stop: async () => {
        patternEngine.stopWatching();
        
        // Stop smart memory systems
        try {
          if (memoryMdGenerator) {
            memoryMdGenerator.stop();
          }
          // ContextManager is stateless — no stop() needed
        } catch (err) {
          api.logger.warn(`pluresLM: error stopping smart memory systems: ${String(err)}`);
        }
        
        try {
          void sync?.stop();
        } catch {
          // ignore
        } finally {
          sync = null;
        }
        await db.close();
        ingestState.db = null;
        ingestState.embedText = null;
        api.logger.info("pluresLM: stopped");
      },
    });
  },
};

export default pluresLM;

// ============================================================================
// Public document ingestion API
// ============================================================================

const DOCUMENT_SOURCE_PREFIX = "document:";

/**
 * Process and store a document into PluresDB.
 *
 * Uses DocumentProcessor to extract metadata and split the text into semantic
 * chunks. The parent document entry is stored with category "document" and
 * each chunk with category "document-chunk". Both share a common source tag
 * (`document:<documentId>`) so they can be bulk-deleted together.
 *
 * @returns The stable `documentId` and the list of `chunkIds` assigned by PluresDB.
 */
export async function pluresLM_ingest_document(
  text: string,
  metadata: DocumentMetadata,
): Promise<{ documentId: string; chunkIds: string[] }> {
  if (!ingestState.db || !ingestState.embedText) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const db = ingestState.db;
  const embedText = ingestState.embedText;

  const processor = new DocumentProcessor();
  const processed = await processor.processDocument(text, metadata);

  const documentId = randomUUID();
  const sourceTag = `${DOCUMENT_SOURCE_PREFIX}${documentId}`;

  // Encode DocumentMetadata fields as meta:<key>:<value> tags (matches storeContent convention)
  const metaTags = Object.entries(metadata)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `meta:${k}:${String(v)}`);

  // Store parent document entry with its embedding.
  // dedupeThreshold > 1 is unreachable (cosine similarity max is 1.0), so this call
  // always creates a new entry and never silently merges with another document's entry.
  const docEmbedding = await embedText(processed.summary || text.slice(0, 500));
  await db.store(processed.summary || text.slice(0, 500), docEmbedding, {
    source: sourceTag,
    category: "document",
    tags: [
      `doc-title:${processed.title}`,
      ...processed.keyTopics.map((t) => `topic:${t}`),
      ...metaTags,
    ],
    dedupeThreshold: 2,
  });

  // Store each chunk with its embedding so they are semantically searchable.
  // dedupeThreshold > 1 ensures chunks are never merged with the parent document entry
  // (which could share identical content for single-paragraph documents).
  const chunkIds: string[] = [];
  for (const chunk of processed.chunks) {
    const chunkEmbedding = await embedText(chunk.text);
    const chunkResult = await db.store(chunk.text, chunkEmbedding, {
      source: sourceTag,
      category: "document-chunk",
      tags: [
        `doc-title:${processed.title}`,
        `chunk-index:${chunk.chunkIndex}`,
        ...chunk.topics.map((t) => `topic:${t}`),
        ...metaTags,
      ],
      dedupeThreshold: 2,
    });
    chunkIds.push(chunkResult.entry.id);
  }

  return { documentId, chunkIds };
}

/**
 * List all ingested documents (top-level document entries, not chunks).
 *
 * Reconstructs DocumentSource objects from stored memory entries by reading
 * the `doc-title:*` tag and counting chunks that share the same source tag.
 */
export async function pluresLM_list_sources(): Promise<DocumentSource[]> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const db = ingestState.db;
  const all = await db.listMemories();
  const docEntries = all.filter((e) => e.category === "document" && e.source?.startsWith(DOCUMENT_SOURCE_PREFIX));

  // Pre-build chunk counts in a single O(n) pass to avoid O(n×m) in the map below.
  const chunkCountBySource = new Map<string, number>();
  for (const e of all) {
    if (e.category === "document-chunk" && e.source?.startsWith(DOCUMENT_SOURCE_PREFIX)) {
      chunkCountBySource.set(e.source, (chunkCountBySource.get(e.source) ?? 0) + 1);
    }
  }

  return docEntries.map((entry) => {
    const sourceTag = entry.source;
    const chunkCount = chunkCountBySource.get(sourceTag) ?? 0;

    const titleTag = entry.tags.find((t) => t.startsWith("doc-title:"));
    const title = titleTag ? titleTag.slice("doc-title:".length) : "Untitled Document";

    const keyTopics = entry.tags
      .filter((t) => t.startsWith("topic:"))
      .map((t) => t.slice("topic:".length));

    // Decode metadata from meta:<key>:<value> tags
    const metadata: DocumentMetadata = {};
    for (const tag of entry.tags) {
      if (tag.startsWith("meta:")) {
        const rest = tag.slice("meta:".length);
        const colonIdx = rest.indexOf(":");
        if (colonIdx !== -1) {
          const key = rest.slice(0, colonIdx) as keyof DocumentMetadata;
          const value = rest.slice(colonIdx + 1);
          let parsedValue: unknown = value;
          if (key === "word_count") {
            parsedValue = Number(value);
          }
          (metadata as Record<string, unknown>)[key] = parsedValue;
        }
      }
    }

    return {
      id: sourceTag.slice(DOCUMENT_SOURCE_PREFIX.length),
      title,
      summary: entry.content,
      keyTopics,
      metadata,
      chunkCount,
      createdAt: entry.created_at,
    };
  });
}

/**
 * Delete a document and all its chunks from PluresDB.
 *
 * Uses the shared `document:<sourceId>` source tag to bulk-delete all
 * entries (parent document + every chunk) in a single operation.
 */
export async function pluresLM_delete_source(sourceId: string): Promise<void> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  await ingestState.db.deleteBySource(`${DOCUMENT_SOURCE_PREFIX}${sourceId}`);
}

// ============================================================================
// Training data export APIs
// ============================================================================

/** Default confidence score used when a memory has no explicit confidence value. */
const DEFAULT_TRAINING_CONFIDENCE = 0.5;
/** Outcome score for `partial` outcomes. */
const PARTIAL_OUTCOME_SCORE = 0.5;
/** Outcome score for `unknown` or unset outcomes. */
const UNKNOWN_OUTCOME_SCORE = 0.5;

/**
 * Backfill the outcome for an existing memory entry.
 *
 * Sets `outcome`, `outcome_evidence`, and `outcome_timestamp` on the stored
 * entry so that it can be included in future training exports.
 *
 * @returns `true` if the entry was found and updated, `false` if not found.
 */
export async function pluresLM_record_outcome(
  memoryId: string,
  outcome: MemoryOutcome,
  evidence?: string,
): Promise<boolean> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }
  return ingestState.db.updateOutcome(memoryId, outcome, evidence);
}

/**
 * Export training-ready memories as a JSONL string.
 *
 * Formats:
 * - `sft`  — `{messages: [{role, content}...]}` (OpenAI fine-tune format).
 *             Only memories that have a `conversation_window` are included.
 * - `dpo`  — `{prompt, chosen, rejected}` (DPO format).
 *             Only memories with both `chosen_approach` and `rejected_approach` are included.
 * - `rlhf` — `{prompt, response, reward}` where `reward = confidence × outcome_score`.
 *             All memories that pass the `min_confidence` filter are included; for `partial`, `unknown`, or unset outcomes, `reward` defaults to `confidence × 0.5`.
 *
 * @param format        One of `"sft"`, `"dpo"`, or `"rlhf"`.
 * @param min_confidence Only include memories with `confidence >= min_confidence`.
 *                       Memories without a confidence score are excluded when this is set.
 * @returns JSONL string (one JSON object per line).
 */
export async function pluresLM_export_training(
  format: TrainingFormat,
  min_confidence?: number,
): Promise<string> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const memories = await ingestState.db.listMemories();

  const records: unknown[] = [];

  for (const m of memories) {
    // Filter by min_confidence: skip entries where confidence is not set or below threshold
    if (min_confidence !== undefined && (m.confidence == null || m.confidence < min_confidence)) {
      continue;
    }

    switch (format) {
      case "sft": {
        if (!m.conversation_window || m.conversation_window.length === 0) break;
        records.push({
          messages: m.conversation_window.map((e) => ({ role: e.role, content: e.content })),
        });
        break;
      }
      case "dpo": {
        if (!m.chosen_approach || !m.rejected_approach) break;
        const prompt = m.conversation_window?.[0]?.content ?? m.content;
        records.push({ prompt, chosen: m.chosen_approach, rejected: m.rejected_approach });
        break;
      }
      case "rlhf": {
        const prompt = m.conversation_window?.[0]?.content ?? m.content;
        const response = m.chosen_approach ?? m.content;
        const outcomeScore =
          m.outcome === "success" ? 1.0
          : m.outcome === "partial" ? PARTIAL_OUTCOME_SCORE
          : m.outcome === "failure" ? 0.0
          : UNKNOWN_OUTCOME_SCORE;
        const reward = (m.confidence ?? DEFAULT_TRAINING_CONFIDENCE) * outcomeScore;
        records.push({ prompt, response, reward });
        break;
      }
    }
  }

  return records.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * Return aggregate metrics about the training-ready memories in the store.
 */
export async function pluresLM_get_training_stats(): Promise<TrainingStats> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const memories = await ingestState.db.listMemories();

  let with_outcome = 0;
  let with_confidence = 0;
  let with_conversation_window = 0;
  let with_chosen_rejected = 0;
  let confidence_sum = 0;
  let confidence_count = 0;
  const outcome_distribution: Record<string, number> = {};

  for (const m of memories) {
    if (m.outcome != null) {
      with_outcome++;
      outcome_distribution[m.outcome] = (outcome_distribution[m.outcome] ?? 0) + 1;
    }
    if (m.confidence != null) {
      with_confidence++;
      confidence_sum += m.confidence;
      confidence_count++;
    }
    if (m.conversation_window && m.conversation_window.length > 0) {
      with_conversation_window++;
    }
    if (m.chosen_approach && m.rejected_approach) {
      with_chosen_rejected++;
    }
  }

  return {
    total: memories.length,
    with_outcome,
    with_confidence,
    with_conversation_window,
    with_chosen_rejected,
    outcome_distribution,
    avg_confidence: confidence_count > 0 ? confidence_sum / confidence_count : null,
  };
}

// ============================================================================
// Classifier signal pipeline — optimizer training-data export and evaluation
// ============================================================================

/**
 * Export a classifier-ready signal dataset from the active memory store.
 *
 * Extracts deterministic feature vectors and quality assessments from every
 * qualifying MemoryEntry, then serialises passing signals as JSONL.
 *
 * Signal payloads carry a `schema_version` field (currently
 * `CLASSIFIER_SIGNAL_SCHEMA_VERSION`) so that pares-agens can detect breaking
 * schema changes without inspecting field names.
 *
 * @param options  Quality-gate and export options.  See {@link ClassifierExportOptions}.
 * @returns        JSONL string — one {@link ClassifierSignal} JSON object per line.
 *                 Returns an empty string when no signals pass the quality gate.
 */
export async function pluresLM_export_classifier_signals(
  options: ClassifierExportOptions = {},
): Promise<string> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }
  const memories = await ingestState.db.listMemories();
  const signals = extractClassifierSignals(memories, options);
  return signalsToJsonl(signals);
}

/**
 * Generate a {@link ClassifierEvalReport} for the current memory store.
 *
 * The report includes:
 * - Label distribution over outcome classes
 * - Per-class and macro-averaged precision / recall / F1 (self-consistency check)
 * - Quality-gate statistics (noise / duplicate / category failures)
 * - Jensen-Shannon drift score vs an optional reference batch of signals
 *
 * @param options           Options forwarded to {@link extractClassifierSignals}.
 * @param referenceSignals  An earlier signal batch used for drift detection.
 *                          Pass the output of a previous `pluresLM_export_classifier_signals`
 *                          call (after JSON-parsing each line) to track distribution shift.
 * @returns                 A versioned {@link ClassifierEvalReport}.
 */
export async function pluresLM_eval_classifier(
  options: ClassifierExportOptions = {},
  referenceSignals?: ClassifierSignal[],
): Promise<ClassifierEvalReport> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }
  const memories = await ingestState.db.listMemories();
  const signals = extractClassifierSignals(memories, options);
  return generateEvalReport(signals, referenceSignals);
}

// ============================================================================
// Tiered memory storage — archive, bundle export/restore, attach/detach
// ============================================================================

/**
 * Classify all memories in the active store into hot / warm / cold tiers
 * according to the given archive policy.
 *
 * This is a read-only operation: no entries are moved or deleted.
 * Use the returned lists as input to `pluresLM_export_bundle` and
 * `pluresLM_detach_module` to act on the classification.
 *
 * @param policy Override the default archive policy thresholds.
 * @returns Three lists of memories grouped by their evaluated tier.
 */
export async function pluresLM_classify_memories(
  policy?: Partial<ArchivePolicy>,
): Promise<ClassifyResult> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const memories = await ingestState.db.listMemories();
  const effectivePolicy = { ...DEFAULT_ARCHIVE_POLICY, ...policy };
  return _archive.classifyMemories(memories, effectivePolicy);
}

/**
 * Export a subset of memories (identified by ID) as a portable cold-tier
 * `ArchiveBundle`.
 *
 * The bundle contains per-entry SHA-256 checksums and a bundle-level
 * checksum in the manifest so that corruption can be detected during
 * restore. Live embedding vectors are stripped to keep the bundle compact.
 *
 * This is a read-only export — the memories remain in the active store.
 * To remove them from hot storage after export, call `pluresLM_detach_module`.
 *
 * **Performance note:** This function loads all memories from the store via a
 * full scan and filters client-side to preserve `last_accessed_at` and other
 * fields that `getMemoriesByIds()` silently drops. For very large stores,
 * callers exporting small bundles will pay an O(N) cost proportional to the
 * total number of memories. A future fix to the underlying
 * `nodeToEntryNoEmbedding` method will eliminate this trade-off.
 *
 * @param memoryIds IDs of the memories to include in the bundle.
 * @param moduleId  Optional stable label (task / project / context).
 * @returns The `ArchiveBundle` ready for serialisation / cold storage.
 */
export async function pluresLM_export_bundle(
  memoryIds: string[],
  moduleId?: string,
): Promise<ArchiveBundle> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  // Use listMemories() so we preserve full metadata (including last_accessed_at)
  // rather than the reduced view returned by getMemoriesByIds().
  const allMemories = await ingestState.db.listMemories();
  const idSet = new Set(memoryIds);
  const selected = allMemories.filter((memory) => idSet.has(memory.id));
  return _archive.exportBundle(selected, moduleId);
}

/**
 * Restore memories from an `ArchiveBundle` into the active store.
 *
 * Integrity is verified at two levels before any entry is written:
 * 1. Bundle-level checksum — if this fails the entire bundle is rejected.
 * 2. Per-entry checksum  — corrupted entries are skipped and recorded in
 *    `result.corrupted`; no silent corruption.
 *
 * @param bundle The bundle produced by `pluresLM_export_bundle` or
 *               `pluresLM_detach_module`.
 * @returns A `RestoreResult` summarising what was restored or found corrupted.
 */
export async function pluresLM_restore_bundle(
  bundle: ArchiveBundle,
): Promise<RestoreResult> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const { entries, result } = _archive.restoreBundle(bundle);

  for (const entry of entries) {
    // Use the raw store path so that entries are restored with the richest
    // metadata that the backend persists for new records. Note that some
    // fields (e.g. importance scores, access counts, tiers, and certain
    // training-related fields) may be recomputed or reset to backend defaults
    // during insertion and are not guaranteed to round-trip losslessly.
    await ingestState.db.storeRaw(entry);
  }

  return result;
}

/**
 * Remove a group of memories from the active store and save them as a named
 * cold-tier module.
 *
 * The module can later be re-attached with `pluresLM_attach_module`. Memories
 * that have been detached will not appear in recall / vector-search results
 * until re-attached.
 *
 * @param memoryIds IDs of the memories to move to cold storage.
 * @param moduleId  Stable identifier for the module.
 * @returns The `ArchiveBundle` created for this module.
 */
export async function pluresLM_detach_module(
  memoryIds: string[],
  moduleId: string,
): Promise<ArchiveBundle> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  // Use listMemories() + filter to ensure we detach entries with the full
  // metadata representation, mirroring pluresLM_export_bundle. Using
  // getMemoriesByIds() would go through nodeToEntryNoEmbedding and drop
  // fields like last_accessed_at, merge_count, and conversation_tag_ids,
  // which would then be lost on a detach → attach round-trip.
  const allMemories = await ingestState.db.listMemories();
  const idSet = new Set(memoryIds);
  const selected = allMemories.filter((memory) => idSet.has(memory.id));

  const bundle = _archive.detach(selected, moduleId);

  // Remove from active store
  for (const id of memoryIds) {
    await ingestState.db.delete(id);
  }

  return bundle;
}

/**
 * Re-attach a previously-detached module into the active store.
 *
 * If a `bundle` is provided it is registered under `moduleId` before
 * attaching — this is the entry point for bundles loaded from disk or
 * received over the network. When no `bundle` is given the module must
 * have been registered by a prior call to `pluresLM_detach_module`.
 *
 * The module is removed from the registry after a successful attach to
 * prevent accidental double-attachment.
 *
 * @param moduleId Identifier of the module to attach.
 * @param bundle   Optional bundle to register first (e.g. loaded from disk).
 * @returns A `RestoreResult` summarising what was restored or found corrupted;
 *          or `null` if the module is not found.
 */
export async function pluresLM_attach_module(
  moduleId: string,
  bundle?: ArchiveBundle,
): Promise<RestoreResult | null> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  if (bundle) {
    _archive.registerBundle(bundle, moduleId);
  }

  const attachment = _archive.attach(moduleId);
  if (!attachment) return null;

  const { entries, result } = attachment;
  for (const entry of entries) {
    await ingestState.db.storeRaw(entry);
  }

  // Only drop the module from the registry when the restore is fully clean.
  // If any entries were corrupted the module stays registered so the caller
  // can inspect the result and retry after supplying a clean bundle.
  if (result.corrupted.length === 0) {
    _archive.dropModule(moduleId);
  }

  return result;
}

// ============================================================================
// Memory Module Packs — create, sign, import, verify, uninstall
// ============================================================================

/**
 * Create a portable `MemoryPack` from a set of memories in the active store.
 *
 * The pack bundles the entries with per-entry and bundle-level SHA-256
 * checksums and attaches provenance and embedding-model metadata so importers
 * can check compatibility before installing.
 *
 * Optionally sign the pack immediately by supplying a `signingKey`; this adds
 * an HMAC-SHA256 `signature` field callers can verify with
 * `pluresLM_verify_pack`.
 *
 * This is a **read-only** operation — memories remain in the active store.
 * To distribute the pack, serialise the returned object as JSON.
 *
 * @param memoryIds    IDs of the memories to include.
 * @param provenance   Human-readable pack metadata (name, author, licence…).
 * @param embeddingMeta Embedding model metadata for compatibility checks.
 * @param opts.moduleId   Optional stable module identifier (defaults to a UUID).
 * @param opts.signingKey Optional HMAC key to sign the pack immediately.
 */
export async function pluresLM_export_pack(
  memoryIds: string[],
  provenance: Omit<PackProvenance, "createdAt">,
  embeddingMeta: PackEmbeddingMeta,
  opts: { moduleId?: string; signingKey?: string } = {},
): Promise<MemoryPack> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const moduleId = opts.moduleId ?? `pack-${randomUUID()}`;
  const bundle = await pluresLM_export_bundle(memoryIds, moduleId);

  const fullProvenance: PackProvenance = {
    ...provenance,
    createdAt: new Date().toISOString(),
  };

  let pack: MemoryPack = {
    packVersion: "1",
    bundle,
    provenance: fullProvenance,
    embeddingMeta,
  };

  if (opts.signingKey) {
    pack = signPack(pack, opts.signingKey);
  }

  return pack;
}

/**
 * Verify the HMAC-SHA256 signature on a `MemoryPack`.
 *
 * @param pack       The pack to verify (received from an external source).
 * @param signingKey The shared secret used when the pack was signed.
 * @returns `true` when the signature is valid; `false` when absent, malformed,
 *          or computed with a different key.
 */
export function pluresLM_verify_pack(pack: MemoryPack, signingKey: string): boolean {
  return verifyPackSignature(pack, signingKey);
}

/**
 * Import a `MemoryPack` into the active store.
 *
 * Steps performed:
 * 1. **Compatibility check** — compares the pack's `embeddingMeta.modelName`
 *    against `opts.currentModelName`; adds a warning if they differ (import
 *    still proceeds unless `opts.requireCompatibleModel` is `true`).
 * 2. **Signature verification** — if `opts.signingKey` is provided the pack
 *    signature is checked; an unsigned or invalid pack adds a warning (or
 *    throws when `opts.requireSignature` is `true`).
 * 3. **Bundle restore** — entries are verified at bundle and per-entry level
 *    before insertion into the store.
 * 4. **Registry** — the pack is recorded in the installed-pack registry so
 *    provenance is visible via `pluresLM_list_packs` and can be rolled back
 *    with `pluresLM_uninstall_pack`.
 *
 * @param pack The pack to import.
 * @param opts Import options.
 * @returns A `PackImportResult` that includes the restore summary, provenance,
 *          compatibility flag, and any non-fatal warnings.
 */
export async function pluresLM_import_pack(
  pack: MemoryPack,
  opts: {
    /** Model currently used by this deployment — used for compatibility check. */
    currentModelName?: string;
    /**
     * Embedding vector dimensions currently in use.
     * A dimension mismatch marks the pack incompatible (vector search would
     * produce incorrect results), and throws when `requireCompatibleModel` is set.
     */
    currentDimensions?: number;
    /**
     * Optional model version tag currently in use.
     * A version mismatch adds a non-fatal warning but does not mark the pack
     * incompatible.
     */
    currentModelVersion?: string;
    /** Shared signing key — triggers signature verification when provided. */
    signingKey?: string;
    /** Throw if the pack's embedding model does not match `currentModelName`. */
    requireCompatibleModel?: boolean;
    /** Throw if the pack has no valid signature (requires `signingKey`). */
    requireSignature?: boolean;
  } = {},
): Promise<PackImportResult> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  const warnings: string[] = [];

  // ── 1. Compatibility check ────────────────────────────────────────────────
  const { compatible, warnings: compatWarnings } = checkPackCompatibility(
    pack,
    opts.currentModelName,
    opts.currentDimensions,
    opts.currentModelVersion,
  );
  warnings.push(...compatWarnings);
  if (!compatible && opts.requireCompatibleModel) {
    throw new Error(warnings[warnings.length - 1]);
  }

  // ── 2. Signature verification ─────────────────────────────────────────────
  if (opts.signingKey) {
    if (!pack.signature) {
      const msg = "Pack does not have a signature — provenance cannot be cryptographically verified.";
      if (opts.requireSignature) throw new Error(msg);
      warnings.push(msg);
    } else {
      const valid = verifyPackSignature(pack, opts.signingKey);
      if (!valid) {
        const msg = "Pack signature verification failed — the pack may have been tampered with.";
        if (opts.requireSignature) throw new Error(msg);
        warnings.push(msg);
      }
    }
  } else if (opts.requireSignature) {
    if (!pack.signature) {
      throw new Error("Pack does not have a signature and requireSignature is true.");
    } else {
      throw new Error(
        "Cannot verify pack signature because opts.signingKey was not provided while requireSignature is true.",
      );
    }
  } else if (!pack.signature) {
    warnings.push("Pack is unsigned — provenance cannot be cryptographically verified.");
  }

  // ── 3. Bundle restore ─────────────────────────────────────────────────────
  const moduleId = pack.bundle.manifest.moduleId ?? `pack-${randomUUID()}`;
  const restoreResult = await pluresLM_restore_bundle(pack.bundle);

  // ── 4. Registry ───────────────────────────────────────────────────────────
  // Only register when at least one entry was restored. A fully-corrupted
  // bundle should not appear as "installed" in the pack registry.
  if (restoreResult.restored > 0) {
    _packRegistry.register(moduleId, pack, restoreResult.restored);
  } else {
    warnings.push(
      "Pack bundle did not restore any entries and was not registered in the installed-pack registry.",
    );
  }

  return {
    ...restoreResult,
    provenance: pack.provenance,
    embeddingCompatible: compatible,
    warnings,
  };
}

/**
 * Uninstall a previously-imported memory pack (safe rollback).
 *
 * All entries that were part of the pack are removed from the active store
 * and the pack is dropped from the installed-pack registry.
 *
 * If the pack's entries were modified after import (merges, additions) only
 * the original entry IDs listed in the pack bundle are removed.
 *
 * @param moduleId The pack's module identifier (from `InstalledPackInfo.moduleId`).
 * @returns A `RestoreResult`-shaped object reporting how many entries were
 *          removed; or `null` if the pack is not found in the registry.
 */
export async function pluresLM_uninstall_pack(
  moduleId: string,
): Promise<{ removed: number; notFound: string[] } | null> {
  if (!ingestState.db) {
    throw new Error("pluresLM is not initialised - call this function after the plugin has started");
  }

  // Look up the bundle without unregistering first. If any deletion fails due
  // to a transient backend error the registry entry is preserved and the caller
  // can safely retry. We only unregister once all deletions have completed.
  const bundle = _packRegistry.getBundle(moduleId);
  if (!bundle) return null;

  const entryIds = bundle.entries.map((e) => e.id);
  let removed = 0;
  const notFound: string[] = [];

  // Batch-fetch all entries in one query so we can distinguish truly-absent IDs
  // from ones that exist in the store. PluresDBBackend.delete() always returns
  // true and never throws for missing IDs, so we rely on this check for accurate
  // removed/notFound counts.
  const existingEntries = await ingestState.db.getMemoriesByIds(entryIds);
  const existingIds = new Set(existingEntries.map((e) => e.id));

  for (const id of entryIds) {
    if (!existingIds.has(id)) {
      notFound.push(id);
      continue;
    }

    await ingestState.db.delete(id);
    removed++;
  }

  // Unregister only after all deletions have completed successfully so the
  // bundle stays available for a retry if the loop exits early (e.g. thrown).
  _packRegistry.unregister(moduleId);

  return { removed, notFound };
}

/**
 * Return provenance information for all installed (imported) memory packs.
 *
 * Use this to surface pack metadata in a UI or API response, and to get the
 * `moduleId` needed to call `pluresLM_uninstall_pack`.
 */
export function pluresLM_list_packs(): InstalledPackInfo[] {
  return _packRegistry.list();
}
