/**
 * Praxis Factory Rules for PluresLM
 *
 * Each factory function returns a fully-typed `PraxisModule` that can be
 * composed into a larger engine or used standalone.
 *
 * Three factories are provided:
 *
 * - `inputRules(config?)`  — memory creation payload validation, search query
 *                            validation.
 * - `dataRules(config?)`   — relevance scoring thresholds, staleness detection,
 *                            dedup scoring.
 * - `stateRules(config?)`  — memory lifecycle transitions
 *                            (active → stale → demoted → archived) and
 *                            independent hot-tier promotion rules.
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
  type PraxisModule,
} from "@plures/praxis";
import type { MemoryPriority, MemoryTier } from "../types.js";

// ============================================================================
// inputRules
// ============================================================================

/** Configuration for inputRules factory. */
export interface InputRulesConfig {
  /** Minimum content length in characters (default: 50). */
  minContentLength?: number;
  /** Maximum content length in characters (default: 100_000). */
  maxContentLength?: number;
  /** Maximum number of tags per memory (default: 20). */
  maxTags?: number;
  /** Minimum search query length in characters (default: 3). */
  minSearchQueryLength?: number;
}

/** Context type for inputRules modules. */
export interface InputContext {
  /** Incoming content to validate. */
  content: string;
  /** Tags to attach. */
  tags: string[];
  /** Category to store under. */
  category: string;
  /** Whether this evaluation is for a search query (vs. a store operation). */
  isSearchQuery: boolean;
}

export const INPUT_FACTS = {
  VALID: "input.valid",
  INVALID_CONTENT_TOO_SHORT: "input.invalid.content-too-short",
  INVALID_CONTENT_TOO_LONG: "input.invalid.content-too-long",
  INVALID_TOO_MANY_TAGS: "input.invalid.too-many-tags",
  INVALID_SEARCH_QUERY_TOO_SHORT: "input.invalid.search-query-too-short",
} as const;

/**
 * Factory: returns a PraxisModule for validating memory creation and search
 * query payloads.
 *
 * Rules:
 * - `input.content-length`       — reject content outside [min, max] chars
 * - `input.tags-count`           — reject when tag count exceeds maxTags
 * - `input.search-query-length`  — reject search queries below minimum length
 * - `input.valid`                — emit input.valid when all checks pass
 */
