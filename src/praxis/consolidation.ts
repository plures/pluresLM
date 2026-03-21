/**
 * Consolidation — Praxis Module
 *
 * Declarative logic for when to merge duplicates, demote stale memories,
 * and promote reinforced memories in PluresLM.
 *
 * Exported:
 * - `ConsolidationContext` — typed context for this module
 * - `consolidationModule`  — ready-to-register PraxisModule
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
} from "@plures/praxis";
import type { MemoryPriority, MemoryTier } from "../types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ConsolidationMemory {
  id: string;
  category: string;
  priority: MemoryPriority;
  /** Days since the memory was last accessed. */
  daysSinceAccess: number;
  /** How many times this memory has been reinforced (confirmed/selected). */
  reinforcement_count: number;
  /** Current tier of the memory. */
  tier: MemoryTier;
  /** Cosine similarity to its nearest vector neighbour. */
  vectorNeighbourScore: number;
}

export interface ConsolidationContext {
  /** The memory being evaluated. */
  memory: ConsolidationMemory;
  /** Number of days after which a memory is considered stale (default: 30). */
  stalenessDays: number;
  /** Cosine similarity threshold for near-duplicate detection (default: 0.95). */
  dedupeThreshold: number;
  /** Reinforcement count threshold for promotion to hot tier (default: 3). */
  promotionThreshold: number;
  /** Whether the consolidation run is in dry-run mode. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

export function defaultConsolidationContext(
  overrides: Partial<ConsolidationContext> = {},
): ConsolidationContext {
  return {
    memory: {
      id: "",
      category: "conversation",
      priority: "normal",
      daysSinceAccess: 0,
      reinforcement_count: 0,
      tier: "hot",
      vectorNeighbourScore: 0,
    },
    stalenessDays: 30,
    dedupeThreshold: 0.95,
    promotionThreshold: 3,
    dryRun: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fact tags
// ---------------------------------------------------------------------------

export const CONSOLIDATION_FACTS = {
  STALE: "memory.stale",
  DEMOTE_CANDIDATE: "memory.demote.candidate",
  PROMOTE_CANDIDATE: "memory.promote.candidate",
  MERGE_CANDIDATE: "memory.merge.candidate",
} as const;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const staleDetectionContract = defineContract({
  ruleId: "consolidation.stale-detection",
  behavior: "Flag a memory as stale when daysSinceAccess exceeds stalenessDays",
  examples: [
    {
      given: "daysSinceAccess is 45, stalenessDays is 30",
      when: "consolidation.stale-detection evaluates",
      then: "emits memory.stale fact",
    },
    {
      given: "daysSinceAccess is 10, stalenessDays is 30",
      when: "consolidation.stale-detection evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "daysSinceAccess > stalenessDays always produces a memory.stale fact",
    "critical priority memories are exempt from staleness marking",
  ],
});

const dedupCandidateContract = defineContract({
  ruleId: "consolidation.dedup-candidate",
  behavior:
    "Flag a memory for merge when its vectorNeighbourScore >= dedupeThreshold",
  examples: [
    {
      given: "vectorNeighbourScore is 0.97, dedupeThreshold is 0.95",
      when: "consolidation.dedup-candidate evaluates",
      then: "emits memory.merge.candidate fact",
    },
    {
      given: "vectorNeighbourScore is 0.80, dedupeThreshold is 0.95",
      when: "consolidation.dedup-candidate evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "memory.merge.candidate is only emitted when vectorNeighbourScore >= dedupeThreshold",
  ],
});

const promotionContract = defineContract({
  ruleId: "consolidation.promote-reinforced",
  behavior:
    "Nominate a memory for hot-tier promotion when reinforcement_count >= promotionThreshold",
  examples: [
    {
      given: "reinforcement_count is 5, promotionThreshold is 3, tier is 'warm'",
      when: "consolidation.promote-reinforced evaluates",
      then: "emits memory.promote.candidate fact",
    },
    {
      given: "reinforcement_count is 1",
      when: "consolidation.promote-reinforced evaluates",
      then: "returns noop",
    },
    {
      given: "tier is already 'hot'",
      when: "consolidation.promote-reinforced evaluates",
      then: "returns noop (already at top tier)",
    },
  ],
  invariants: [
    "promotion only targets memories not already in the hot tier",
    "reinforcement_count >= promotionThreshold is required for promotion",
  ],
});

const demotionContract = defineContract({
  ruleId: "consolidation.demote-stale",
  behavior:
    "Nominate a stale, non-critical memory for tier demotion from hot to warm or warm to cold",
  examples: [
    {
      given: "memory is stale, priority is 'normal', tier is 'hot'",
      when: "consolidation.demote-stale evaluates",
      then: "emits memory.demote.candidate fact with targetTier 'warm'",
    },
    {
      given: "memory is stale, priority is 'critical'",
      when: "consolidation.demote-stale evaluates",
      then: "returns skip (critical memories are never demoted)",
    },
  ],
  invariants: [
    "critical priority memories are never demoted",
    "cold tier memories cannot be demoted further",
  ],
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Praxis module for memory consolidation logic.
 *
 * Rules:
 * 1. `consolidation.stale-detection`    — mark memories past stalenessDays
 * 2. `consolidation.dedup-candidate`    — flag near-duplicates for merge
 * 3. `consolidation.promote-reinforced` — nominate reinforced memories for hot tier
 * 4. `consolidation.demote-stale`       — nominate stale memories for demotion
 *
 * Constraints:
 * - `consolidation.staleness-positive`  — stalenessDays must be > 0
 * - `consolidation.threshold-range`     — dedupeThreshold must be in [0, 1]
 */
export const consolidationModule = defineModule<ConsolidationContext>({
  rules: [
    {
      id: "consolidation.stale-detection",
      description: "Flag memory as stale when daysSinceAccess exceeds stalenessDays",
      contract: staleDetectionContract,
      impl(state) {
        const { memory, stalenessDays } = state.context;
        // Critical memories are always exempt from staleness
        if (memory.priority === "critical") {
          return RuleResult.noop("critical memory exempt from staleness");
        }
        if (memory.daysSinceAccess > stalenessDays) {
          return RuleResult.emit([
            fact(CONSOLIDATION_FACTS.STALE, {
              memoryId: memory.id,
              daysSinceAccess: memory.daysSinceAccess,
              stalenessDays,
              category: memory.category,
              priority: memory.priority,
            }),
          ]);
        }
        return RuleResult.noop("memory is not stale");
      },
    },
    {
      id: "consolidation.dedup-candidate",
      description: "Flag near-duplicate memories for merge when vector score >= threshold",
      contract: dedupCandidateContract,
      impl(state) {
        const { memory, dedupeThreshold } = state.context;
        if (memory.vectorNeighbourScore >= dedupeThreshold) {
          return RuleResult.emit([
            fact(CONSOLIDATION_FACTS.MERGE_CANDIDATE, {
              memoryId: memory.id,
              score: memory.vectorNeighbourScore,
              threshold: dedupeThreshold,
            }),
          ]);
        }
        return RuleResult.noop("no near-duplicate");
      },
    },
    {
      id: "consolidation.promote-reinforced",
      description: "Nominate reinforced memories for hot-tier promotion",
      contract: promotionContract,
      impl(state) {
        const { memory, promotionThreshold } = state.context;
        if (memory.tier === "hot") {
          return RuleResult.noop("already in hot tier");
        }
        if (memory.reinforcement_count >= promotionThreshold) {
          return RuleResult.emit([
            fact(CONSOLIDATION_FACTS.PROMOTE_CANDIDATE, {
              memoryId: memory.id,
              reinforcement_count: memory.reinforcement_count,
              currentTier: memory.tier,
              targetTier: "hot" as MemoryTier,
            }),
          ]);
        }
        return RuleResult.noop("reinforcement count below threshold");
      },
    },
    {
      id: "consolidation.demote-stale",
      description: "Nominate stale non-critical memories for tier demotion",
      contract: demotionContract,
      impl(state) {
        const { memory, stalenessDays } = state.context;
        // Critical memories are never demoted
        if (memory.priority === "critical") {
          return RuleResult.skip("critical memories are never demoted");
        }
        // Cold is the floor
        if (memory.tier === "cold") {
          return RuleResult.skip("memory is already at cold tier");
        }
        if (memory.daysSinceAccess > stalenessDays) {
          const targetTier: MemoryTier = memory.tier === "hot" ? "warm" : "cold";
          return RuleResult.emit([
            fact(CONSOLIDATION_FACTS.DEMOTE_CANDIDATE, {
              memoryId: memory.id,
              currentTier: memory.tier,
              targetTier,
              daysSinceAccess: memory.daysSinceAccess,
            }),
          ]);
        }
        return RuleResult.noop("memory not stale enough for demotion");
      },
    },
  ],
  constraints: [
    {
      id: "consolidation.staleness-positive",
      description: "stalenessDays must be a positive number",
      contract: defineContract({
        ruleId: "consolidation.staleness-positive",
        behavior: "Enforce that stalenessDays is a positive number",
        examples: [
          { given: "stalenessDays is 0", when: "constraint is checked", then: "returns error" },
          { given: "stalenessDays is 30", when: "constraint is checked", then: "returns true" },
        ],
        invariants: ["stalenessDays must be > 0"],
      }),
      impl(state) {
        if (state.context.stalenessDays <= 0) {
          return `stalenessDays must be positive, got ${state.context.stalenessDays}`;
        }
        return true;
      },
    },
    {
      id: "consolidation.threshold-range",
      description: "dedupeThreshold must be in [0, 1]",
      contract: defineContract({
        ruleId: "consolidation.threshold-range",
        behavior: "Enforce that dedupeThreshold is in range [0, 1]",
        examples: [
          { given: "dedupeThreshold is 1.5", when: "constraint is checked", then: "returns error" },
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
    module: "consolidation",
    version: "1.0.0",
  },
});
