/**
 * Analysis Coprocessor — Praxis Module
 *
 * Declarative logic for the decision-ledger side-process in PluresLM.
 * Runs asynchronously over extracted primitives and emits analysis artifacts:
 *
 * - conflict detection
 * - objective alignment scoring
 * - risk propagation
 * - missing-evidence detection
 * - recommended next action(s)
 *
 * Exported:
 * - `AnalysisContext`            — typed context for this module
 * - `analysisCoprocessorModule`  — ready-to-register PraxisModule
 * - `ANALYSIS_FACTS`             — fact tag constants
 * - `defaultAnalysisContext`     — default context factory
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
} from "@plures/praxis";

// ---------------------------------------------------------------------------
// Primitive kinds (aligns with Phase 1 extraction vocabulary)
// ---------------------------------------------------------------------------

export type PrimitiveKind =
  | "fact"
  | "rule"
  | "constraint"
  | "objective"
  | "hypothesis"
  | "risk"
  | "decision"
  | "evidence"
  | "action-item";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * A single primitive extracted from a conversation turn or memory record.
 * Each primitive is linked back to its source memory via `sourceId`.
 */
export interface AnalysisPrimitive {
  /** Unique identifier for this primitive (may equal sourceId when not sub-sliced). */
  id: string;
  /** Identifier of the source memory entry this primitive came from. */
  sourceId: string;
  /** Semantic kind of this primitive. */
  kind: PrimitiveKind;
  /** Textual content of the primitive. */
  content: string;
  /**
   * Confidence score in [0, 1].  1.0 = certain, 0.0 = purely speculative.
   */
  confidence: number;
  /**
   * Free-form tags inherited from the source memory.
   * Used by alignment and propagation rules.
   */
  tags: string[];
}

export interface AnalysisContext {
  /**
   * The set of primitives to analyse in this batch.
   * At least one primitive must be present for any analysis rule to fire.
   */
  primitives: AnalysisPrimitive[];
  /**
   * Minimum confidence threshold below which a primitive is flagged as
   * lacking supporting evidence (default: 0.5).
   */
  evidenceThreshold: number;
  /**
   * Cosine-similarity-like score in [0, 1] representing how well the current
   * set of objectives aligns with the broader goal context supplied by the
   * caller (default: 0).  Rules use this pre-computed score rather than
   * recomputing it inside the engine so the Praxis layer stays pure logic.
   */
  objectiveAlignmentScore: number;
  /**
   * True when at least one `risk` primitive is linked (via tags or content)
   * to an `objective` or `decision` primitive in the batch.
   * Pre-computed by the caller before invoking the engine.
   */
  hasLinkedRisk: boolean;
  /**
   * Identifier passed through to every emitted analysis fact so that
   * downstream storage can link artifacts back to their originating session
   * or conversation turn.
   */
  analysisSessionId: string;
}

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