export function inputRules(config: InputRulesConfig = {}): PraxisModule<InputContext> {
  const minLen = config.minContentLength ?? 50;
  const maxLen = config.maxContentLength ?? 100_000;
  const maxTagCount = config.maxTags ?? 20;
  const minQueryLen = config.minSearchQueryLength ?? 3;

  return defineModule<InputContext>({
    rules: [
      {
        id: "input.content-length",
        description: `Validate content length is between ${minLen} and ${maxLen} characters`,
        contract: defineContract({
          ruleId: "input.content-length",
          behavior: "Reject content that is too short or too long",
          examples: [
            {
              given: `content is shorter than ${minLen} chars`,
              when: "input.content-length evaluates",
              then: "emits input.invalid.content-too-short",
            },
            {
              given: `content is longer than ${maxLen} chars`,
              when: "input.content-length evaluates",
              then: "emits input.invalid.content-too-long",
            },
          ],
          invariants: [`content.length must be in [${minLen}, ${maxLen}]`],
        }),
        impl(state) {
          const { content, isSearchQuery } = state.context;
          // Search queries use a different minimum — handled by search-query-length rule
          if (isSearchQuery) return RuleResult.noop("search query — handled by search-query-length rule");
          if (content.length < minLen) {
            return RuleResult.emit([
              fact(INPUT_FACTS.INVALID_CONTENT_TOO_SHORT, {
                contentLength: content.length,
                minContentLength: minLen,
              }),
            ]);
          }
          if (content.length > maxLen) {
            return RuleResult.emit([
              fact(INPUT_FACTS.INVALID_CONTENT_TOO_LONG, {
                contentLength: content.length,
                maxContentLength: maxLen,
              }),
            ]);
          }
          return RuleResult.noop("content length valid");
        },
      },
      {
        id: "input.tags-count",
        description: `Reject when tag count exceeds ${maxTagCount}`,
        contract: defineContract({
          ruleId: "input.tags-count",
          behavior: "Reject payloads with too many tags",
          examples: [
            {
              given: `tags array has ${maxTagCount + 1} items`,
              when: "input.tags-count evaluates",
              then: "emits input.invalid.too-many-tags",
            },
          ],
          invariants: [`tags.length must be <= ${maxTagCount}`],
        }),
        impl(state) {
          const { tags } = state.context;
          if (tags.length > maxTagCount) {
            return RuleResult.emit([
              fact(INPUT_FACTS.INVALID_TOO_MANY_TAGS, {
                tagCount: tags.length,
                maxTags: maxTagCount,
              }),
            ]);
          }
          return RuleResult.noop("tag count valid");
        },
      },
      {
        id: "input.search-query-length",
        description: `Reject search queries shorter than ${minQueryLen} chars`,
        contract: defineContract({
          ruleId: "input.search-query-length",
          behavior: "Reject search queries that are too short to be useful",
          examples: [
            {
              given: `isSearchQuery is true and query is ${minQueryLen - 1} chars`,
              when: "input.search-query-length evaluates",
              then: "emits input.invalid.search-query-too-short",
            },
          ],
          invariants: ["search query length must be >= minSearchQueryLength"],
        }),
        impl(state) {
          const { content, isSearchQuery } = state.context;
          if (!isSearchQuery) return RuleResult.skip("not a search query");
          if (content.trim().length < minQueryLen) {
            return RuleResult.emit([
              fact(INPUT_FACTS.INVALID_SEARCH_QUERY_TOO_SHORT, {
                queryLength: content.trim().length,
                minQueryLength: minQueryLen,
              }),
            ]);
          }
          return RuleResult.noop("search query length valid");
        },
      },
      {
        id: "input.valid",
        description: "Emit input.valid when all validation checks pass",
        contract: defineContract({
          ruleId: "input.valid",
          behavior: "Confirm that the input payload is well-formed",
          examples: [
            {
              given: "content passes length check and tag count is within limit",
              when: "input.valid evaluates",
              then: "emits input.valid fact",
            },
          ],
          invariants: [
            "input.valid is only emitted when no other invalid fact is produced",
          ],
        }),
        impl(state) {
          const { content, tags, isSearchQuery } = state.context;
          // Re-evaluate inline for a self-contained admit check
          if (!isSearchQuery && (content.length < minLen || content.length > maxLen)) {
            return RuleResult.skip("content length invalid");
          }
          if (isSearchQuery && content.trim().length < minQueryLen) {
            return RuleResult.skip("search query too short");
          }
          if (tags.length > maxTagCount) {
            return RuleResult.skip("too many tags");
          }
          return RuleResult.emit([fact(INPUT_FACTS.VALID, { category: state.context.category })]);
        },
      },
    ],
    constraints: [
      {
        id: "input.content-is-string",
        description: "content must be a string",
        contract: defineContract({
          ruleId: "input.content-is-string",
          behavior: "Enforce that content is always typeof string",
          examples: [
            { given: "content is a number", when: "constraint is checked", then: "returns error" },
            { given: "content is a string", when: "constraint is checked", then: "returns true" },
          ],
          invariants: ["content must be typeof string"],
        }),
        impl(state) {
          if (typeof state.context.content !== "string") {
            return "content must be a string";
          }
          return true;
        },
      },
      {
        id: "input.tags-is-array",
        description: "tags must be an array",
        contract: defineContract({
          ruleId: "input.tags-is-array",
          behavior: "Enforce that tags is always an array",
          examples: [
            { given: "tags is a string", when: "constraint is checked", then: "returns error" },
            { given: "tags is an array", when: "constraint is checked", then: "returns true" },
          ],
          invariants: ["tags must be an Array"],
        }),
        impl(state) {
          if (!Array.isArray(state.context.tags)) {
            return "tags must be an array";
          }
          return true;
        },
      },
    ],
    meta: { factory: "inputRules", version: "1.0.0" },
  });
}

// ============================================================================
// dataRules
// ============================================================================

/** Configuration for dataRules factory. */
export interface DataRulesConfig {
  /** Minimum relevance score for a search result to be surfaced (default: 0.5). */
  relevanceThreshold?: number;
  /** Days after last access before a memory is considered stale (default: 30). */
  stalenessDays?: number;
  /** Cosine similarity threshold for dedup scoring (default: 0.95). */
  dedupeThreshold?: number;
}

