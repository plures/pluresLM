/**
 * Recall/capture API for Pares Agens (Rust-native integration).
 *
 * Exposes the three core operations that Pares Agens needs to drive its
 * memory layer without going through the MCP/OpenClaw plugin path:
 *
 *   recall(query, limit, excludeCategories) → MemoryEntry[]
 *   capture(content, category, tags)        → id string | null
 *   injectContext(memories, budgetChars)    → formatted string
 *
 * Quality gate and category detection helpers are also exported so that
 * Pares Agens can apply them client-side before making RPC calls.
 */

import type { MemoryEntry } from "./types.js";
import type { PluresDBBackend } from "./pluresdb-backend.js";
import { shouldCapture, DEFAULT_CAPTURE_QUALITY_CONFIG } from "./capture-quality.js";

// ---------------------------------------------------------------------------
// Trivial-input detection (guards recall from empty/greeting prompts)
// ---------------------------------------------------------------------------

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|sure|yes|no|yep|nope|bye|gm|gn)[\s!.]*$/i,
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^\/\w+/,
];

/**
 * Returns `true` when text carries no useful signal worth recalling against.
 * Mirrors the same check used by the OpenClaw plugin's agent_start hook.
 *
 * The 20-character minimum mirrors the OpenClaw plugin's threshold: greetings,
 * one-word replies, and short acknowledgements almost never carry durable signal.
 */
export function isTrivial(text: string): boolean {
  if (text.length < 20) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(text.trim()));
}

// ---------------------------------------------------------------------------
// Category detection
// ---------------------------------------------------------------------------

/**
 * Infer a memory category from content using heuristics.
 *
 * Categories (mirrors OpenClaw plugin logic):
 *   preference  — user preferences / likes / dislikes
 *   decision    — explicit decisions or choices made
 *   entity      — named people, phone numbers, e-mail addresses
 *   explicit    — "remember this", "note:", "important:"
 *   conversation — everything else
 */
export function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(?:i prefer|i like|i love|i hate|i don't like|my favorite|i'd rather)\b/.test(lower)) return "preference";
  if (/\b(?:we decided|i decided|will use|let's use|going with)\b|decision:/.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|\b(?:named|called)\s+[A-Z]/i.test(text)) return "entity";
  if (/\b(?:remember this)\b|note:|important:/.test(lower)) return "explicit";
  return "conversation";
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/**
 * Format memories into a markdown bullet list that fits within `budgetChars`.
 *
 * Each line follows the format:
 *   `- [category] [by: originator] [status] content`
 *
 * Stops adding entries once the budget would be exceeded so the result is
 * always ≤ `budgetChars` characters.
 */
export function injectContext(
  memories: Array<{
    category: string;
    content: string;
    originator_name?: string;
    originator_id?: string;
    status?: string;
  }>,
  budgetChars: number,
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

    if (totalChars + line.length + 1 > budgetChars) break;
    lines.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MemoryAPI class
// ---------------------------------------------------------------------------

/**
 * High-level memory API used by Pares Agens for recall and capture.
 *
 * Wraps a `PluresDBBackend` instance together with an embedding function so
 * that callers do not need to manage embeddings directly.
 */
export class MemoryAPI {
  constructor(
    private readonly db: PluresDBBackend,
    private readonly embedFn: (text: string) => Promise<number[]>,
  ) {}

  /**
   * Recall relevant memories for a query using vector similarity search.
   *
   * @param query           - The text to search for.
   * @param limit           - Maximum number of results (default: 10).
   * @param excludeCategories - Category names to exclude from results.
   * @param maxPerCategory  - Max results from any single category (default: ceil(limit * 0.6)).
   * @returns Ordered list of matching memory entries (most relevant first).
   */
  async recall(
    query: string,
    limit: number = 10,
    excludeCategories?: string[],
    maxPerCategory?: number,
  ): Promise<MemoryEntry[]> {
    const embedding = await this.embedFn(query);
    const excludeSet =
      excludeCategories && excludeCategories.length > 0
        ? new Set(excludeCategories)
        : undefined;
    const cap = maxPerCategory ?? Math.ceil(limit * 0.6);
    const results = await this.db.vectorSearchBoosted(
      embedding,
      limit,
      0.3,
      {},
      excludeSet,
      cap,
    );
    return results.map((r) => r.entry);
  }

  /**
   * Store a memory after passing it through the quality gate.
   *
   * Returns the stored entry's `id` on success, or `null` when the quality
   * gate rejects the content (noise, echoes, short text, etc.).
   *
   * @param content  - The text to store.
   * @param category - Explicit category; auto-detected when omitted.
   * @param tags     - Optional tags to attach to the memory.
   */
  async capture(
    content: string,
    category?: string,
    tags?: string[],
  ): Promise<string | null> {
    if (!shouldCapture(content, DEFAULT_CAPTURE_QUALITY_CONFIG)) {
      return null;
    }
    const cat = category ?? detectCategory(content);
    const embedding = await this.embedFn(content);
    const { entry } = await this.db.store(content, embedding, {
      category: cat,
      tags: tags ?? [],
    });
    return entry.id;
  }
}
