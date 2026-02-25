/**
 * Quality gate for auto-capture.
 *
 * Filters out low-signal content (tool outputs, memory injection XML,
 * compaction artifacts, system messages, boilerplate) before storing.
 */

export interface CaptureQualityConfig {
  /** Minimum content length to store (default: 50). */
  minContentLength: number;
  /** Patterns that cause a text to be rejected. */
  skipPatterns: RegExp[];
  /** Maximum new captures per agent_end turn (default: 5). */
  maxCapturesPerTurn: number;
  /** Cosine-similarity threshold for semantic dedup (default: 0.85). */
  dedupeThreshold: number;
}

/**
 * Default rejection patterns:
 * - Tool outputs (XML tags or JSON starting with `{`)
 * - Memory injection artifacts
 * - Compaction / truncation markers
 * - System messages
 * - PluresLM tool references (memories about memories)
 * - Pure boilerplate without substantive content
 */
export const DEFAULT_SKIP_PATTERNS: RegExp[] = [
  // Tool output XML wrappers
  /\[tool_result\]/i,
  /<tool_result/i,

  // Memory injection XML artifacts
  /<relevant-memories>/i,
  /<session-context>/i,
  /<user-profile>/i,
  /<memory-context>/i,

  // Compaction / truncation markers
  /\[compacted:/i,
  /\[truncated:/i,

  // System messages
  /^\[System Message\]/,

  // PluresLM tool references (memories about memories)
  /pluresLM_store|pluresLM_search/i,

  // Boilerplate openers with no substantive content
  /^I'll help you with\b[^.!?]*[.!?]?\s*$/i,
  /^Let me check\b[^.!?]*[.!?]?\s*$/i,
  /^Here's what I found\b[^.!?]*[.!?]?\s*$/i,

  // Memory recall echoes — LLM quoting back stored memories
  /\[by: .*Desktop\]/i,
  /\[by: .*Mobile\]/i,
  /^\[(?:preference|decision|work-in-progress|conversation|error-fix|project-context)\]/i,

  // HEARTBEAT_OK / NO_REPLY (should already be caught by trivial check but belt+suspenders)
  /^HEARTBEAT_OK\s*$/,
  /^NO_REPLY\s*$/,

  // Git/CLI output noise
  /^(?:On branch|Your branch|nothing to commit|Already up to date)/,
  /^\s*\d+ files? changed/,
];

/** JSON tool output — text that begins with `{` (after trimming). */
function isJsonToolOutput(text: string): boolean {
  return text.trimStart().startsWith("{");
}

export const DEFAULT_CAPTURE_QUALITY_CONFIG: CaptureQualityConfig = {
  minContentLength: 50,
  skipPatterns: DEFAULT_SKIP_PATTERNS,
  maxCapturesPerTurn: 5,
  dedupeThreshold: 0.85,
};

/**
 * Returns `true` when the text is worth storing as a memory.
 * Returns `false` for noise: tool outputs, injection XML, compaction artifacts,
 * system messages, boilerplate, and references to PluresLM tools.
 */
export function shouldCapture(
  text: string,
  config: Pick<CaptureQualityConfig, "minContentLength" | "skipPatterns"> = DEFAULT_CAPTURE_QUALITY_CONFIG,
): boolean {
  if (text.length < config.minContentLength) return false;
  if (isJsonToolOutput(text)) return false;
  return !config.skipPatterns.some((p) => p.test(text));
}