/** Context type for dataRules modules. */
export interface DataContext {
  /** Relevance score of a search result [0, 1]. */
  relevanceScore: number;
  /** Days since the memory was last accessed. */
  daysSinceAccess: number;
  /** Cosine similarity to the nearest vector neighbour [0, 1]. */
  vectorNeighbourScore: number;
  /** Priority of the memory. */
  priority: MemoryPriority;
}

export const DATA_FACTS = {
  RELEVANT: "data.relevant",
  BELOW_THRESHOLD: "data.below-relevance-threshold",
  STALE: "data.stale",
  DEDUP_CANDIDATE: "data.dedup-candidate",
} as const;

/**
 * Factory: returns a PraxisModule for relevance scoring thresholds, staleness
 * detection, and dedup scoring.
 *
 * Rules:
 * - `data.relevance-threshold` — flag results below minimum relevance score
 * - `data.staleness-score`     — flag memories past stalenessDays
 * - `data.dedup-score`         — flag near-duplicates via vector similarity
 */
export function dataRules(config: DataRulesConfig = {}): PraxisModule<DataContext> {
  const relevanceThreshold = config.relevanceThreshold ?? 0.5;
  const stalenessDays = config.stalenessDays ?? 30;
  const dedupeThreshold = config.dedupeThreshold ?? 0.95;

  return defineModule<DataContext>({
    rules: [
      {
        id: "data.relevance-threshold",
        description: `Surface only results with score >= ${relevanceThreshold}`,
        contract: defineContract({
          ruleId: "data.relevance-threshold",
          behavior: "Filter search results below the relevance threshold",
          examples: [
            {
              given: `relevanceScore is 0.3, threshold is ${relevanceThreshold}`,
              when: "data.relevance-threshold evaluates",
              then: "emits data.below-relevance-threshold",
            },
            {
              given: `relevanceScore is 0.8, threshold is ${relevanceThreshold}`,
              when: "data.relevance-threshold evaluates",
              then: "emits data.relevant",
            },
          ],
          invariants: [`data.relevant is only emitted when relevanceScore >= ${relevanceThreshold}`],
        }),
        impl(state) {
          const { relevanceScore } = state.context;
          if (relevanceScore < relevanceThreshold) {
            return RuleResult.emit([
              fact(DATA_FACTS.BELOW_THRESHOLD, { relevanceScore, relevanceThreshold }),
            ]);
          }
          return RuleResult.emit([fact(DATA_FACTS.RELEVANT, { relevanceScore })]);
        },
      },
      {
        id: "data.staleness-score",
        description: `Flag memories not accessed in ${stalenessDays} days`,
        contract: defineContract({
          ruleId: "data.staleness-score",
          behavior: "Detect memories past the staleness threshold",
          examples: [
            {
              given: `daysSinceAccess is 45, stalenessDays is ${stalenessDays}`,
              when: "data.staleness-score evaluates",
              then: "emits data.stale",
            },
          ],
          invariants: [
            "critical priority memories are exempt",
            `data.stale is emitted when daysSinceAccess > ${stalenessDays}`,
          ],
        }),
        impl(state) {
          const { daysSinceAccess, priority } = state.context;
          if (priority === "critical") {
            return RuleResult.noop("critical memories are staleness-exempt");
          }
          if (daysSinceAccess > stalenessDays) {
            return RuleResult.emit([
              fact(DATA_FACTS.STALE, { daysSinceAccess, stalenessDays }),
            ]);
          }
          return RuleResult.noop("memory is not stale");
        },
      },
      {
        id: "data.dedup-score",
        description: `Flag near-duplicates when vectorNeighbourScore >= ${dedupeThreshold}`,
        contract: defineContract({
          ruleId: "data.dedup-score",
          behavior: "Detect near-duplicate memories via vector similarity",
          examples: [
            {
              given: `vectorNeighbourScore is 0.97, threshold is ${dedupeThreshold}`,
              when: "data.dedup-score evaluates",
              then: "emits data.dedup-candidate",
            },
          ],
          invariants: [`data.dedup-candidate is emitted when vectorNeighbourScore >= ${dedupeThreshold}`],
        }),
        impl(state) {
          const { vectorNeighbourScore } = state.context;
          if (vectorNeighbourScore >= dedupeThreshold) {
            return RuleResult.emit([
              fact(DATA_FACTS.DEDUP_CANDIDATE, { vectorNeighbourScore, dedupeThreshold }),
            ]);
          }
          return RuleResult.noop("no near-duplicate");
        },
      },
    ],
    constraints: [
      {
        id: "data.relevance-score-range",
        description: "relevanceScore must be in [0, 1]",
        contract: defineContract({
          ruleId: "data.relevance-score-range",
          behavior: "Enforce that relevanceScore is a valid cosine similarity value in [0, 1]",
          examples: [
            { given: "relevanceScore is -0.1", when: "constraint is checked", then: "returns error" },
            { given: "relevanceScore is 0.75", when: "constraint is checked", then: "returns true" },
          ],
          invariants: ["relevanceScore must be in [0, 1]"],
        }),
        impl(state) {
          const { relevanceScore } = state.context;
          if (relevanceScore < 0 || relevanceScore > 1) {
            return `relevanceScore must be between 0 and 1, got ${relevanceScore}`;
          }
          return true;
        },
      },
    ],
    meta: { factory: "dataRules", version: "1.0.0" },
  });
}

