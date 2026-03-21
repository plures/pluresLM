/**
 * Memory Admission — Praxis Module
 *
 * Declarative logic for deciding what gets stored in PluresLM.
 * Covers store/reject gates, exact-hash dedup detection, and vector-similarity
 * near-duplicate flagging.
 *
 * Exported:
 * - `MemoryAdmissionContext` — typed context for this module
 * - `memoryAdmissionModule` — ready-to-register PraxisModule
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
} from "@plures/praxis";
import type { MemoryPriority } from "../types.js";
import {
  shouldCapture,
  DEFAULT_CAPTURE_QUALITY_CONFIG,
  type CaptureQualityConfig,
} from "../capture-quality.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface MemoryAdmissionContext {
  /** Raw content being evaluated for admission. */
  content: string;
  /** Minimum acceptable content length (chars). */
  minContentLength: number;
  /** Rejection patterns forwarded from CaptureQualityConfig. */
  skipPatterns: RegExp[];
  /** Memory category (e.g. "conversation", "decision"). */
  category: string;
  /** Tags to be stored with the memory. */
  tags: string[];
  /** Caller-supplied importance score (default: 1.0). */
  importance_score: number;
  /**
   * Cosine-similarity threshold for near-duplicate detection.
   * Set to the score returned by the nearest-neighbour vector search.
   * Range [0, 1]. 0 means "no neighbour found".
   */
  vectorNeighbourScore: number;
  /** The configured dedup threshold [0, 1]. Near-duplicate if vectorNeighbourScore >= this. */
  dedupeThreshold: number;
  /** True when the exact content hash already exists in the recent-capture LRU. */
  isDuplicateHash: boolean;
  /** Priority of the incoming memory. */
  priority: MemoryPriority;
}

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

