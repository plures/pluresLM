/**
 * PluresLM Plugin for OpenClaw
 *
 * Lightweight plugin that delegates ALL memory operations to the pluresLM-mcp
 * daemon via HTTP Streamable MCP transport. The plugin owns zero state — it is
 * a thin adapter between OpenClaw's plugin SDK and the MCP service.
 *
 * Architecture:
 *   OpenClaw ←→ Plugin (tool registration + lifecycle hooks) ←→ pluresLM-mcp daemon
 *
 * The plugin handles:
 *   - Tool registration (schema + dispatch to MCP)
 *   - Auto-recall (before_agent_start → MCP search)
 *   - Auto-capture (agent_end → MCP store)
 *   - Compaction snapshots (before_compaction → MCP store)
 *   - YAML pattern engine (in-process, no DB)
 *   - Lightweight text classification (category detection, tag extraction)
 *
 * The plugin does NOT:
 *   - Open or manage any database
 *   - Generate or store embeddings
 *   - Maintain profiles, sync state, or indexes
 *   - Fork child processes
 */

import { Type } from "@sinclair/typebox";
import { callPluresLMServiceToolHttp } from "./http-service-client.js";
import { PatternEngine } from "./patterns.js";
import { DEFAULT_CAPTURE_QUALITY_CONFIG, shouldCapture, type CaptureQualityConfig } from "./capture-quality.js";
import { PraxisRegistry } from "@plures/praxis";
import {
  autoCaptureModule,
  type AutoCaptureContext,
} from "./praxis/index.js";
import {
  enqueueAnalysis,
  setArtifactStore,
  setErrorLogger,
  ALLOWED_ANALYSIS_FACT_TAGS,
  type AnalysisBatch,
  type AnalysisArtifact,
} from "./analysis-worker.js";
import type { AnalysisPrimitive, PrimitiveKind } from "./praxis/index.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Authorization Gate Types & Helpers
// ============================================================================

interface PendingAction {
  id: string;
  procedure: string;
  actionType: string;
  instruction: string;
  message: string; // full context for subagent
  createdAt: number;
}

const PENDING_ACTIONS_PATH = path.join(
  process.env.HOME || "/tmp",
  ".openclaw/workspace/memory/pending-actions.json"
);