// ============================================================================
// stateRules
// ============================================================================

/** Configuration for stateRules factory. */
export interface StateRulesConfig {
  /** Days after last access before moving to stale (default: 30). */
  staleDays?: number;
  /** Days after stale before demotion to cold tier (default: 90). */
  demoteDays?: number;
  /** Days after demoted before archiving (default: 180). */
  archiveDays?: number;
  /** Reinforcement count required for hot promotion (default: 3). */
  promotionThreshold?: number;
}

/** Memory lifecycle states. */
export type MemoryLifecycleState = "active" | "stale" | "demoted" | "archived";

/** Context type for stateRules modules. */
export interface StateContext {
  memoryId: string;
  currentState: MemoryLifecycleState;
  currentTier: MemoryTier;
  priority: MemoryPriority;
  daysSinceAccess: number;
  reinforcement_count: number;
}

export const STATE_FACTS = {
  TRANSITION_TO_STALE: "state.transition.active-to-stale",
  TRANSITION_TO_DEMOTED: "state.transition.stale-to-demoted",
  TRANSITION_TO_ARCHIVED: "state.transition.demoted-to-archived",
  TRANSITION_TO_HOT: "state.transition.promoted-to-hot",
} as const;

/**
 * Factory: returns a PraxisModule for memory lifecycle state transitions.
 *
 * Lifecycle:  active → stale → demoted → archived
 * Promotion:  (any) → hot tier when reinforcement_count >= promotionThreshold
 *
 * Rules:
 * - `state.to-stale`    — active → stale when daysSinceAccess > staleDays
 * - `state.to-demoted`  — stale → demoted when daysSinceAccess > demoteDays
 * - `state.to-archived` — demoted → archived when daysSinceAccess > archiveDays
 * - `state.to-hot`      — promote reinforced memories to hot tier
 */
