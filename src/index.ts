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
import { callPluresLMServiceToolHttp, resetMcpSession } from "./http-service-client.js";
import { PatternEngine } from "./patterns.js";
import { shouldCapture, DEFAULT_CAPTURE_QUALITY_CONFIG, type CaptureQualityConfig } from "./capture-quality.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

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
};

// ============================================================================
// Text helpers — lightweight, no DB
// ============================================================================

const MAX_CONTEXT_CHARS = 12_000;

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

function isWorkInProgress(text: string): boolean {
  return /\b(todo|fixme|hack|wip|in progress|next step|blocker|working on|needs|unfinished|blocked)\b/i.test(text);
}

function extractCodePatterns(text: string): Array<{ content: string; tags: string[]; category: string }> {
  const patterns: Array<{ content: string; tags: string[]; category: string }> = [];
  const codeBlockRe = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRe.exec(text)) !== null) {
    const lang = match[1] || "";
    const code = match[2].trim();
    if (code.length < 30 || code.length > 2000) continue;
    patterns.push({
      content: lang ? `[${lang}] ${code}` : code,
      tags: [...extractTags(code), ...(lang ? [lang] : [])],
      category: "code-pattern",
    });
  }
  return patterns;
}

function detectErrorFixPairs(messages: string[]): Array<{ error: string; fix: string; errorTags: string[] }> {
  const pairs: Array<{ error: string; fix: string; errorTags: string[] }> = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (/\b(error|exception|failed|crash|traceback|ENOENT|EPERM|TypeError|ReferenceError)\b/i.test(messages[i])) {
      const j = i + 1;
      if (/\b(fix|fixed|solution|resolved|workaround|instead|change|update|replace)\b/i.test(messages[j])) {
        pairs.push({
          error: messages[i].slice(0, 500),
          fix: messages[j].slice(0, 500),
          errorTags: extractTags(messages[i] + " " + messages[j]),
        });
      }
    }
  }
  return pairs;
}

function enforceContextBudget(context: string | null | undefined, budget: number = MAX_CONTEXT_CHARS): string | null {
  if (!context) return null;
  if (context.length <= budget) return context;
  return context.slice(0, budget) + "\n... (truncated)";
}

// ============================================================================
// Plugin entry point
// ============================================================================