function readPendingActions(): Record<string, PendingAction> {
  try {
    if (fs.existsSync(PENDING_ACTIONS_PATH)) {
      return JSON.parse(fs.readFileSync(PENDING_ACTIONS_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function writePendingActions(actions: Record<string, PendingAction>): void {
  const dir = path.dirname(PENDING_ACTIONS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PENDING_ACTIONS_PATH, JSON.stringify(actions, null, 2));
}

function addPendingAction(action: PendingAction): void {
  const actions = readPendingActions();
  actions[action.id] = action;
  writePendingActions(actions);
}

function removePendingAction(id: string): PendingAction | null {
  const actions = readPendingActions();
  const action = actions[id] ?? null;
  if (action) {
    delete actions[id];
    writePendingActions(actions);
  }
  return action;
}

/** Check if an instruction would violate any hard constraints stored in PluresLM. */
async function checkHardConstraints(instruction: string): Promise<string | null> {
  try {
    const result: any = await callPluresLMServiceToolHttp("pluresLM_search", {
      query: "hard constraint NEVER hard-rule",
      limit: 10,
    });
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    const memories = parsed.memories || parsed.results || [];
    const lowerInstruction = instruction.toLowerCase();
    for (const mem of memories) {
      const content = (mem.content || mem.text || mem.fact || "").toLowerCase();
      // Check if the constraint contains "NEVER" and the instruction might violate it
      if (content.includes("never")) {
        // Extract what should NEVER happen
        const neverMatch = content.match(/never\s+(.{10,80})/i);
        if (neverMatch) {
          const forbidden = neverMatch[1].toLowerCase();
          // Simple keyword overlap check
          const keywords = forbidden.split(/\s+/).filter((w: string) => w.length > 3);
          const matchCount = keywords.filter((k: string) => lowerInstruction.includes(k)).length;
          if (matchCount >= 2) {
            return `Constraint: "${(mem.content || mem.text || mem.fact || "").slice(0, 200)}"`;
          }
        }
      }
    }
    return null;
  } catch {
    // If we can't check constraints, don't block
    return null;
  }
}

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallResults: number;
  debug: boolean;

  /** Agent identity for multi-agent coordination */
  agentId: string;
  agentName: string;

  /** Session-start context injection */
  sessionStartRecall: {
    enabled: boolean;
    maxMemories: number;
  };

  /** Categories excluded from auto-recall injection */
  recallExcludeCategories: string[];

  /** Additional directories to scan for user .yml pattern files */
  patternsDirs: string[];
  /** Whether to hot-reload pattern YAML files when they change */
  patternsWatch: boolean;

  /** Capture quality gate configuration */
  captureQuality: CaptureQualityConfig;

  /**
   * Fraction of the model's context window (in chars) to budget for memory
   * injection. Default 0.25 (25%). Applied to modelContextChars = contextWindow * 4.
   */
  contextBudgetFraction: number;
  /** Hard floor: never inject fewer than this many chars. Default 5_000. */
  minContextChars: number;
  /** Hard ceiling: never inject more than this many chars. Default 150_000. */
  maxContextChars: number;
}

const DEFAULTS: PluginConfig = {
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  debug: false,
  agentId: "",
  agentName: "",
  sessionStartRecall: {
    enabled: true,
    maxMemories: 15,
  },
  recallExcludeCategories: ["project-context"],
  patternsDirs: [],
  patternsWatch: true,
  captureQuality: DEFAULT_CAPTURE_QUALITY_CONFIG,
  contextBudgetFraction: 0.25,
  minContextChars: 5_000,
  maxContextChars: 150_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ============================================================================
// Praxis — auto-capture registry (created once, shared across events)
// ============================================================================

const _captureRegistry = new PraxisRegistry<AutoCaptureContext>();
_captureRegistry.registerModule(autoCaptureModule);
// ============================================================================
// Dedup cache — prevents auto-capture from storing the same content twice
// ============================================================================

const recentCaptureHashes = new Set<string>();
const DEDUP_CACHE_MAX = 500;

function contentHash(text: string): string {
  // Simple djb2 hash — fast, good enough for dedup
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function isDuplicateCapture(text: string): boolean {
  const h = contentHash(text);
  if (recentCaptureHashes.has(h)) return true;
  recentCaptureHashes.add(h);
  if (recentCaptureHashes.size > DEDUP_CACHE_MAX) {
    // Evict oldest entries (Set preserves insertion order)
    const it = recentCaptureHashes.values();
    for (let i = 0; i < 100; i++) it.next();
    // Simpler: just clear and re-add recent
    const arr = [...recentCaptureHashes];
    recentCaptureHashes.clear();
    for (const v of arr.slice(-400)) recentCaptureHashes.add(v);
  }
  return false;
}

// Text helpers — lightweight, no DB
// ============================================================================

type TextBlock = { type: "text"; text: string };

function isTextBlock(value: unknown): value is TextBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string";
}

/**
 * Compute the effective context budget (in chars) for memory injection.
 *
 * Formula: `floor(contextWindow * 4 * fraction)`, clamped to [min, max].
 *
 * @param contextWindow - Model context window in tokens (e.g. 128_000).
 *   Falls back to 200_000 when undefined or 0.
 * @param fraction - Budget fraction, default 0.25 (25% of context).
 * @param min - Hard floor in chars, default 5_000.
 * @param max - Hard ceiling in chars, default 150_000.
 */
export function computeContextBudget(
  contextWindow: number | undefined,
  fraction = 0.25,
  min = 5_000,
  max = 150_000,
): number {
  // Normalize context window: require finite, positive number; otherwise use default.
  const tokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : 200_000;

  // Normalize fraction: must be finite and >= 0; otherwise fall back to default.
  const normalizedFraction = Number.isFinite(fraction) ? fraction : 0.25;
  const safeFraction = normalizedFraction < 0 ? 0 : normalizedFraction;

  // Normalize min/max: require finite; otherwise fall back to defaults.
  let safeMin = Number.isFinite(min) ? min : 5_000;
  let safeMax = Number.isFinite(max) ? max : 150_000;

  // Ensure ordering: max >= min.
  if (safeMax < safeMin) {
    const tmp = safeMin;
    safeMin = safeMax;
    safeMax = tmp;
  }

  const rawBudget = tokens * 4 * safeFraction;
  const budget = Number.isFinite(rawBudget) ? Math.floor(rawBudget) : safeMin;

  return Math.max(safeMin, Math.min(safeMax, budget));
}

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
  if (/\b(?:i prefer|i like|i love|i hate|i don't like|my favorite|i'd rather)\b/i.test(lower)) return "preference";
  if (/\b(?:we decided|i decided|decision:|will use|let's use|going with)\b/i.test(lower)) return "decision";
  if (/\b(?:todo|fixme|hack|next step|blocker|in progress|wip)\b/i.test(lower)) return "work-in-progress";
  if (/\b(?:error:|exception|stack trace|failed|crash|bug)\b/i.test(lower)) return "error-fix";
  if (/```[\s\S]{20,}```/m.test(text)) return "code-pattern";
  return "conversation";
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const techMatches = text.match(
    /\b(typescript|python|rust|react|node|docker|git|graphql|postgres|redis|nextjs|svelte|vue|angular|bicep|powershell|azure|terraform|kubernetes|helm|ansible)\b/gi,
  );
  if (techMatches) {
    const seen = new Set<string>();
    for (const t of techMatches) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(key);
      }
    }
  }
  return tags;
}

function containsImportantContext(line: string): boolean {
  return /\b(decided|decision|prefer|rule|always|never|must|important|critical|remember|note:)\b/i.test(line);
}

/**
 * Compact recall results into dense JSONL format for token efficiency.
 * Converts verbose search JSON into one-line-per-memory assertions.
 * ~3x more facts per token compared to raw JSON with embeddings/metadata.
 */
function compactRecallResults(raw: unknown): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const results = parsed?.results ?? parsed;
    if (!Array.isArray(results) || results.length === 0) return String(raw);
    
    const lines = results.map((r: Record<string, unknown>) => {
      const entry: Record<string, unknown> = { fact: r.content };
      if (r.category && r.category !== "conversation") entry.cat = r.category;
      if (r.score && typeof r.score === "number") entry.score = Math.round((r.score as number) * 1000) / 1000;
      if (Array.isArray(r.tags) && (r.tags as string[]).length > 0) entry.tags = r.tags;
      if (r.created_at) {
        const d = new Date(r.created_at as number);
        if (!isNaN(d.getTime())) entry.when = d.toISOString().slice(0, 10);
      }
      return JSON.stringify(entry);
    });
    
    return lines.join("\n");
  } catch {
    return String(raw);
  }
}

function enforceContextBudget(context: string | null | undefined, budget: number = DEFAULTS.maxContextChars): string | null {
  if (!context) return null;
  if (context.length <= budget) return context;
  return context.slice(0, budget) + "\n... (truncated)";
}

// ============================================================================
// Analysis coprocessor constants
// ============================================================================

/**
 * Default confidence floor used to classify hypothesis and decision primitives
 * as lacking evidence when the caller has not supplied a custom evidenceThreshold.
 * Kept below 0.5 (the default threshold) so hypotheses produced by heuristic
 * classification will always be flagged for evidence checks.
 */
const HYPOTHESIS_CONFIDENCE = 0.35;

/**
 * Default confidence for heuristically-detected risk primitives.
 * Set below 0.6 (the default for other kinds) to reflect the inherent
 * uncertainty of pattern-matched risk signals.
 */
const RISK_CONFIDENCE = 0.55;

/**
 * Fallback objective alignment score used when objectives are detected in the
 * batch but no external alignment signal is available.  Set to 0.75 to sit
 * above the ALIGNMENT_THRESHOLD (0.7), indicating a tentatively aligned state
 * that downstream analysis can override with a real score.
 */
const DEFAULT_OBJECTIVE_ALIGNMENT_SCORE = 0.75;

// ============================================================================
// Analysis coprocessor helpers
// ============================================================================

/**
 * Derive a lightweight set of AnalysisPrimitive objects from a batch of
 * conversation texts.  This is a heuristic classifier — Phase 1 primitive
 * extraction (when merged) will replace or augment this.
 *
 * Each text maps to at most one primitive.  Texts that cannot be classified
 * are omitted.
 */
function buildPrimitivesFromTexts(
  texts: string[],
  sessionId: string,
): AnalysisPrimitive[] {
  const primitives: AnalysisPrimitive[] = [];
  let idx = 0;

  const kindPatterns: Array<{ kind: PrimitiveKind; pattern: RegExp }> = [
    { kind: "risk",        pattern: /\b(risk|danger|threat|vulnerability|exploit|breach|outage|downtime|incident)\b/i },
    { kind: "decision",    pattern: /\b(decided|decision|we will|going with|choosing|selected|we chose)\b/i },
    { kind: "objective",   pattern: /\b(goal|objective|aim|target|want to|need to achieve|should achieve)\b/i },
    { kind: "constraint",  pattern: /\b(must not|cannot|prohibited|disallowed|constraint|requirement)\b/i },
    { kind: "rule",        pattern: /\b(always|never|rule:|convention:|policy:|standard:)\b/i },
    { kind: "hypothesis",  pattern: /\b(hypothesis|maybe|perhaps|might|could be|assume|assuming|i think)\b/i },
    { kind: "evidence",    pattern: /\b(evidence|proved|confirmed|verified|test shows|data shows|results show)\b/i },
    { kind: "action-item", pattern: /\b(action item|todo|to-do|next step|follow up|follow-up|we should|will do)\b/i },
    { kind: "fact",        pattern: /\b(fact|known that|it is|this is|the value|returns|outputs)\b/i },
  ];

  for (const text of texts) {
    const truncated = text.slice(0, 500);
    const tags = extractTags(text);
    let matched: PrimitiveKind | null = null;
    let confidence = 0.6;

    for (const { kind, pattern } of kindPatterns) {
      if (pattern.test(truncated)) {
        matched = kind;
        break;
      }
    }

    if (!matched) continue;

    // Lower confidence for hypothesis (speculative) and risk (pattern-matched, inherently uncertain)
    if (matched === "hypothesis") confidence = HYPOTHESIS_CONFIDENCE;
    if (matched === "risk") confidence = RISK_CONFIDENCE;

    primitives.push({
      id: `${sessionId}:prim:${idx}`,
      sourceId: `${sessionId}:prim:${idx}`,
      kind: matched,
      content: truncated,
      confidence,
      tags,
    });
    idx++;
  }

  return primitives;
}

// ============================================================================
// Plugin entry point
// ============================================================================

export default function plureslmPlugin(api: OpenClawPluginApi) {
  const rawConfig = "config" in api ? (api as { config?: unknown }).config : api.pluginConfig;
  const cfg: PluginConfig = { ...DEFAULTS, ...(isRecord(rawConfig) ? rawConfig : {}) };
  const debug = (msg: string) => cfg.debug && api.logger.info(`[pluresLM] ${msg}`);

  // Validate MCP URL is configured
  if (!process.env.PLURESLM_MCP_URL) {
    api.logger.warn("pluresLM: PLURESLM_MCP_URL not set — all memory operations will fail. Set this env var to the pluresLM-mcp daemon URL (e.g. http://localhost:3100).");
  }

  // MCP service call wrapper
  const serviceCall = async (name: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ type: string; text: string }> }> => {
    const text = await callPluresLMServiceToolHttp(name, args);
    return { content: [{ type: "text", text: String(text ?? "") }] };
  };

  // ========================================================================
  // Reactive Procedure Action Dispatch
  // ========================================================================
  // When the daemon's after_store procedures emit actions (e.g. "spawn_verification_subagent"),
  // this function bridges them to OpenClaw's subagent runtime. The daemon does the thinking
  // (what needs to happen), the plugin does the acting (spawn subagents, inject events).

  const dispatchProcedureActions = async (toolResult: { content: Array<{ type: string; text: string }> }) => {
    try {
      const text = toolResult.content?.[0]?.text;
      if (!text) return;
      const parsed = JSON.parse(text);
      const actions = parsed.procedureActions;
      if (!Array.isArray(actions) || actions.length === 0) return;

      for (const action of actions) {
        const instruction = action.instruction || action.action_required || "";
        if (!instruction) continue;

        // Build context from the action's related memories
        const contextParts: string[] = [];
        if (instruction) contextParts.push(`## Task\n${instruction}`);

        // Include related work items as context
        const related = action.related_work || action.affected_work || action.affected_tasks || [];
        if (Array.isArray(related) && related.length > 0) {
          const items = related.map((r: Record<string, unknown>) =>
            `- [${r.category || "unknown"}] ${String(r.content || "").slice(0, 200)}`
          ).join("\n");
          contextParts.push(`## Related Work Items\n${items}`);
        }

        // Include constraints
        const constraints = action.constraints || action.related_decisions || [];
        if (Array.isArray(constraints) && constraints.length > 0) {
          const items = constraints.map((c: Record<string, unknown>) =>
            `- ${String(c.content || "").slice(0, 200)}`
          ).join("\n");
          contextParts.push(`## Active Constraints\n${items}`);
        }

        // Include the triggering item
        if (action.new_item || action.decision_content) {
          contextParts.push(`## Triggering Item\n${action.new_item || action.decision_content}`);
        }

        const message = contextParts.join("\n\n");

        // Determine action type
        const actionType = action.action || "review";

        if (actionType === "spawn_verification_subagent" || instruction.toLowerCase().includes("spawn")) {
          // ADR-0012: Brain-first authorization gate.
          // The brain (main agent) is the primary gatekeeper. Human approval
          // is only requested for destructive/ambiguous/high-risk actions.
          //
          // Gate order:
          // 1. Hard constraint violation → auto-BLOCK
          // 2. Already done (duplicate check) → auto-SKIP
          // 3. Better approach in memory → auto-REDIRECT (inject as context)
          // 4. Destructive/external action → surface to HUMAN
          // 5. Everything else → brain auto-APPROVES

          // Gate 1: Hard constraint violation → auto-block
          const hardConstraintViolation = await checkHardConstraints(instruction);
          if (hardConstraintViolation) {
            api.logger.info(`[pluresLM] BLOCKED '${action.procedure}': ${hardConstraintViolation}`);
            continue;
          }

          // Gate 2: Duplicate/already-done check → auto-skip
          const relatedItems = action.related_work || action.affected_work || [];
          const alreadyDone = Array.isArray(relatedItems) && relatedItems.some((r: Record<string, unknown>) => {
            const content = String(r.content || "").toLowerCase();
            const category = String(r.category || "");
            // If a completed/closed item covers the same work, skip
            return (content.includes("completed") || content.includes("merged") ||
                    content.includes("✅") || content.includes("done")) &&
                   category !== "work-in-progress";
          });
          if (alreadyDone) {
            debug(`auto-SKIP '${action.procedure}': related work already completed`);
            continue;
          }

          // Gate 3: Check for known failures / better approaches → redirect as context
          let redirectContext = "";
          const failureItems = Array.isArray(relatedItems) ? relatedItems.filter((r: Record<string, unknown>) => {
            const content = String(r.content || "").toLowerCase();
            return content.includes("failed") || content.includes("broken") ||
                   content.includes("doesn't work") || content.includes("root cause");
          }) : [];
          if (failureItems.length > 0) {
            redirectContext = "\n\n## ⚠️ Known Issues (from memory)\n" +
              failureItems.map((f: Record<string, unknown>) =>
                `- ${String(f.content || "").slice(0, 200)}`
              ).join("\n");
          }

          // Gate 4: Destructive/external actions → surface to human
          const isDestructive = /\b(delete|destroy|remove|drop|purge|close all|bulk)\b/i.test(instruction);
          const isExternal = /\b(email|tweet|post|publish|send to|deploy)\b/i.test(instruction);

          if (isDestructive || isExternal) {
            // Human approval needed
            const actionId = randomUUID().slice(0, 12);
            const pendingAction: PendingAction = {
              id: actionId,
              procedure: action.procedure || "unknown",
              actionType,
              instruction: instruction.slice(0, 500),
              message: message + redirectContext,
              createdAt: Date.now(),
            };
            addPendingAction(pendingAction);

            const riskLabel = isDestructive ? "🔴 Destructive" : "🟡 External";
            const truncatedInstruction = instruction.length > 200
              ? instruction.slice(0, 200) + "…"
              : instruction;
            debug(`HUMAN gate: ${riskLabel} action ${actionId} for '${action.procedure}'`);

            try {
              await (api as any).runtime?.message?.send({
                action: "send",
                message: `${riskLabel} **Action Requires Approval**\n\n**Procedure:** \`${action.procedure || "unknown"}\`\n\n${truncatedInstruction}`,
                buttons: [[
                  { text: "✅ Approve", callback_data: `pluresLM:auth:${actionId}` },
                  { text: "🚫 Reject", callback_data: `pluresLM:skip:${actionId}` },
                ]],
              });
            } catch (sendErr) {
              // Can't reach human → do NOT auto-approve destructive actions
              api.logger.warn(`[pluresLM] can't reach human for ${riskLabel} gate, BLOCKING: ${sendErr}`);
              removePendingAction(actionId);
            }
            continue;
          }

          // Gate 5: Brain auto-approves — spawn subagent
          debug(`brain auto-APPROVED '${action.procedure}': spawning subagent`);
          const sessionKey = `pluresLM-reactive-${Date.now()}`;
          try {
            await (api as any).runtime.subagent.run({
              sessionKey,
              message: message + redirectContext,
              deliver: false,
            });
          } catch (err) {
            api.logger.warn(`[pluresLM] subagent dispatch failed for ${action.procedure}: ${err}`);
          }
        } else {
          // For non-spawn actions, inject a system event so the next agent turn sees it
          debug(`injecting system event for procedure '${action.procedure}'`);
          try {
            (api as any).runtime.system.enqueueSystemEvent({
              text: `[pluresLM procedure: ${action.procedure}] ${instruction}`,
            });
          } catch (err) {
            api.logger.warn(`[pluresLM] system event injection failed for ${action.procedure}: ${err}`);
          }
        }
      }
    } catch {
      // JSON parse failure or missing fields — not all store results have actions
    }
  };

  // ========================================================================
  // Pattern Engine (in-process YAML, no DB dependency)
  // ========================================================================

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternEngine = new PatternEngine({
    patternsDirs: [path.join(__dirname, "patterns"), ...cfg.patternsDirs.map((d) => api.resolvePath(d))],
    watch: cfg.patternsWatch,
    debug: cfg.debug,
    search: async (query, _filter, limit) => {
      try {
        const result = await callPluresLMServiceToolHttp("pluresLM_search", { query, limit: limit ?? 5 });
        const parsed = JSON.parse(String(result));
        return parsed.results ?? [];
      } catch {
        return [];
      }
    },
    store: async (content, opts) => {
      await callPluresLMServiceToolHttp("pluresLM_store", { content, ...opts });
    },
  });
  patternEngine.load();

  // ========================================================================
  // Tool Registration — all delegate to MCP service
  // ========================================================================

  let turnCounter = 0;
  /**
   * Monotonically incremented every time the agent_end handler fires.
   * Provides a unique analysis session ID even when cfg.autoRecall is disabled
   * (in which case turnCounter never increments).
   */
  let agentEndCounter = 0;

  api.registerTool(
    {
      name: "pluresLM_store",
      label: "Store Memory",
      description: "Store information in long-term memory. Use for facts, preferences, decisions, or anything the user wants remembered.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
        category: Type.Optional(Type.String({ description: "Category: preference, decision, entity, project, explicit, conversation, code-pattern, type-definition, module-composition, api-pattern, architecture-decision, error-fix, work-in-progress, project-context, document, document-chunk, note, reference, insight" })),
        destination: Type.Optional(Type.String({ description: "Target agent ID or scope for this memory (empty = all agents)" })),
        status: Type.Optional(Type.String({ description: "Task status: claimed, in-progress, completed, or abandoned" })),
        assigned_to: Type.Optional(Type.String({ description: "Agent ID responsible for this task" })),
        due_at: Type.Optional(Type.Number({ description: "Task deadline as Unix millisecond timestamp" })),
      }),
      async execute(_id, params) {
        const p = params as Record<string, unknown>;
        const result = await serviceCall("pluresLM_store", {
          content: p.text,
          tags: p.tags ?? [],
          category: p.category,
          source: "openclaw-plugin",
          destination: p.destination,
          status: p.status,
          assigned_to: p.assigned_to,
          due_at: p.due_at,
        });

        // Check for procedure actions (async, don't block tool response)
        dispatchProcedureActions(result).catch((err) =>
          api.logger.warn(`[pluresLM] procedure action dispatch failed: ${err}`)
        );

        return result;
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
        const p = params as { query: string; limit?: number };
        return await serviceCall("pluresLM_search", { query: p.query, limit: p.limit ?? cfg.maxRecallResults });
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
        query: Type.String({ description: 'Query DSL string. Examples: \'filter(category == "decision")\', \'aggregate(count)\', \'graph_neighbors("memory:UUID", depth: 2)\'' }),
        format: Type.Optional(Type.String({ description: "Output format: table, json, compact (default: table)" })),
      }),
      async execute(_id, params) {
        const p = params as { query: string; format?: string };
        return await serviceCall("pluresLM_query_dsl", { query: p.query, format: p.format ?? "table" });
      },
    },
    { name: "pluresLM_query" },
  );

  api.registerTool(
    {
      name: "pluresLM_task_update",
      label: "Update Task Status",
      description: "Update the status, assignment, or deadline of a task memory.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID of the task to update" }),
        status: Type.Optional(Type.String({ description: "New status: claimed, in-progress, completed, or abandoned" })),
        assigned_to: Type.Optional(Type.String({ description: "Agent ID to assign this task to" })),
        due_at: Type.Optional(Type.Number({ description: "Task deadline as Unix millisecond timestamp" })),
        last_checkin: Type.Optional(Type.Number({ description: "Check-in timestamp (defaults to now when status is set)" })),
      }),
      async execute(_id, params) {
        const p = params as { memoryId: string; status?: string; assigned_to?: string; due_at?: number; last_checkin?: number };
        return await serviceCall("pluresLM_update", {
          id: p.memoryId,
          status: p.status,
          assigned_to: p.assigned_to ?? (p.status === "claimed" || p.status === "in-progress" ? cfg.agentId || undefined : undefined),
          due_at: p.due_at,
          last_checkin: p.last_checkin ?? (p.status ? Date.now() : undefined),
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
        const { query, memoryId } = params as { query?: string; memoryId?: string };
        return await serviceCall("pluresLM_forget", { query, id: memoryId });
      },
    },
    { name: "pluresLM_forget" },
  );

  api.registerTool(
    { name: "pluresLM_profile", label: "User Profile", description: "View the user's distilled profile built from memory.", parameters: Type.Object({}),
      async execute() { return await serviceCall("pluresLM_profile", {}); } },
    { name: "pluresLM_profile" },
  );

  api.registerTool(
    { name: "pluresLM_index", label: "Index Project", description: "Index a project directory into memory.", parameters: Type.Object({ path: Type.String({ description: "Path to project directory to index" }) }),
      async execute(_id, params) { const { path: p } = params as { path: string }; return await serviceCall("pluresLM_index", { path: api.resolvePath(p) }); } },
    { name: "pluresLM_index" },
  );

  api.registerTool(
    { name: "pluresLM_sync_keygen", label: "Generate Sync Key", description: "Generate a new 32-byte (64 hex char) Hyperswarm sync key.", parameters: Type.Object({}),
      async execute() { const { randomBytes } = await import("node:crypto"); return { content: [{ type: "text", text: randomBytes(32).toString("hex") }] }; } },
    { name: "pluresLM_sync_keygen" },
  );

  api.registerTool(
    { name: "pluresLM_sync_status", label: "Sync Status", description: "Show Hyperswarm sync status.", parameters: Type.Object({}),
      async execute() { return await serviceCall("pluresLM_sync_status", {}); } },
    { name: "pluresLM_sync_status" },
  );

  api.registerTool(
    { name: "pluresLM_status", label: "Plugin Status", description: "Run diagnostics on the pluresLM-mcp service.", parameters: Type.Object({}),
      async execute() { return await serviceCall("pluresLM_status", {}); } },
    { name: "pluresLM_status" },
  );

  api.registerTool(
    { name: "pluresLM_consolidate", label: "Consolidate Memories", description: "Merge duplicates, demote stale memories, promote reinforced facts.", parameters: Type.Object({
        dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without applying (default: true)" })),
        stalenessDays: Type.Optional(Type.Number({ description: "Days threshold for staleness (default: 30)" })),
      }),
      async execute(_id, params) { const { dryRun = true, stalenessDays = 30 } = params as { dryRun?: boolean; stalenessDays?: number }; return await serviceCall("pluresLM_consolidate", { dryRun, stalenessDays }); } },
    { name: "pluresLM_consolidate" },
  );

  api.registerTool(
    { name: "pluresLM_world_state", label: "World State", description: "Generate a summary of high-priority memories.", parameters: Type.Object({}),
      async execute() { return await serviceCall("pluresLM_world_state", {}); } },
    { name: "pluresLM_world_state" },
  );

  api.registerTool(
    { name: "pluresLM_find_stale", label: "Find Stale Memories", description: "Find memories not accessed in N days.", parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Days threshold (default: 30)" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      }),
      async execute(_id, params) { const { days = 30, limit = 10 } = params as { days?: number; limit?: number }; return await serviceCall("pluresLM_find_stale", { days, limit }); } },
    { name: "pluresLM_find_stale" },
  );

  api.registerTool(
    { name: "pluresLM_generate_daily_summary", label: "Generate Daily Summary", description: "Summarize memories captured on a specific date.", parameters: Type.Object({
        date: Type.String({ description: "Date in YYYY-MM-DD format" }),
      }),
      async execute(_id, params) { const { date } = params as { date: string }; return await serviceCall("pluresLM_daily_summary", { date }); } },
    { name: "pluresLM_generate_daily_summary" },
  );

  api.registerTool(
    { name: "pluresLM_get_daily_summaries", label: "Get Daily Summaries", description: "Retrieve daily summaries for the last N days.", parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Number of days to look back (default: 7)" })),
      }),
      async execute(_id, params) { const { days = 7 } = params as { days?: number }; return await serviceCall("pluresLM_daily_summary", { days }); } },
    { name: "pluresLM_get_daily_summaries" },
  );

  api.registerTool(
    { name: "pluresLM_graph_neighbors", label: "Find Related Memories", description: "Find memories related to a given memory via graph traversal.", parameters: Type.Object({
        memoryId: Type.String({ description: "UUID of the memory" }),
        depth: Type.Optional(Type.Number({ description: "Traversal depth (default: 2)" })),
      }),
      async execute(_id, params) { const { memoryId, depth } = params as { memoryId: string; depth?: number }; return await serviceCall("pluresLM_graph_neighbors", { memoryId, depth: depth ?? 2 }); } },
    { name: "pluresLM_graph_neighbors" },
  );

  api.registerTool(
    { name: "pluresLM_autolink", label: "Auto-Link Memories", description: "Trigger automatic relationship discovery between memories.", parameters: Type.Object({
        mode: Type.Union([Type.Literal("all"), Type.Literal("incremental"), Type.Literal("memory")], { description: "Linking mode" }),
        target: Type.Optional(Type.String({ description: "Memory UUID when mode='memory'" })),
      }),
      async execute(_id, params) { const { mode, target } = params as { mode: string; target?: string }; return await serviceCall("pluresLM_autolink", { mode, target }); } },
    { name: "pluresLM_autolink" },
  );

  api.registerTool(
    { name: "pluresLM_graph_insights", label: "Memory Graph Insights", description: "Analyze memory relationship patterns.", parameters: Type.Object({
        timespan: Type.Optional(Type.String({ description: "Timespan label (e.g. '7d', '30d')" })),
      }),
      async execute(_id, params) { const { timespan } = params as { timespan?: string }; return await serviceCall("pluresLM_graph_insights", { timespan }); } },
    { name: "pluresLM_graph_insights" },
  );

  api.registerTool(
    { name: "pluresLM_compatibility", label: "Compatibility Check", description: "Check PluresLM compatibility and operating mode.", parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: [
          `🔧 **PluresLM Operating Mode**: MCP-SERVICE`,
          `📡 **MCP URL**: ${process.env.PLURESLM_MCP_URL ?? "not set"}`,
          `🔑 **API Key**: ${process.env.MCP_API_KEY ? "configured" : "not set"}`,
          ``,
          `All memory operations delegated to pluresLM-mcp daemon.`,
          `Plugin is stateless — no local DB, no embeddings, no sync state.`,
        ].join("\n") }] };
      } },
    { name: "pluresLM_compatibility" },
  );

  // ---- Procedure tools ----

  api.registerTool(
    {
      name: "pluresLM_create_procedure",
      label: "Create Procedure",
      description: "Create a stored procedure — a named, reusable pipeline of memory operations. Steps: search, search_text, filter, sort, limit, merge (RRF), store, update, delete, transform (structured/fused), cue, parallel, conditional, assign, emit. Triggers: manual, after_store, before_search, on_cue, cron. Use 'as' on a step to save its result to a named variable.",
      parameters: Type.Object({
        name: Type.String({ description: "Unique procedure name" }),
        description: Type.Optional(Type.String({ description: "What this procedure does" })),
        trigger: Type.Object({}, { description: "{ kind: 'manual'|'after_store'|'before_search'|'on_cue'|'cron', cron?: '1h', filter?: {}, cue?: 'name' }", additionalProperties: true }),
        steps: Type.Array(Type.Object({}, { additionalProperties: true }), { description: "Ordered steps: [{ kind, params, as? }]" }),
      }),
      async execute(_id, params) {
        const p = params as Record<string, unknown>;
        return await serviceCall("pluresLM_create_procedure", p);
      },
    },
    { name: "pluresLM_create_procedure" },
  );

  api.registerTool(
    { name: "pluresLM_run_procedure", label: "Run Procedure", description: "Run a stored procedure by name with optional input context.",
      parameters: Type.Object({
        name: Type.String({ description: "Procedure name" }),
        context: Type.Optional(Type.Object({}, { description: "Input context ($input in steps)", additionalProperties: true })),
      }),
      async execute(_id, params) { const p = params as Record<string, unknown>; return await serviceCall("pluresLM_run_procedure", p); } },
    { name: "pluresLM_run_procedure" },
  );

  api.registerTool(
    { name: "pluresLM_list_procedures", label: "List Procedures", description: "List all stored procedures with triggers, stats, and status.",
      parameters: Type.Object({}),
      async execute() { return await serviceCall("pluresLM_list_procedures", {}); } },
    { name: "pluresLM_list_procedures" },
  );

  api.registerTool(
    { name: "pluresLM_update_procedure", label: "Update Procedure", description: "Update a procedure's steps, trigger, description, or enabled status.",
      parameters: Type.Object({
        name: Type.String({ description: "Procedure name" }),
        description: Type.Optional(Type.String()),
        trigger: Type.Optional(Type.Object({}, { additionalProperties: true })),
        steps: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
        enabled: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) { const p = params as Record<string, unknown>; return await serviceCall("pluresLM_update_procedure", p); } },
    { name: "pluresLM_update_procedure" },
  );

  api.registerTool(
    { name: "pluresLM_delete_procedure", label: "Delete Procedure", description: "Delete a stored procedure by name.",
      parameters: Type.Object({ name: Type.String({ description: "Procedure name" }) }),
      async execute(_id, params) { const { name } = params as { name: string }; return await serviceCall("pluresLM_delete_procedure", { name }); } },
    { name: "pluresLM_delete_procedure" },
  );

  // Pattern engine tools
  api.registerTool(
    {
      name: "pluresLM_pattern_dispatch",
      label: "Dispatch Pattern Event",
      description: "Dispatch a named event through the YAML pattern engine.",
      parameters: Type.Object({
        event: Type.String({ description: "Event type (e.g. 'ci-failure', 'human-override')" }),
        context: Type.Object({}, { description: "Template variables for matching patterns", additionalProperties: true }),
      }),
      async execute(_id, params) {
        const { event, context } = params as { event: string; context: Record<string, unknown> };
        const results = await patternEngine.dispatch(event, context);
        if (results.length === 0) return { content: [{ type: "text", text: `No patterns matched event '${event}'.` }] };
        const lines = results.map((r) => {
          let line = `**${r.patternName}** → \`${r.action}\``;
          if (r.message) line += `\n> ${r.message}`;
          return line;
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      },
    },
    { name: "pluresLM_pattern_dispatch" },
  );

  api.registerTool(
    {
      name: "pluresLM_pattern_list",
      label: "List Loaded Patterns",
      description: "List all YAML operational memory patterns.",
      parameters: Type.Object({}),
      async execute() {
        const names = patternEngine.getPatternNames();
        if (names.length === 0) return { content: [{ type: "text", text: "No patterns loaded." }] };
        const lines = names.map((name) => {
          const p = patternEngine.getPattern(name)!;
          return `- **${name}** (v${p.version}) — event: \`${p.trigger.event}\``;
        });
        return { content: [{ type: "text", text: `Loaded patterns (${names.length}):\n\n${lines.join("\n")}` }] };
      },
    },
    { name: "pluresLM_pattern_list" },
  );

  api.registerTool(
    {
      name: "pluresLM_query_analysis",
      label: "Query Analysis Artifacts",
      description: "Retrieve decision-ledger analysis artifacts (conflict detections, objective alignment scores, risk propagations, missing-evidence flags, next-action recommendations) generated by the background coprocessor.",
      parameters: Type.Object({
        sessionId: Type.Optional(Type.String({ description: "Filter artifacts by analysis session ID (maps to agent turn identifier)" })),
        factTag: Type.Optional(Type.String({ description: "Filter by fact tag: analysis.conflict-detected, analysis.objective-aligned, analysis.objective-misaligned, analysis.risk-propagated, analysis.evidence-missing, analysis.next-action-recommended, analysis.error" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of artifacts to return (default 10)" })),
      }),
      async execute(_id, params) {
        const p = params as { sessionId?: string; factTag?: string; limit?: number };
        const parts: string[] = [
          'filter(category == "analysis-artifact")',
        ];
        if (p.sessionId) {
          parts.push(`filter(tags contains ${JSON.stringify("session:" + p.sessionId)})`);
        }
        if (p.factTag) {
          // Validate factTag against the known analysis.* set to prevent DSL injection
          const tag = ALLOWED_ANALYSIS_FACT_TAGS.has(p.factTag) ? p.factTag : null;
          if (tag) {
            parts.push(`filter(tags contains ${JSON.stringify("fact:" + tag)})`);
          }
        }
        parts.push(`limit(${p.limit ?? 10})`);
        return await serviceCall("pluresLM_query_dsl", {
          query: parts.join(" | "),
          format: "json",
        });
      },
    },
    { name: "pluresLM_query_analysis" },
  );

  // ========================================================================
  // Analysis Worker — wire artifact store and error logger
  // ========================================================================

  setArtifactStore(async (artifact: AnalysisArtifact) => {
    const tags = [
      `fact:${artifact.factTag}`,
      `session:${artifact.sessionId}`,
      ...artifact.sourceIds.map((id) => `source:${id}`),
    ];
    await callPluresLMServiceToolHttp("pluresLM_store", {
      content: artifact.summary,
      tags,
      category: "analysis-artifact",
      source: "analysis-coprocessor",
    });
    debug(`analysis artifact stored: ${artifact.factTag} (session: ${artifact.sessionId})`);
  });

  setErrorLogger((message: string) => {
    api.logger.warn(message);
  });

  // ========================================================================
  // Interactive Handler — Authorization Gate (ADR-0012)
  // ========================================================================

  (api as any).registerInteractiveHandler({
    namespace: "pluresLM",
    channel: "telegram",
    handler: async (ctx: any) => {
      const payload = ctx.callback?.payload || "";
      const parts = payload.split(":");
      const decision = parts[0]; // "auth" or "skip"
      const actionId = parts.slice(1).join(":"); // action ID

      if (!decision || !actionId) {
        await ctx.respond?.reply?.({ text: "⚠️ Invalid callback data." });
        return;
      }

      if (decision === "auth") {
        const pendingAction = removePendingAction(actionId);
        if (!pendingAction) {
          await ctx.respond?.editMessage?.({ text: "⚠️ Action not found (already processed or expired)." });
          return;
        }

        const sessionKey = `pluresLM-authorized-${Date.now()}`;
        debug(`authorized action ${actionId} for procedure '${pendingAction.procedure}', spawning subagent ${sessionKey}`);

        try {
          await (api as any).runtime.subagent.run({
            sessionKey,
            message: pendingAction.message,
            deliver: false,
          });
          await ctx.respond?.editMessage?.({
            text: `✅ **Authorized** — spawned subagent for \`${pendingAction.procedure}\`\n\n_${pendingAction.instruction.slice(0, 150)}_`,
          });
        } catch (err) {
          api.logger.warn(`[pluresLM] authorized subagent spawn failed: ${err}`);
          await ctx.respond?.editMessage?.({
            text: `❌ Failed to spawn subagent for \`${pendingAction.procedure}\`: ${err}`,
          });
        }
      } else if (decision === "skip") {
        const pendingAction = removePendingAction(actionId);
        const procName = pendingAction?.procedure || "unknown";
        debug(`skipped action ${actionId} for procedure '${procName}'`);
        await ctx.respond?.editMessage?.({
          text: `⏭ **Skipped** action for \`${procName}\``,
        });
      } else {
        await ctx.respond?.reply?.({ text: `⚠️ Unknown decision: ${decision}` });
      }
    },
  });

  // ========================================================================
  // Lifecycle Hooks — Auto-Recall
  // ========================================================================

  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event) => {
      const agentEvent = event as { prompt?: string; modelContextWindow?: number };
      // Read modelContextWindow from event if OpenClaw provides it
      const modelContextWindow = typeof agentEvent.modelContextWindow === "number"
        ? agentEvent.modelContextWindow
        : undefined;

      // Compute dynamic context budget from model's context window
      const effectiveBudget = computeContextBudget(
        modelContextWindow,
        cfg.contextBudgetFraction,
        cfg.minContextChars,
        cfg.maxContextChars,
      );
      debug(`context budget: ${effectiveBudget} chars (modelContextWindow=${modelContextWindow ?? "unknown"})`);

      // Session-start context injection
      if (cfg.sessionStartRecall.enabled && turnCounter === 0) {
        try {
          const parts: string[] = [];

          const profileText = await callPluresLMServiceToolHttp("pluresLM_profile", {}).catch(() => "");
          if (profileText && String(profileText).length > 10) {
            parts.push(`<user-profile>\n${profileText}\n</user-profile>`);
          }

          // 1. Active decisions and preferences (what to remember)
          const contextText = await callPluresLMServiceToolHttp("pluresLM_search", {
            query: "recent important decisions preferences work-in-progress",
            limit: Math.floor(cfg.sessionStartRecall.maxMemories * 0.6),
          }).catch(() => "");
          if (contextText && String(contextText).length > 10) {
            parts.push(`<session-context>\n${contextText}\n</session-context>`);
          }

          // 2. Stale tasks — WIP items that may be forgotten
          const staleText = await callPluresLMServiceToolHttp("pluresLM_search", {
            query: "incomplete started not finished task blocked stalled forgotten work in progress TODO",
            category: "work-in-progress",
            limit: Math.floor(cfg.sessionStartRecall.maxMemories * 0.2),
          }).catch(() => "");
          if (staleText && String(staleText).length > 10) {
            parts.push(`<stale-tasks>\n${staleText}\n</stale-tasks>`);
          }

          // 3. Hard constraints — things that must always be enforced
          const constraintText = await callPluresLMServiceToolHttp("pluresLM_search", {
            query: "hard constraint NEVER ALWAYS must rule enforcement",
            category: "decision",
            limit: Math.floor(cfg.sessionStartRecall.maxMemories * 0.2),
          }).catch(() => "");
          if (constraintText && String(constraintText).length > 10) {
            parts.push(`<active-constraints>\n${constraintText}\n</active-constraints>`);
          }

          turnCounter++;
          const assembled = parts.join("\n\n");
          const safeContext = enforceContextBudget(assembled, effectiveBudget);
          if (safeContext) return { prependContext: safeContext };
        } catch (err) {
          api.logger.warn(`pluresLM: session-start recall failed: ${String(err)}`);
        }
      }

      // Per-turn recall
      if (!agentEvent.prompt || agentEvent.prompt.length < 5 || isTrivial(agentEvent.prompt)) return;

      try {
        const recallText = await callPluresLMServiceToolHttp("pluresLM_search", {
          query: agentEvent.prompt,
          limit: cfg.maxRecallResults,
        });
        turnCounter++;

        if (!recallText || String(recallText).length < 10) return;

        // Transform raw results to dense JSONL format for better token efficiency
        const context = `<relevant-memories>\n${compactRecallResults(recallText)}\n</relevant-memories>`;
        const safeContext = enforceContextBudget(context, effectiveBudget);
        if (safeContext) return { prependContext: safeContext };
      } catch (err) {
        api.logger.warn(`pluresLM: recall failed: ${String(err)}`);
      }
    });
  }

  // ========================================================================
  // Lifecycle Hooks — Auto-Capture
  // ========================================================================

  if (cfg.autoCapture) {
    api.on("agent_end", async (event) => {
      const endEvent = event as { success?: boolean; messages?: unknown[] };
      if (!endEvent.success || !endEvent.messages || endEvent.messages.length === 0) return;

      // Increment unconditionally so every agent_end turn has a unique ID
      // regardless of whether cfg.autoRecall is enabled.
      agentEndCounter++;

      try {
        const texts: string[] = [];
        for (const msg of endEvent.messages) {
          if (!msg || typeof msg !== "object") continue;
          const m = msg as Record<string, unknown>;
          if (m.role !== "user" && m.role !== "assistant") continue;
          if (typeof m.content === "string") {
            texts.push(m.content);
          } else if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (isTextBlock(block)) {
                texts.push(block.text);
              }
            }
          }
        }

        if (texts.length === 0) return;

        // Filter texts through the quality gate first — extraction signals
        // (code patterns, error-fix pairs, WIP) are derived from capturable
        // texts only, so noise and injection artifacts never drive storage.
        const captureQualityCfg = {
          minContentLength: cfg.captureQuality.minContentLength,
          skipPatterns: cfg.captureQuality.skipPatterns,
        };
        const filteredTexts = texts.filter((t) => shouldCapture(t, captureQualityCfg));

        // Pre-compute extraction results from filtered texts only.

        // Auto-capture: store filtered texts directly
        let stored = 0;
        const remaining = cfg.captureQuality.maxCapturesPerTurn;
        for (const text of filteredTexts.slice(0, remaining)) {
          if (isDuplicateCapture(text)) continue;
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: text, tags: extractTags(text), category: detectCategory(text), source: "auto-capture",
          });
          stored++;
        }
        if (stored > 0) debug(`auto-captured ${stored} memories via MCP`);

        // Enqueue analysis batch asynchronously — non-blocking, runs after capture
        if (filteredTexts.length > 0) {
          const analysisSessionId = `turn:${agentEndCounter}`;
          const primitives = buildPrimitivesFromTexts(filteredTexts, analysisSessionId);
          const hasLinkedRisk = primitives.some((p) => p.kind === "risk") &&
            primitives.some((p) => p.kind === "objective" || p.kind === "decision");
          const objectiveScore = primitives.some((p) => p.kind === "objective") ? DEFAULT_OBJECTIVE_ALIGNMENT_SCORE : 0;
          const batch: AnalysisBatch = {
            sessionId: analysisSessionId,
            objectiveAlignmentScore: objectiveScore,
            hasLinkedRisk,
            primitives,
          };
          enqueueAnalysis(batch);
          debug(`analysis batch enqueued: ${primitives.length} primitives (session: ${analysisSessionId})`);
        }
      } catch (err) {
        api.logger.warn(`pluresLM: capture failed: ${String(err)}`);
      }
    });
  }

  // ========================================================================
  // Behavioral Constraint Enforcement — before_tool_call
  // ========================================================================
  // This is the praxis enforcement layer. Constraints stored in PluresLM
  // are checked BEFORE tool calls execute. Violations are blocked, not warned.
  // This transforms passive memories into active enforcement.

  api.on("before_tool_call", async (event) => {
    const { toolName, params } = event as { toolName: string; params: Record<string, unknown> };

    // --- CONSTRAINT: Never manually assign Copilot ---
    // Lifecycle workflow handles all Copilot assignment. Manual assignment
    // bypasses queue-advance, violates single-assignment-authority.
    if (toolName === "exec") {
      const cmd = String(params.command || "");
      if (/assignee.*[Cc]opilot|addAssignees.*BOT_kg|copilot-swe-agent/.test(cmd)) {
        return { block: true, blockReason: "BLOCKED: Single assignment authority — only lifecycle workflow assigns Copilot. Create the issue with proper labels/type and the automation handles assignment. (C-COP-ASSIGN)" };
      }

      // --- CONSTRAINT: Never nudge Copilot (C-COP-001) ---
      if (/gh issue comment|createComment|@copilot|nudge/.test(cmd) && /copilot|plures\//.test(cmd)) {
        return { block: true, blockReason: "BLOCKED: Never nudge Copilot with comments (C-COP-001). Assignment alone triggers the SWE agent. If stalled: close → recreate → reassign." };
      }

      // --- CONSTRAINT: Never modify openclaw.json ---
      if (/openclaw\.json/.test(cmd) && /edit|write|sed|echo.*>|cat.*>/.test(cmd)) {
        return { block: true, blockReason: "BLOCKED: Never modify ~/.openclaw/openclaw.json without explicit user permission. Use gateway config.patch tool instead." };
      }

      // --- CONSTRAINT: Never restart gateway without permission ---
      if (/restart.*openclaw-gateway|systemctl.*restart.*openclaw/.test(cmd)) {
        return { block: true, blockReason: "BLOCKED: Never restart openclaw-gateway without explicit user permission." };
      }
    }

    // --- CONSTRAINT: Subagent task size (ADR-0013) ---
    if (toolName === "sessions_spawn") {
      const task = String(params.task || "");
      const wordCount = task.split(/\s+/).length;
      if (wordCount > 300) {
        api.logger.warn(`[pluresLM] WARNING: Subagent task has ${wordCount} words (limit: 200). Consider decomposing. (ADR-0013)`);
        // Warn but don't block — the brain should decompose but we don't want to halt work
      }
    }

    return; // Allow all other tool calls
  });

  // ========================================================================
  // Lifecycle Hooks — Compaction Snapshot
  // ========================================================================

  api.on("before_compaction", async (event) => {
    const { summary, sessionKey, messageCount } = event as { summary?: string; sessionKey?: string; messageCount?: number };
    if (!summary || typeof summary !== "string" || summary.length < 20) return;

    try {
      const ts = new Date().toISOString();
      const snapContent = `Compaction snapshot | ${sessionKey ?? "unknown"} | ${messageCount ?? "?"} messages | ${ts}\n\n${summary}`;
      if (isDuplicateCapture(snapContent)) return;
      await callPluresLMServiceToolHttp("pluresLM_store", {
        content: snapContent,
        tags: ["compaction", "snapshot", `timestamp:${ts}`, ...(sessionKey ? [`session:${sessionKey}`] : [])],
        category: "compaction-snapshot",
        source: "compaction-snapshot",
      });

      // Extract important decisions
      let stored = 1;
      for (const line of summary.split("\n")) {
        if (stored >= 5) break;
        if (line.length < 40) continue;
        if (containsImportantContext(line)) {
          if (isDuplicateCapture(line)) continue;
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: line, tags: ["compaction", "decision", ...extractTags(line)], category: "compaction-snapshot", source: "compaction-snapshot:decision",
          });
          stored++;
        }
      }

      debug(`compaction snapshot: stored ${stored} memories via MCP`);
    } catch (err) {
      api.logger.warn(`pluresLM: compaction capture failed: ${String(err)}`);
    }
  });

  // ========================================================================
  // Startup
  // ========================================================================

  api.logger.info(`pluresLM: initialized (mode: MCP-service, url: ${process.env.PLURESLM_MCP_URL ?? "NOT SET"})`);
}

// ============================================================================
// Public API handlers — exported for consumers and tests
// ============================================================================
export * from "./api-handlers.js";

// ============================================================================
// Praxis Logic Modules — re-exported for consumers
// ============================================================================
export * from "./praxis/index.js";

// ============================================================================
// Analysis Worker — re-exported for consumers and tests
// ============================================================================
export {
  runAnalysis,
  enqueueAnalysis,
  pendingAnalysisCount,
  setArtifactStore,
  setErrorLogger,
  _resetAnalysisWorker,
  type AnalysisBatch,
  type AnalysisArtifact,
} from "./analysis-worker.js";
