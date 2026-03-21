/**
 * Auto-Capture — Praxis Module
 *
 * Declarative logic for which code patterns, conversation turns, and
 * contextual signals trigger automatic memory creation in PluresLM.
 *
 * Exported:
 * - `AutoCaptureContext` — typed context for this module
 * - `autoCaptureModule`  — ready-to-register PraxisModule
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
} from "@plures/praxis";
import {
  shouldCapture,
  DEFAULT_CAPTURE_QUALITY_CONFIG,
  type CaptureQualityConfig,
} from "../capture-quality.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AutoCaptureContext {
  /**
   * The texts extracted from the current agent turn
   * (one per message role block).
   */
  texts: string[];
  /**
   * Total number of items already queued for capture in this turn.
   * Rules that queue additional captures should check against maxCapturesPerTurn.
   */
  captureCount: number;
  /** Maximum captures allowed per agent_end turn. */
  maxCapturesPerTurn: number;
  /** Quality configuration used to filter texts. */
  captureQuality: Pick<CaptureQualityConfig, "minContentLength" | "skipPatterns">;
  /**
   * Pre-classified signal flags, typically derived from extractCodePatterns /
   * detectErrorFixPairs / isWorkInProgress helpers before the engine step.
   */
  hasCodePattern: boolean;
  hasErrorFix: boolean;
  isWorkInProgress: boolean;
  /** Source tag to attach to stored captures (e.g. "auto-capture"). */
  source: string;
}

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