export function stateRules(config: StateRulesConfig = {}): PraxisModule<StateContext> {
  const staleDays = config.staleDays ?? 30;
  const demoteDays = config.demoteDays ?? 90;
  const archiveDays = config.archiveDays ?? 180;
  const promotionThreshold = config.promotionThreshold ?? 3;

  return defineModule<StateContext>({
    rules: [
      {
        id: "state.to-stale",
        description: `Transition active memories to stale after ${staleDays} days`,
        contract: defineContract({
          ruleId: "state.to-stale",
          behavior: "Move an active memory to stale state when it exceeds staleDays",
          examples: [
            {
              given: `currentState is 'active', daysSinceAccess is ${staleDays + 1}`,
              when: "state.to-stale evaluates",
              then: "emits state.transition.active-to-stale",
            },
          ],
          invariants: [
            "only active memories can transition to stale",
            "critical memories are exempt",
          ],
        }),
        impl(state) {
          const { currentState, daysSinceAccess, priority, memoryId } = state.context;
          if (currentState !== "active") return RuleResult.skip("not active");
          if (priority === "critical") return RuleResult.noop("critical memory exempt");
          if (daysSinceAccess > staleDays) {
            return RuleResult.emit([
              fact(STATE_FACTS.TRANSITION_TO_STALE, { memoryId, daysSinceAccess, staleDays }),
            ]);
          }
          return RuleResult.noop("memory not yet stale");
        },
      },
      {
        id: "state.to-demoted",
        description: `Transition stale memories to demoted after ${demoteDays} days`,
        contract: defineContract({
          ruleId: "state.to-demoted",
          behavior: "Move a stale memory to demoted state when it exceeds demoteDays",
          examples: [
            {
              given: `currentState is 'stale', daysSinceAccess is ${demoteDays + 1}`,
              when: "state.to-demoted evaluates",
              then: "emits state.transition.stale-to-demoted",
            },
          ],
          invariants: [
            "only stale memories can transition to demoted",
            "critical memories are exempt",
          ],
        }),
        impl(state) {
          const { currentState, daysSinceAccess, priority, memoryId } = state.context;
          if (currentState !== "stale") return RuleResult.skip("not stale");
          if (priority === "critical") return RuleResult.noop("critical memory exempt");
          if (daysSinceAccess > demoteDays) {
            return RuleResult.emit([
              fact(STATE_FACTS.TRANSITION_TO_DEMOTED, { memoryId, daysSinceAccess, demoteDays }),
            ]);
          }
          return RuleResult.noop("stale memory not yet ready for demotion");
        },
      },
      {
        id: "state.to-archived",
        description: `Transition demoted memories to archived after ${archiveDays} days`,
        contract: defineContract({
          ruleId: "state.to-archived",
          behavior: "Move a demoted memory to archived state when it exceeds archiveDays",
          examples: [
            {
              given: `currentState is 'demoted', daysSinceAccess is ${archiveDays + 1}`,
              when: "state.to-archived evaluates",
              then: "emits state.transition.demoted-to-archived",
            },
          ],
          invariants: [
            "only demoted memories can be archived",
            "critical memories are exempt",
          ],
        }),
        impl(state) {
          const { currentState, daysSinceAccess, priority, memoryId } = state.context;
          if (currentState !== "demoted") return RuleResult.skip("not demoted");
          if (priority === "critical") return RuleResult.noop("critical memory exempt");
          if (daysSinceAccess > archiveDays) {
            return RuleResult.emit([
              fact(STATE_FACTS.TRANSITION_TO_ARCHIVED, { memoryId, daysSinceAccess, archiveDays }),
            ]);
          }
          return RuleResult.noop("demoted memory not yet ready for archiving");
        },
      },
      {
        id: "state.to-hot",
        description: `Promote memories to hot tier when reinforcement_count >= ${promotionThreshold}`,
        contract: defineContract({
          ruleId: "state.to-hot",
          behavior: "Promote a reinforced memory to hot tier",
          examples: [
            {
              given: `reinforcement_count is ${promotionThreshold}, currentTier is 'warm'`,
              when: "state.to-hot evaluates",
              then: "emits state.transition.promoted-to-hot",
            },
          ],
          invariants: [
            "hot tier memories are not re-promoted",
            `reinforcement_count >= ${promotionThreshold} is required`,
          ],
        }),
        impl(state) {
          const { currentTier, reinforcement_count, memoryId } = state.context;
          if (currentTier === "hot") return RuleResult.noop("already hot");
          if (reinforcement_count >= promotionThreshold) {
            return RuleResult.emit([
              fact(STATE_FACTS.TRANSITION_TO_HOT, {
                memoryId,
                reinforcement_count,
                previousTier: currentTier,
              }),
            ]);
          }
          return RuleResult.noop("reinforcement count below threshold");
        },
      },
    ],
    constraints: [
      {
        id: "state.days-non-negative",
        description: "daysSinceAccess must be >= 0",
        contract: defineContract({
          ruleId: "state.days-non-negative",
          behavior: "Enforce that daysSinceAccess is non-negative",
          examples: [
            { given: "daysSinceAccess is -1", when: "constraint is checked", then: "returns error" },
            { given: "daysSinceAccess is 0", when: "constraint is checked", then: "returns true" },
          ],
          invariants: ["daysSinceAccess must be >= 0"],
        }),
        impl(state) {
          if (state.context.daysSinceAccess < 0) {
            return `daysSinceAccess must be >= 0, got ${state.context.daysSinceAccess}`;
          }
          return true;
        },
      },
    ],
    meta: { factory: "stateRules", version: "1.0.0" },
  });
}