export function defaultMemoryAdmissionContext(
  overrides: Partial<MemoryAdmissionContext> = {},
): MemoryAdmissionContext {
  return {
    content: "",
    minContentLength: DEFAULT_CAPTURE_QUALITY_CONFIG.minContentLength,
    skipPatterns: DEFAULT_CAPTURE_QUALITY_CONFIG.skipPatterns,
    category: "conversation",
    tags: [],
    importance_score: 1.0,
    vectorNeighbourScore: 0,
    dedupeThreshold: DEFAULT_CAPTURE_QUALITY_CONFIG.dedupeThreshold,
    isDuplicateHash: false,
    priority: "normal",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fact tags
// ---------------------------------------------------------------------------

export const ADMISSION_FACTS = {
  ADMITTED: "memory.admitted",
  REJECTED_LENGTH: "memory.rejected.length",
  REJECTED_NOISE: "memory.rejected.noise",
  REJECTED_DUPLICATE_HASH: "memory.rejected.duplicate-hash",
  DEDUP_CANDIDATE: "memory.dedup.candidate",
} as const;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const lengthGateContract = defineContract({
  ruleId: "admission.length-gate",
  behavior: "Reject content that is shorter than minContentLength characters",
  examples: [
    {
      given: "content is 30 chars, minContentLength is 50",
      when: "admission.length-gate evaluates",
      then: "emits memory.rejected.length fact",
    },
    {
      given: "content is 100 chars, minContentLength is 50",
      when: "admission.length-gate evaluates",
      then: "returns noop (length is sufficient)",
    },
  ],
  invariants: [
    "content.length >= minContentLength must pass for admission",
    "content.length < minContentLength always produces rejection fact",
  ],
});

const noiseFilterContract = defineContract({
  ruleId: "admission.noise-filter",
  behavior:
    "Reject content that matches known noise patterns (tool output XML, memory injection artifacts, boilerplate)",
  examples: [
    {
      given: "content starts with '{'",
      when: "admission.noise-filter evaluates",
      then: "emits memory.rejected.noise fact",
    },
    {
      given: "content contains '<tool_result'",
      when: "admission.noise-filter evaluates",
      then: "emits memory.rejected.noise fact",
    },
    {
      given: "content is substantive prose with no noise markers",
      when: "admission.noise-filter evaluates",
      then: "returns noop (content is clean)",
    },
  ],
  invariants: [
    "shouldCapture must return false for any content that matches a noise pattern",
    "noise-filter runs after length-gate (empty rejects already handled)",
  ],
});

const duplicateHashContract = defineContract({
  ruleId: "admission.duplicate-hash",
  behavior: "Reject content whose djb2 hash already exists in the recent-capture LRU cache",
  examples: [
    {
      given: "isDuplicateHash is true",
      when: "admission.duplicate-hash evaluates",
      then: "emits memory.rejected.duplicate-hash fact",
    },
    {
      given: "isDuplicateHash is false",
      when: "admission.duplicate-hash evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "exact content duplicates within the same session LRU window are never stored twice",
  ],
});

const vectorDedupContract = defineContract({
  ruleId: "admission.dedup-vector",
  behavior:
    "Flag content as a near-duplicate candidate when vectorNeighbourScore >= dedupeThreshold",
  examples: [
    {
      given: "vectorNeighbourScore is 0.97, dedupeThreshold is 0.95",
      when: "admission.dedup-vector evaluates",
      then: "emits memory.dedup.candidate fact",
    },
    {
      given: "vectorNeighbourScore is 0.80, dedupeThreshold is 0.95",
      when: "admission.dedup-vector evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "vectorNeighbourScore >= dedupeThreshold always produces a dedup.candidate fact",
  ],
});

const admittedContract = defineContract({
  ruleId: "admission.admit",
  behavior: "Emit memory.admitted fact when content passes all quality gates",
  examples: [
    {
      given: "content passes length and noise gates and is not a hash duplicate",
      when: "admission.admit evaluates",
      then: "emits memory.admitted fact",
    },
  ],
  invariants: [
    "memory.admitted is only emitted when shouldCapture returns true and isDuplicateHash is false",
  ],
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Praxis module for memory admission logic.
 *
 * Rules (in evaluation order):
 * 1. `admission.length-gate`    — reject below minContentLength
 * 2. `admission.noise-filter`   — reject noise/boilerplate patterns
 * 3. `admission.duplicate-hash` — reject exact-hash duplicates
 * 4. `admission.dedup-vector`   — flag near-duplicate candidates
 * 5. `admission.admit`          — emit admitted fact when all gates pass
 *
 * Constraints:
 * - `admission.content-non-empty` — content must be a non-empty string
 */
export const memoryAdmissionModule = defineModule<MemoryAdmissionContext>({
  rules: [
    {
      id: "admission.length-gate",
      description: "Reject content shorter than minContentLength",
      contract: lengthGateContract,
      impl(state) {
        const { content, minContentLength } = state.context;
        if (content.length < minContentLength) {
          return RuleResult.emit([
            fact(ADMISSION_FACTS.REJECTED_LENGTH, {
              contentLength: content.length,
              minContentLength,
            }),
          ]);
        }
        return RuleResult.noop("content length sufficient");
      },
    },
    {
      id: "admission.noise-filter",
      description: "Reject content that matches noise/boilerplate patterns",
      contract: noiseFilterContract,
      impl(state) {
        const { content, minContentLength, skipPatterns } = state.context;
        const qualityCfg: Pick<CaptureQualityConfig, "minContentLength" | "skipPatterns"> = {
          minContentLength,
          skipPatterns,
        };
        // shouldCapture already handles length — we call it here for the noise patterns only.
        // We bypass the length gate here by setting minContentLength to 0,
        // since length was already evaluated above.
        const noiseCheckCfg: Pick<CaptureQualityConfig, "minContentLength" | "skipPatterns"> = {
          minContentLength: 0,
          skipPatterns: qualityCfg.skipPatterns,
        };
        if (!shouldCapture(content, noiseCheckCfg)) {
          return RuleResult.emit([
            fact(ADMISSION_FACTS.REJECTED_NOISE, {
              contentLength: content.length,
              reason: "noise-pattern-match",
            }),
          ]);
        }
        return RuleResult.noop("content passes noise filter");
      },
    },
    {
      id: "admission.duplicate-hash",
      description: "Reject content whose hash already exists in the LRU cache",
      contract: duplicateHashContract,
      impl(state) {
        if (state.context.isDuplicateHash) {
          return RuleResult.emit([
            fact(ADMISSION_FACTS.REJECTED_DUPLICATE_HASH, {
              contentLength: state.context.content.length,
              reason: "duplicate-hash",
            }),
          ]);
        }
        return RuleResult.noop("content hash is unique");
      },
    },
    {
      id: "admission.dedup-vector",
      description: "Flag near-duplicate candidates via vector similarity",
      contract: vectorDedupContract,
      impl(state) {
        const { vectorNeighbourScore, dedupeThreshold } = state.context;
        if (vectorNeighbourScore >= dedupeThreshold) {
          return RuleResult.emit([
            fact(ADMISSION_FACTS.DEDUP_CANDIDATE, {
              score: vectorNeighbourScore,
              threshold: dedupeThreshold,
            }),
          ]);
        }
        return RuleResult.noop("no near-duplicate");
      },
    },
    {
      id: "admission.admit",
      description: "Admit content that passes all quality gates",
      contract: admittedContract,
      impl(state) {
        const { content, minContentLength, skipPatterns, isDuplicateHash } = state.context;
        const qualityCfg: Pick<CaptureQualityConfig, "minContentLength" | "skipPatterns"> = {
          minContentLength,
          skipPatterns,
        };
        if (shouldCapture(content, qualityCfg) && !isDuplicateHash) {
          return RuleResult.emit([
            fact(ADMISSION_FACTS.ADMITTED, {
              category: state.context.category,
              tags: state.context.tags,
              importance_score: state.context.importance_score,
              priority: state.context.priority,
            }),
          ]);
        }
        return RuleResult.noop("content did not pass all gates");
      },
    },
  ],
  constraints: [
    {
      id: "admission.content-non-empty",
      description: "Content must be a non-empty string",
      contract: defineContract({
        ruleId: "admission.content-non-empty",
        behavior: "Enforce that content is always a non-empty string before admission rules run",
        examples: [
          { given: "content is an empty string", when: "constraint is checked", then: "returns error message" },
          { given: "content is a non-empty string", when: "constraint is checked", then: "returns true" },
        ],
        invariants: ["content must be typeof string and non-empty"],
      }),
      impl(state) {
        const { content } = state.context;
        if (typeof content !== "string" || content.trim().length === 0) {
          return "content must be a non-empty string";
        }
        return true;
      },
    },
    {
      id: "admission.threshold-range",
      description: "dedupeThreshold must be in range [0, 1]",
      contract: defineContract({
        ruleId: "admission.threshold-range",
        behavior: "Enforce that dedupeThreshold is a valid cosine similarity value in [0, 1]",
        examples: [
          { given: "dedupeThreshold is 1.1", when: "constraint is checked", then: "returns error message" },
          { given: "dedupeThreshold is 0.95", when: "constraint is checked", then: "returns true" },
        ],
        invariants: ["dedupeThreshold must be in [0, 1]"],
      }),
      impl(state) {
        const { dedupeThreshold } = state.context;
        if (dedupeThreshold < 0 || dedupeThreshold > 1) {
          return `dedupeThreshold must be between 0 and 1, got ${dedupeThreshold}`;
        }
        return true;
      },
    },
  ],
  meta: {
    module: "memory-admission",
    version: "1.0.0",
  },
});