export function defaultAutoCaptureContext(
  overrides: Partial<AutoCaptureContext> = {},
): AutoCaptureContext {
  return {
    texts: [],
    captureCount: 0,
    maxCapturesPerTurn: DEFAULT_CAPTURE_QUALITY_CONFIG.maxCapturesPerTurn,
    captureQuality: {
      minContentLength: DEFAULT_CAPTURE_QUALITY_CONFIG.minContentLength,
      skipPatterns: DEFAULT_CAPTURE_QUALITY_CONFIG.skipPatterns,
    },
    hasCodePattern: false,
    hasErrorFix: false,
    isWorkInProgress: false,
    source: "auto-capture",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fact tags
// ---------------------------------------------------------------------------

export const CAPTURE_FACTS = {
  QUEUED: "capture.queued",
  SKIPPED_MAX: "capture.skipped.max-turn-cap",
  SKIPPED_EMPTY: "capture.skipped.no-capturable-texts",
  CODE_PATTERN: "capture.code-pattern",
  ERROR_FIX: "capture.error-fix",
  WIP: "capture.wip",
} as const;

/** Payload shape emitted by the `capture.quality-gate` rule. */
export interface QueuedCapturePayload {
  texts: string[];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const qualityGateContract = defineContract({
  ruleId: "capture.quality-gate",
  behavior: "Filter the texts list down to only capturable items using shouldCapture; skips entirely when the turn cap is already reached",
  examples: [
    {
      given: "texts contains a noise item and a substantive item, captureCount < maxCapturesPerTurn",
      when: "capture.quality-gate evaluates",
      then: "emits capture.queued fact containing only the substantive items",
    },
    {
      given: "all texts fail shouldCapture",
      when: "capture.quality-gate evaluates",
      then: "emits capture.skipped.no-capturable-texts fact",
    },
    {
      given: "captureCount >= maxCapturesPerTurn",
      when: "capture.quality-gate evaluates",
      then: "skips without emitting capture.queued",
    },
  ],
  invariants: [
    "capture.queued is never emitted when captureCount >= maxCapturesPerTurn",
    "capture.queued payload always contains a non-empty texts array",
    "capture.skipped.no-capturable-texts is emitted when texts is empty or all texts fail quality gate",
  ],
});

const maxTurnCapContract = defineContract({
  ruleId: "capture.max-turn-cap",
  behavior: "Prevent storing more than maxCapturesPerTurn memories in a single agent_end turn",
  examples: [
    {
      given: "captureCount equals maxCapturesPerTurn",
      when: "capture.max-turn-cap evaluates",
      then: "emits capture.skipped.max-turn-cap fact",
    },
    {
      given: "captureCount is 2, maxCapturesPerTurn is 5",
      when: "capture.max-turn-cap evaluates",
      then: "returns noop (capacity remaining)",
    },
  ],
  invariants: [
    "captureCount must never exceed maxCapturesPerTurn",
    "skipped fact is emitted immediately when cap is reached",
  ],
});

const codePatternContract = defineContract({
  ruleId: "capture.code-pattern",
  behavior: "Emit a code-pattern capture fact when a code pattern was detected in the turn texts",
  examples: [
    {
      given: "hasCodePattern is true and captureCount < maxCapturesPerTurn",
      when: "capture.code-pattern evaluates",
      then: "emits capture.code-pattern fact",
    },
    {
      given: "hasCodePattern is false",
      when: "capture.code-pattern evaluates",
      then: "returns skip (no code pattern present)",
    },
  ],
  invariants: [
    "capture.code-pattern is only emitted when hasCodePattern is true",
    "category for code patterns is always 'code'",
  ],
});

const errorFixContract = defineContract({
  ruleId: "capture.error-fix",
  behavior: "Emit an error-fix capture fact when an error/fix pair was detected in the turn texts",
  examples: [
    {
      given: "hasErrorFix is true and captureCount < maxCapturesPerTurn",
      when: "capture.error-fix evaluates",
      then: "emits capture.error-fix fact",
    },
    {
      given: "hasErrorFix is false",
      when: "capture.error-fix evaluates",
      then: "returns skip",
    },
  ],
  invariants: [
    "capture.error-fix is only emitted when hasErrorFix is true",
    "category for error/fix pairs is always 'error-fix'",
  ],
});

const wipContract = defineContract({
  ruleId: "capture.wip",
  behavior: "Emit a WIP capture fact when an in-progress work item was detected in the turn texts",
  examples: [
    {
      given: "isWorkInProgress is true and captureCount < maxCapturesPerTurn",
      when: "capture.wip evaluates",
      then: "emits capture.wip fact",
    },
    {
      given: "isWorkInProgress is false",
      when: "capture.wip evaluates",
      then: "returns skip",
    },
  ],
  invariants: [
    "capture.wip is only emitted when isWorkInProgress is true",
    "WIP memories always have the 'wip' tag and 'work-in-progress' category",
  ],
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Praxis module for auto-capture logic.
 *
 * Rules:
 * 1. `capture.quality-gate`  — filter texts via shouldCapture
 * 2. `capture.max-turn-cap`  — enforce maxCapturesPerTurn limit
 * 3. `capture.code-pattern`  — flag code-pattern captures
 * 4. `capture.error-fix`     — flag error/fix-pair captures
 * 5. `capture.wip`           — flag work-in-progress captures
 *
 * Constraints:
 * - `capture.source-required` — source must be a non-empty string
 * - `capture.max-positive`    — maxCapturesPerTurn must be > 0
 */
export const autoCaptureModule = defineModule<AutoCaptureContext>({
  rules: [
    {
      id: "capture.quality-gate",
      description: "Filter texts to capturable items using shouldCapture",
      contract: qualityGateContract,
      impl(state) {
        const { texts, captureQuality, captureCount, maxCapturesPerTurn } = state.context;
        if (captureCount >= maxCapturesPerTurn) {
          return RuleResult.skip("at max captures per turn — handled by max-turn-cap rule");
        }
        const capturable = texts.filter((t) => shouldCapture(t, captureQuality));
        if (capturable.length === 0) {
          return RuleResult.emit([fact(CAPTURE_FACTS.SKIPPED_EMPTY, { textCount: texts.length })]);
        }
        return RuleResult.emit([fact(CAPTURE_FACTS.QUEUED, { texts: capturable })]);
      },
    },
    {
      id: "capture.max-turn-cap",
      description: "Enforce maxCapturesPerTurn limit per agent_end turn",
      contract: maxTurnCapContract,
      impl(state) {
        const { captureCount, maxCapturesPerTurn } = state.context;
        if (captureCount >= maxCapturesPerTurn) {
          return RuleResult.emit([
            fact(CAPTURE_FACTS.SKIPPED_MAX, { captureCount, maxCapturesPerTurn }),
          ]);
        }
        return RuleResult.noop("capture count within limit");
      },
    },
    {
      id: "capture.code-pattern",
      description: "Queue code-pattern captures when hasCodePattern is true",
      contract: codePatternContract,
      impl(state) {
        const { hasCodePattern, captureCount, maxCapturesPerTurn, source } = state.context;
        if (!hasCodePattern) {
          return RuleResult.skip("no code pattern detected");
        }
        if (captureCount >= maxCapturesPerTurn) {
          return RuleResult.skip("at max captures per turn");
        }
        return RuleResult.emit([
          fact(CAPTURE_FACTS.CODE_PATTERN, {
            category: "code",
            source: `${source}:code`,
            tags: ["code-pattern"],
          }),
        ]);
      },
    },
    {
      id: "capture.error-fix",
      description: "Queue error/fix-pair captures when hasErrorFix is true",
      contract: errorFixContract,
      impl(state) {
        const { hasErrorFix, captureCount, maxCapturesPerTurn, source } = state.context;
        if (!hasErrorFix) {
          return RuleResult.skip("no error/fix pair detected");
        }
        if (captureCount >= maxCapturesPerTurn) {
          return RuleResult.skip("at max captures per turn");
        }
        return RuleResult.emit([
          fact(CAPTURE_FACTS.ERROR_FIX, {
            category: "error-fix",
            source: `${source}:error`,
            tags: ["error-fix"],
          }),
        ]);
      },
    },
    {
      id: "capture.wip",
      description: "Queue WIP captures when isWorkInProgress is true",
      contract: wipContract,
      impl(state) {
        const { isWorkInProgress, captureCount, maxCapturesPerTurn, source } = state.context;
        if (!isWorkInProgress) {
          return RuleResult.skip("no WIP detected");
        }
        if (captureCount >= maxCapturesPerTurn) {
          return RuleResult.skip("at max captures per turn");
        }
        return RuleResult.emit([
          fact(CAPTURE_FACTS.WIP, {
            category: "work-in-progress",
            source: `${source}:wip`,
            tags: ["wip"],
          }),
        ]);
      },
    },
  ],
  constraints: [
    {
      id: "capture.source-required",
      description: "source must be a non-empty string",
      contract: defineContract({
        ruleId: "capture.source-required",
        behavior: "Enforce that capture source is always set to a non-empty string",
        examples: [
          { given: "source is empty string", when: "constraint is checked", then: "returns error" },
          { given: "source is 'auto-capture'", when: "constraint is checked", then: "returns true" },
        ],
        invariants: ["source must be typeof string and non-empty"],
      }),
      impl(state) {
        if (typeof state.context.source !== "string" || state.context.source.trim().length === 0) {
          return "capture source must be a non-empty string";
        }
        return true;
      },
    },
    {
      id: "capture.max-positive",
      description: "maxCapturesPerTurn must be a positive integer",
      contract: defineContract({
        ruleId: "capture.max-positive",
        behavior: "Enforce that maxCapturesPerTurn is a positive integer",
        examples: [
          { given: "maxCapturesPerTurn is 0", when: "constraint is checked", then: "returns error" },
          { given: "maxCapturesPerTurn is 5", when: "constraint is checked", then: "returns true" },
        ],
        invariants: ["maxCapturesPerTurn must be a positive integer"],
      }),
      impl(state) {
        const { maxCapturesPerTurn } = state.context;
        if (!Number.isInteger(maxCapturesPerTurn) || maxCapturesPerTurn <= 0) {
          return `maxCapturesPerTurn must be a positive integer, got ${maxCapturesPerTurn}`;
        }
        return true;
      },
    },
  ],
  meta: {
    module: "auto-capture",
    version: "1.0.0",
  },
});