export default function plureslmPlugin(api: OpenClawPluginApi) {
  const cfg: PluginConfig = { ...DEFAULTS, ...((api as any).config ?? {}) };
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
  // Pattern Engine (in-process YAML, no DB dependency)
  // ========================================================================

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternEngine = new PatternEngine({
    patternsDirs: [path.join(__dirname, "patterns"), ...cfg.patternsDirs.map((d) => api.resolvePath(d))],
    watch: cfg.patternsWatch,
    debug: cfg.debug,
    search: async (query, _filter, limit) => {
      try {
        const result = await callPluresLMServiceToolHttp("pluresLM_search_text", { query, limit: limit ?? 5 });
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
        return await serviceCall("pluresLM_store", {
          content: p.text,
          tags: p.tags ?? [],
          category: p.category,
          source: "openclaw-plugin",
          destination: p.destination,
          status: p.status,
          assigned_to: p.assigned_to,
          due_at: p.due_at,
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
        const p = params as { query: string; limit?: number };
        return await serviceCall("pluresLM_search_text", { query: p.query, limit: p.limit ?? cfg.maxRecallResults });
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
      async execute(_id, params) { const { memoryId, depth } = params as { memoryId: string; depth?: number }; return await serviceCall("pluresLM_query_dsl", { query: `graph_neighbors("memory:${memoryId}", depth: ${depth ?? 2})`, format: "compact" }); } },
    { name: "pluresLM_graph_neighbors" },
  );

  api.registerTool(
    { name: "pluresLM_autolink", label: "Auto-Link Memories", description: "Trigger automatic relationship discovery between memories.", parameters: Type.Object({
        mode: Type.Union([Type.Literal("all"), Type.Literal("incremental"), Type.Literal("memory")], { description: "Linking mode" }),
        target: Type.Optional(Type.String({ description: "Memory UUID when mode='memory'" })),
      }),
      async execute(_id, params) { const { target } = params as { target?: string }; return await serviceCall("pluresLM_query_dsl", { query: target ? `auto_link("memory:${target}")` : "auto_link()" }); } },
    { name: "pluresLM_autolink" },
  );

  api.registerTool(
    { name: "pluresLM_graph_insights", label: "Memory Graph Insights", description: "Analyze memory relationship patterns.", parameters: Type.Object({
        timespan: Type.Optional(Type.String({ description: "Timespan label (e.g. '7d', '30d')" })),
      }),
      async execute() { return await serviceCall("pluresLM_status", {}); } },
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

  // ========================================================================
  // Lifecycle Hooks — Auto-Recall
  // ========================================================================

  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event) => {
      // Session-start context injection
      if (cfg.sessionStartRecall.enabled && turnCounter === 0) {
        try {
          const parts: string[] = [];

          const profileText = await callPluresLMServiceToolHttp("pluresLM_profile", {}).catch(() => "");
          if (profileText && String(profileText).length > 10) {
            parts.push(`<user-profile>\n${profileText}\n</user-profile>`);
          }

          const contextText = await callPluresLMServiceToolHttp("pluresLM_search_text", {
            query: "recent important decisions preferences work-in-progress",
            limit: cfg.sessionStartRecall.maxMemories,
          }).catch(() => "");
          if (contextText && String(contextText).length > 10) {
            parts.push(`<session-context>\n${contextText}\n</session-context>`);
          }

          turnCounter++;
          const assembled = parts.join("\n\n");
          const safeContext = enforceContextBudget(assembled, MAX_CONTEXT_CHARS);
          if (safeContext) return { prependContext: safeContext };
        } catch (err) {
          api.logger.warn(`pluresLM: session-start recall failed: ${String(err)}`);
        }
      }

      // Per-turn recall
      if (!event.prompt || event.prompt.length < 5 || isTrivial(event.prompt)) return;

      try {
        const recallText = await callPluresLMServiceToolHttp("pluresLM_search_text", {
          query: event.prompt,
          limit: cfg.maxRecallResults,
        });
        turnCounter++;

        if (!recallText || String(recallText).length < 10) return;

        const context = `<relevant-memories>\n${recallText}\n</relevant-memories>`;
        const safeContext = enforceContextBudget(context, MAX_CONTEXT_CHARS);
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
      if (!event.success || !event.messages || event.messages.length === 0) return;

      try {
        const texts: string[] = [];
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const m = msg as Record<string, unknown>;
          if (m.role !== "user" && m.role !== "assistant") continue;
          if (typeof m.content === "string") {
            texts.push(m.content);
          } else if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
                texts.push((block as any).text);
              }
            }
          }
        }

        const capturable = texts.filter((t) => shouldCapture(t, cfg.captureQuality));
        if (capturable.length === 0) return;

        let stored = 0;
        const max = cfg.captureQuality.maxCapturesPerTurn;

        // Conversation capture
        for (const text of capturable.slice(0, max)) {
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: text, tags: extractTags(text), category: detectCategory(text), source: "auto-capture",
          });
          stored++;
        }

        // Code patterns
        for (const pattern of extractCodePatterns(capturable.join("\n\n"))) {
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: pattern.content, tags: pattern.tags, category: pattern.category, source: "auto-capture:code",
          });
          stored++;
        }

        // Error→fix pairs
        for (const pair of detectErrorFixPairs(capturable)) {
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: pair.error, tags: [...pair.errorTags, "type:error"], category: "error-fix", source: "auto-capture:error",
          });
          await callPluresLMServiceToolHttp("pluresLM_store", {
            content: pair.fix, tags: [...pair.errorTags, "type:fix"], category: "error-fix", source: "auto-capture:fix",
          });
          stored += 2;
        }

        // WIP detection
        for (const text of capturable) {
          if (isWorkInProgress(text)) {
            await callPluresLMServiceToolHttp("pluresLM_store", {
              content: text, tags: [...extractTags(text), "wip"], category: "work-in-progress", source: "auto-capture:wip",
            });
            stored++;
          }
        }

        if (stored > 0) debug(`auto-captured ${stored} memories via MCP`);
      } catch (err) {
        api.logger.warn(`pluresLM: capture failed: ${String(err)}`);
      }
    });
  }

  // ========================================================================
  // Lifecycle Hooks — Compaction Snapshot
  // ========================================================================

  api.on("before_compaction", async (event) => {
    const { summary, sessionKey, messageCount } = event as { summary?: string; sessionKey?: string; messageCount?: number };
    if (!summary || typeof summary !== "string" || summary.length < 20) return;

    try {
      const ts = new Date().toISOString();
      await callPluresLMServiceToolHttp("pluresLM_store", {
        content: `Compaction snapshot | ${sessionKey ?? "unknown"} | ${messageCount ?? "?"} messages | ${ts}\n\n${summary}`,
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