export function defaultAnalysisContext(
  overrides: Partial<AnalysisContext> = {},
): AnalysisContext {
  return {
    primitives: [],
    evidenceThreshold: 0.5,
    objectiveAlignmentScore: 0,
    hasLinkedRisk: false,
    analysisSessionId: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fact tags
// ---------------------------------------------------------------------------

export const ANALYSIS_FACTS = {
  /** No primitives supplied — analysis skipped. */
  SKIPPED_EMPTY: "analysis.skipped.no-primitives",
  /** Two or more primitives have conflicting assertions. */
  CONFLICT_DETECTED: "analysis.conflict-detected",
  /** Objective alignment score meets or exceeds the passing threshold (≥0.7). */
  OBJECTIVE_ALIGNED: "analysis.objective-aligned",
  /** Objective alignment score falls below the passing threshold (<0.7). */
  OBJECTIVE_MISALIGNED: "analysis.objective-misaligned",
  /** A risk primitive is propagated to a linked objective or decision. */
  RISK_PROPAGATED: "analysis.risk-propagated",
  /** One or more hypothesis/decision primitives lack supporting evidence. */
  EVIDENCE_MISSING: "analysis.evidence-missing",
  /** At least one recommended next action was derived from the batch. */
  NEXT_ACTION_RECOMMENDED: "analysis.next-action-recommended",
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when two content strings are semantically contradictory based
 * on simple negation / antonym heuristics.  This is intentionally lightweight
 * — callers should complement it with embedding-level similarity if available.
 */
function areContradictory(a: string, b: string): boolean {
  const negations = [
    [/\bwill\b/i, /\bwill not\b|\bwon'?t\b/i],
    [/\bshould\b/i, /\bshould not\b|\bshouldn'?t\b/i],
    [/\bmust\b/i, /\bmust not\b|\bmustn'?t\b/i],
    [/\buse\b/i, /\bdo not use\b|\bdon'?t use\b|\bavoid\b/i],
    [/\bprefer\b/i, /\bdo not prefer\b|\bavoid\b/i],
    [/\balways\b/i, /\bnever\b/i],
    [/\bnever\b/i, /\balways\b/i],
  ];
  for (const [posPat, negPat] of negations) {
    if (posPat.test(a) && negPat.test(b)) return true;
    if (posPat.test(b) && negPat.test(a)) return true;
  }
  return false;
}

/**
 * Checks whether a `hypothesis` or `decision` primitive has at least one
 * corroborating `evidence` primitive in the batch.
 */
function hasEvidence(
  primitive: AnalysisPrimitive,
  batch: AnalysisPrimitive[],
): boolean {
  return batch.some(
    (p) =>
      p.kind === "evidence" &&
      (p.tags.some((t) => primitive.tags.includes(t)) ||
        primitive.content
          .toLowerCase()
          .split(/\s+/)
          .some((word) => word.length > 4 && p.content.toLowerCase().includes(word))),
  );
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const emptyBatchContract = defineContract({
  ruleId: "analysis.empty-batch",
  behavior:
    "Skip all analysis rules and emit analysis.skipped.no-primitives when the primitives array is empty",
  examples: [
    {
      given: "primitives array is empty",
      when: "analysis.empty-batch evaluates",
      then: "emits analysis.skipped.no-primitives fact",
    },
    {
      given: "primitives contains at least one item",
      when: "analysis.empty-batch evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "analysis.skipped.no-primitives is only emitted when primitives.length === 0",
  ],
});

const conflictContract = defineContract({
  ruleId: "analysis.conflict-detection",
  behavior:
    "Detect pairs of rule/constraint/decision primitives whose content is semantically contradictory",
  examples: [
    {
      given: "two rule primitives where one says 'always use X' and another says 'never use X'",
      when: "analysis.conflict-detection evaluates",
      then: "emits analysis.conflict-detected fact with both primitive IDs",
    },
    {
      given: "no contradictory primitives in batch",
      when: "analysis.conflict-detection evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "analysis.conflict-detected payload always contains primitiveIds with at least 2 entries",
    "only rule, constraint, and decision primitives are compared for contradictions",
  ],
});

const objectiveAlignmentContract = defineContract({
  ruleId: "analysis.objective-alignment",
  behavior:
    "Score the batch against the provided objectiveAlignmentScore and emit aligned or misaligned fact",
  examples: [
    {
      given: "objectiveAlignmentScore is 0.85 (≥0.7 threshold)",
      when: "analysis.objective-alignment evaluates",
      then: "emits analysis.objective-aligned fact",
    },
    {
      given: "objectiveAlignmentScore is 0.3 (<0.7 threshold)",
      when: "analysis.objective-alignment evaluates",
      then: "emits analysis.objective-misaligned fact",
    },
    {
      given: "no objective primitives in batch",
      when: "analysis.objective-alignment evaluates",
      then: "returns skip",
    },
  ],
  invariants: [
    "exactly one of analysis.objective-aligned or analysis.objective-misaligned is emitted when objective primitives exist",
    "neither fact is emitted when there are no objective primitives",
  ],
});

const riskPropagationContract = defineContract({
  ruleId: "analysis.risk-propagation",
  behavior:
    "Propagate risk primitives to linked objectives or decisions when hasLinkedRisk is true",
  examples: [
    {
      given: "hasLinkedRisk is true and at least one risk primitive is in the batch",
      when: "analysis.risk-propagation evaluates",
      then: "emits analysis.risk-propagated fact",
    },
    {
      given: "hasLinkedRisk is false",
      when: "analysis.risk-propagation evaluates",
      then: "returns noop",
    },
    {
      given: "no risk primitives in batch",
      when: "analysis.risk-propagation evaluates",
      then: "returns skip",
    },
  ],
  invariants: [
    "analysis.risk-propagated is only emitted when hasLinkedRisk is true",
    "analysis.risk-propagated payload always contains at least one riskId",
  ],
});

const missingEvidenceContract = defineContract({
  ruleId: "analysis.missing-evidence",
  behavior:
    "Flag hypothesis and decision primitives with confidence below evidenceThreshold that lack corroborating evidence primitives",
  examples: [
    {
      given:
        "a hypothesis primitive with confidence 0.3 (below default 0.5 threshold) and no supporting evidence",
      when: "analysis.missing-evidence evaluates",
      then: "emits analysis.evidence-missing fact with the primitive ID",
    },
    {
      given: "all hypothesis/decision primitives have confidence >= evidenceThreshold",
      when: "analysis.missing-evidence evaluates",
      then: "returns noop",
    },
    {
      given: "no hypothesis or decision primitives in batch",
      when: "analysis.missing-evidence evaluates",
      then: "returns skip",
    },
  ],
  invariants: [
    "analysis.evidence-missing payload always contains at least one primitiveId",
    "only hypothesis and decision primitives are checked for missing evidence",
  ],
});

const nextActionContract = defineContract({
  ruleId: "analysis.next-action",
  behavior:
    "Recommend next actions derived from action-item primitives or from unresolved risk/decision primitives",
  examples: [
    {
      given: "one or more action-item primitives in batch",
      when: "analysis.next-action evaluates",
      then: "emits analysis.next-action-recommended fact with action content",
    },
    {
      given: "a risk primitive with no paired decision to mitigate it",
      when: "analysis.next-action evaluates",
      then: "emits analysis.next-action-recommended fact suggesting mitigation",
    },
    {
      given: "no action-item primitives and no unresolved risks",
      when: "analysis.next-action evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "analysis.next-action-recommended payload always contains a non-empty actions array",
  ],
});

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/**
 * Minimum objectiveAlignmentScore [0, 1] for a batch to be considered aligned.
 * Scores at or above this threshold emit `analysis.objective-aligned`;
 * scores below it emit `analysis.objective-misaligned`.
 */
export const OBJECTIVE_ALIGNMENT_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Praxis module for the decision-ledger analysis coprocessor.
 *
 * Rules (in evaluation order):
 * 1. `analysis.empty-batch`         — guard: skip when no primitives supplied
 * 2. `analysis.conflict-detection`  — detect contradictory rule/constraint/decision pairs
 * 3. `analysis.objective-alignment` — score objective alignment
 * 4. `analysis.risk-propagation`    — propagate risk to linked objectives/decisions
 * 5. `analysis.missing-evidence`    — flag low-confidence hypotheses/decisions without evidence
 * 6. `analysis.next-action`         — recommend next actions from action-items / unresolved risks
 *
 * Constraints:
 * - `analysis.session-id-required`      — analysisSessionId must be non-empty
 * - `analysis.evidence-threshold-range` — evidenceThreshold must be in (0, 1]
 */
export const analysisCoprocessorModule = defineModule<AnalysisContext>({
  rules: [
    // ------------------------------------------------------------------
    // 1. Empty-batch guard
    // ------------------------------------------------------------------
    {
      id: "analysis.empty-batch",
      description: "Skip all analysis when no primitives are provided",
      contract: emptyBatchContract,
      impl(state) {
        if (state.context.primitives.length === 0) {
          return RuleResult.emit([
            fact(ANALYSIS_FACTS.SKIPPED_EMPTY, { primitiveCount: 0 }),
          ]);
        }
        return RuleResult.noop("batch contains primitives — proceeding with analysis");
      },
    },

    // ------------------------------------------------------------------
    // 2. Conflict detection
    // ------------------------------------------------------------------
    {
      id: "analysis.conflict-detection",
      description: "Detect contradictory rule/constraint/decision primitive pairs",
      contract: conflictContract,
      impl(state) {
        const { primitives } = state.context;
        if (primitives.length === 0) {
          return RuleResult.skip("empty batch — handled by empty-batch rule");
        }

        const candidates = primitives.filter((p) =>
          p.kind === "rule" || p.kind === "constraint" || p.kind === "decision",
        );

        const conflicts: Array<{ primitiveIds: string[]; reason: string }> = [];

        for (let i = 0; i < candidates.length; i++) {
          for (let j = i + 1; j < candidates.length; j++) {
            const a = candidates[i]!;
            const b = candidates[j]!;
            if (areContradictory(a.content, b.content)) {
              conflicts.push({
                primitiveIds: [a.id, b.id],
                reason: `Contradiction between '${a.kind}' (${a.id}) and '${b.kind}' (${b.id})`,
              });
            }
          }
        }

        if (conflicts.length === 0) {
          return RuleResult.noop("no contradictions found in batch");
        }

        return RuleResult.emit(
          conflicts.map((c) => fact(ANALYSIS_FACTS.CONFLICT_DETECTED, c)),
        );
      },
    },

    // ------------------------------------------------------------------
    // 3. Objective alignment
    // ------------------------------------------------------------------
    {
      id: "analysis.objective-alignment",
      description: "Emit aligned or misaligned fact based on objectiveAlignmentScore",
      contract: objectiveAlignmentContract,
      impl(state) {
        const { primitives, objectiveAlignmentScore, analysisSessionId } = state.context;
        if (primitives.length === 0) {
          return RuleResult.skip("empty batch");
        }

        const hasObjectives = primitives.some((p) => p.kind === "objective");
        if (!hasObjectives) {
          return RuleResult.skip("no objective primitives in batch");
        }

        const tag =
          objectiveAlignmentScore >= OBJECTIVE_ALIGNMENT_THRESHOLD
            ? ANALYSIS_FACTS.OBJECTIVE_ALIGNED
            : ANALYSIS_FACTS.OBJECTIVE_MISALIGNED;

        return RuleResult.emit([
          fact(tag, {
            score: objectiveAlignmentScore,
            threshold: OBJECTIVE_ALIGNMENT_THRESHOLD,
            sessionId: analysisSessionId,
          }),
        ]);
      },
    },

    // ------------------------------------------------------------------
    // 4. Risk propagation
    // ------------------------------------------------------------------
    {
      id: "analysis.risk-propagation",
      description: "Propagate risk primitives to linked objectives/decisions",
      contract: riskPropagationContract,
      impl(state) {
        const { primitives, hasLinkedRisk, analysisSessionId } = state.context;
        if (primitives.length === 0) {
          return RuleResult.skip("empty batch");
        }

        const riskPrimitives = primitives.filter((p) => p.kind === "risk");
        if (riskPrimitives.length === 0) {
          return RuleResult.skip("no risk primitives in batch");
        }

        if (!hasLinkedRisk) {
          return RuleResult.noop("hasLinkedRisk is false — no propagation needed");
        }

        const targetIds = primitives
          .filter((p) => p.kind === "objective" || p.kind === "decision")
          .map((p) => p.id);

        return RuleResult.emit([
          fact(ANALYSIS_FACTS.RISK_PROPAGATED, {
            riskIds: riskPrimitives.map((r) => r.id),
            targetIds,
            sessionId: analysisSessionId,
          }),
        ]);
      },
    },

    // ------------------------------------------------------------------
    // 5. Missing evidence
    // ------------------------------------------------------------------
    {
      id: "analysis.missing-evidence",
      description: "Flag low-confidence hypothesis/decision primitives lacking evidence",
      contract: missingEvidenceContract,
      impl(state) {
        const { primitives, evidenceThreshold } = state.context;
        if (primitives.length === 0) {
          return RuleResult.skip("empty batch");
        }

        const needsEvidence = primitives.filter(
          (p) =>
            (p.kind === "hypothesis" || p.kind === "decision") &&
            p.confidence < evidenceThreshold,
        );

        if (needsEvidence.length === 0) {
          return RuleResult.skip("no hypothesis or decision primitives");
        }

        const unsupported = needsEvidence.filter(
          (p) => !hasEvidence(p, primitives),
        );

        if (unsupported.length === 0) {
          return RuleResult.noop("all low-confidence primitives have supporting evidence");
        }

        return RuleResult.emit([
          fact(ANALYSIS_FACTS.EVIDENCE_MISSING, {
            primitiveIds: unsupported.map((p) => p.id),
            evidenceThreshold,
          }),
        ]);
      },
    },

    // ------------------------------------------------------------------
    // 6. Next-action recommendation
    // ------------------------------------------------------------------
    {
      id: "analysis.next-action",
      description:
        "Recommend next actions from action-item primitives or unresolved risk primitives",
      contract: nextActionContract,
      impl(state) {
        const { primitives, analysisSessionId } = state.context;
        if (primitives.length === 0) {
          return RuleResult.skip("empty batch");
        }

        const actions: Array<{ action: string; sourceId: string; kind: string }> = [];

        // Explicit action-item primitives are always recommended
        for (const p of primitives.filter((p) => p.kind === "action-item")) {
          actions.push({ action: p.content, sourceId: p.sourceId, kind: "action-item" });
        }

        // Risk primitives without a paired decision become recommendations
        const decisionContents = primitives
          .filter((p) => p.kind === "decision")
          .map((p) => p.content.toLowerCase());

        for (const risk of primitives.filter((p) => p.kind === "risk")) {
          const mitigated = decisionContents.some((d) =>
            risk.tags.some((t) => d.includes(t.toLowerCase())) ||
            risk.content
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.length > 4 && d.includes(w)),
          );
          if (!mitigated) {
            actions.push({
              action: `Mitigate risk: ${risk.content}`,
              sourceId: risk.sourceId,
              kind: "risk-mitigation",
            });
          }
        }

        if (actions.length === 0) {
          return RuleResult.noop("no action-items or unresolved risks found");
        }

        return RuleResult.emit([
          fact(ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED, {
            actions,
            sessionId: analysisSessionId,
          }),
        ]);
      },
    },
  ],

  constraints: [
    {
      id: "analysis.session-id-required",
      description: "analysisSessionId must be a non-empty string",
      contract: defineContract({
        ruleId: "analysis.session-id-required",
        behavior: "Enforce that every analysis run has a non-empty session identifier",
        examples: [
          {
            given: "analysisSessionId is empty string",
            when: "constraint is checked",
            then: "returns error",
          },
          {
            given: "analysisSessionId is 'turn:abc123'",
            when: "constraint is checked",
            then: "returns true",
          },
        ],
        invariants: ["analysisSessionId must be typeof string and non-empty"],
      }),
      impl(state) {
        const { analysisSessionId } = state.context;
        if (
          typeof analysisSessionId !== "string" ||
          analysisSessionId.trim().length === 0
        ) {
          return "analysisSessionId must be a non-empty string";
        }
        return true;
      },
    },
    {
      id: "analysis.evidence-threshold-range",
      description: "evidenceThreshold must be a number in (0, 1]",
      contract: defineContract({
        ruleId: "analysis.evidence-threshold-range",
        behavior: "Enforce that evidenceThreshold is a valid probability in (0, 1]",
        examples: [
          {
            given: "evidenceThreshold is 0",
            when: "constraint is checked",
            then: "returns error",
          },
          {
            given: "evidenceThreshold is 1.5",
            when: "constraint is checked",
            then: "returns error",
          },
          {
            given: "evidenceThreshold is 0.5",
            when: "constraint is checked",
            then: "returns true",
          },
        ],
        invariants: ["evidenceThreshold must be > 0 and <= 1"],
      }),
      impl(state) {
        const { evidenceThreshold } = state.context;
        if (
          typeof evidenceThreshold !== "number" ||
          evidenceThreshold <= 0 ||
          evidenceThreshold > 1
        ) {
          return `evidenceThreshold must be in (0, 1], got ${evidenceThreshold}`;
        }
        return true;
      },
    },
  ],

  meta: {
    module: "analysis-coprocessor",
    version: "1.0.0",
  },
});
