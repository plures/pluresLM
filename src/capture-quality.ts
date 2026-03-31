/**
 * Quality gate for auto-capture.
 *
 * Filters out low-signal content (tool outputs, memory injection XML,
 * compaction artifacts, system messages, boilerplate) before storing.
 *
 * Also provides training-signal detection: corrections, confirmations,
 * failures, and preferences extracted from conversation turns.
 */

import type { ConversationWindowEntry, MemoryOutcome } from "./types.js";

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
  /^Now let me\b/i,
  /^Let me (?:check|look|verify|see|find|search|test|try|examine|inspect|confirm|also)\b/i,
  /^Good[,.]?\s+(?:now|let me|both|all)\b/i,

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

  // Message envelope metadata — Conversation/Sender info blocks injected by OpenClaw
  /Conversation info \(untrusted metadata\)/i,
  /Sender \(untrusted metadata\)/i,
  /^\s*"message_id"\s*:/,
  /^\s*"sender_id"\s*:/,

  // Pre-compaction memory flush system prompts
  /Pre-compaction memory flush/i,

  // Pure JSON objects (catches envelopes in markdown fences too)
  /^```json\s*\n\s*\{/,
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

// ---------------------------------------------------------------------------
// Training signal detection
// ---------------------------------------------------------------------------

/** The type of training signal detected in a conversation turn. */
export type TrainingSignalType = "correction" | "confirmation" | "failure" | "preference";

/** Phrases that indicate the user is correcting the assistant's last response. */
export const CORRECTION_PATTERNS: RegExp[] = [
  /\bno[,.]?\s+(?:do it|try it|use|write it|do this|that'?s? wrong)\b/i,
  /\bactually[,.]?\s+(?:do|use|try|I want|I meant)\b/i,
  /\bthat'?s? (?:wrong|incorrect|not right|not what I (?:want|meant|said|asked))\b/i,
  /\bwait[,.]?\s+(?:no|that'?s? wrong|that'?s? not)\b/i,
  /\bdon'?t do (?:that|it that way|it like that)\b/i,
  /\binstead[,.]?\s+(?:do|use|try|write)\b/i,
  /\bdo (?:it|this) (?:differently|another way|this way|like this)\b/i,
  /\bchange (?:that|it|the approach|the implementation)\b/i,
  /\bthat'?s? not (?:right|correct|what I wanted|what I meant|what I asked)\b/i,
];

/** Phrases that confirm the assistant's last response solved the problem. */
export const CONFIRMATION_PATTERNS: RegExp[] = [
  /\b(?:yes|yep|yeah)[,.]?\s+(?:that|it)\s+(?:worked|works|is correct|is right|fixed it)\b/i,
  /\bthat (?:worked|fixed it|did it|solved it|is correct|is right)\b/i,
  /\b(?:perfect|great|excellent|awesome)[,.]?\s+(?:that|it)\s+(?:worked|works|helped)\b/i,
  /\bworks? (?:perfectly|great|now|fine|correctly)\b/i,
  /\bproblem (?:solved|fixed|resolved)\b/i,
  /\bthanks?[,.]?\s+that (?:worked|did it|helped|fixed it)\b/i,
  /\bexactly (?:what I (?:wanted|needed|was looking for)|right)\b/i,
];

/** Phrases that indicate the assistant's response broke or failed to fix something. */
export const FAILURE_PATTERNS: RegExp[] = [
  /\bthat (?:broke|breaks|is breaking|broken down)\b/i,
  /\bthat (?:didn'?t?|doesn'?t?) (?:work|fix it|solve it|help)\b/i,
  /\b(?:still|now)\s+(?:broken|failing|fails|not working|crashing)\b/i,
  /\b(?:still|now)\s+(?:getting|seeing)\s+(?:the same|an?|the)\s+(?:error|bug|issue|problem)\b/i,
  /\bnot (?:working|fixed|resolved|helping)\b/i,
  /\b(?:error|exception|crash)\s+(?:still|persists|again|is back)\b/i,
  /\bthat caused\b/i,
  /\bthat (?:introduced|created|made)\s+(?:a new|an|another)\s+(?:error|bug|issue|problem)\b/i,
  /\bthat broke\b/i,
];

/** Phrases that express a user preference for one approach over another. */
export const PREFERENCE_PATTERNS: RegExp[] = [
  /\bI (?:prefer|like|want|would rather use)\s+(.+?)\s+(?:over|instead of|rather than|not)\b/i,
  /\buse\s+(.+?)\s+(?:over|instead of|not)\s+(.+?)(?:[,.]|$)/i,
  /\bI'?d? rather (?:use|have|do)\s+(.+?)\s+(?:than|over|instead of|and not)\b/i,
  /\b(.+?)\s+is better than\s+(.+?)\b/i,
  /\bplease (?:use|prefer)\s+(.+?)\s+(?:over|not|instead of)\s+(.+?)(?:[,.]|$)/i,
];

/** The result produced by `detectTrainingSignal`. */
export interface TrainingSignalResult {
  /** Which type of training signal was found. */
  signalType: TrainingSignalType;
  /**
   * Memory source for the signal.
   * "user_explicit" for preferences; "conversation" for everything else.
   */
  source: string;
  /** Outcome for confirmation/failure signals. */
  outcome?: MemoryOutcome;
  /**
   * For corrections and preferences: the approach/response that was rejected.
   * For corrections this is populated from the most recent assistant turn in
   * history (the response that was being corrected).
   */
  rejected_approach?: string | null;
  /**
   * For corrections and preferences: the approach that was chosen / preferred.
   * For corrections this is the user's corrective text.
   */
  chosen_approach?: string | null;
  /** The last ≤5 turns of the conversation leading up to this turn. */
  conversation_window: ConversationWindowEntry[];
}

/**
 * Scan the history (newest-first) for the most recent assistant message and
 * return its content, or `null` if none exists.
 */
function lastAssistantContent(history: ConversationWindowEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content;
  }
  return null;
}

/**
 * Attempt to extract chosen/rejected approaches from a preference phrase.
 *
 * Returns `{ chosen, rejected }` where either may be `null` if not parseable.
 */
function extractPreferenceApproaches(text: string): { chosen: string | null; rejected: string | null } {
  // "I prefer X over Y" / "I like X over Y" / "I want X over Y"
  const preferOverMatch = text.match(/\bI (?:prefer|like|want|would rather use)\s+(.+?)\s+(?:over|instead of|rather than|not)\s+(.+?)(?:[,.]|$)/i);
  if (preferOverMatch) {
    return { chosen: preferOverMatch[1].trim(), rejected: preferOverMatch[2].trim() };
  }

  // "use X over/instead of Y" / "please use X over Y"
  const useOverMatch = text.match(/\b(?:please )?use\s+(.+?)\s+(?:over|instead of|not)\s+(.+?)(?:[,.]|$)/i);
  if (useOverMatch) {
    return { chosen: useOverMatch[1].trim(), rejected: useOverMatch[2].trim() };
  }

  // "I'd rather use X than Y"
  const ratherMatch = text.match(/\bI'?d? rather (?:use|have|do)\s+(.+?)\s+(?:than|over|instead of|and not)\s+(.+?)(?:[,.]|$)/i);
  if (ratherMatch) {
    return { chosen: ratherMatch[1].trim(), rejected: ratherMatch[2].trim() };
  }

  // "X is better than Y"
  const betterMatch = text.match(/\b(.+?)\s+is better than\s+(.+?)(?:[,.]|$)/i);
  if (betterMatch) {
    return { chosen: betterMatch[1].trim(), rejected: betterMatch[2].trim() };
  }

  return { chosen: null, rejected: null };
}

/**
 * Detect a training signal in a conversation turn.
 *
 * Checks `text` against correction, confirmation, failure, and preference
 * patterns in priority order (correction → confirmation → failure → preference).
 *
 * @param text    The current user turn text.
 * @param history Prior conversation turns (chronological order).
 *                The last ≤5 entries are included in `conversation_window`.
 * @returns A `TrainingSignalResult` when a pattern matches, or `null`.
 */
export function detectTrainingSignal(
  text: string,
  history: ConversationWindowEntry[] = [],
): TrainingSignalResult | null {
  const conversation_window = history.slice(-5);

  if (CORRECTION_PATTERNS.some((p) => p.test(text))) {
    return {
      signalType: "correction",
      source: "conversation",
      rejected_approach: lastAssistantContent(history),
      chosen_approach: text,
      conversation_window,
    };
  }

  if (CONFIRMATION_PATTERNS.some((p) => p.test(text))) {
    return {
      signalType: "confirmation",
      source: "conversation",
      outcome: "success",
      conversation_window,
    };
  }

  if (FAILURE_PATTERNS.some((p) => p.test(text))) {
    return {
      signalType: "failure",
      source: "conversation",
      outcome: "failure",
      conversation_window,
    };
  }

  if (PREFERENCE_PATTERNS.some((p) => p.test(text))) {
    const { chosen, rejected } = extractPreferenceApproaches(text);
    return {
      signalType: "preference",
      source: "user_explicit",
      chosen_approach: chosen,
      rejected_approach: rejected,
      conversation_window,
    };
  }

  return null;
}
