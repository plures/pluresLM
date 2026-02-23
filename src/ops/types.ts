/**
 * Operational memory type definitions.
 *
 * These types describe the shape of memories stored by the ops modules.
 * Memories are stored as regular MemoryEntry records with category metadata
 * in opts; these types document the semantic structure within each category.
 */

/** A CI failure/fix pair stored under category "error-pattern". */
export interface ErrorFixMemory {
  error: string;
  fix: string;
  repository?: string;
  ciSystem?: string;
  tags?: string[];
}

/** Repository-specific context stored under category "repo-context". */
export interface RepoContextMemory {
  repository: string;
  content: string;
  buildSystem?: string;
  tags?: string[];
}

/** A human override / preference stored under category "preference". */
export interface PreferenceMemory {
  context: string;
  preference: string;
  overrideType?: "delegation" | "code-style" | "priority" | "other";
  tags?: string[];
}

/**
 * A recurring temporal pattern observed across sessions,
 * stored under category "temporal-pattern".
 */
export interface TemporalPatternMemory {
  pattern: string;
  frequency?: string;
  tags?: string[];
}

/** The agent or party a task should be routed to. */
export type DelegationTarget = "copilot" | "human" | "self";

/** Result returned by DelegationHelper.decide(). */
export interface DelegationDecision {
  target: DelegationTarget;
  reason: string;
  confidence: number;
}
