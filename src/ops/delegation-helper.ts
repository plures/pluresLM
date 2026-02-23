/**
 * Delegation Helper
 *
 * Routes tasks based on context + memory. Uses error patterns, repo
 * knowledge, and preferences to decide whether a task should be handled
 * by Copilot, the human, or the agent itself.
 *
 * Decision logic (heuristic, in priority order):
 *  1. If a matching delegation preference exists with a valid `target:` tag
 *     ("copilot", "human", or "self") → use that target.
 *  2. If a matching error pattern exists → route to copilot (known fix).
 *  3. If strong repo context exists → route to copilot (enough background).
 *  4. Default → route to copilot with low confidence.
 */

import type { IMemoryBackend } from "../backend-factory.js";
import type { EmbeddingProvider } from "../embeddings.js";
import type { DelegationDecision, DelegationTarget } from "./types.js";
import { ErrorCapture } from "./error-capture.js";
import { RepoKnowledge } from "./repo-knowledge.js";
import { PreferenceTracker } from "./preference-tracker.js";

export type { DelegationDecision, DelegationTarget };

/** Maximum number of characters used when building a reason string from a stored memory. */
const MAX_REASON_LENGTH = 120;

export interface DelegationHelperOpts {
  /** Minimum similarity score to consider a memory relevant (0–1). */
  minScore?: number;
  /**
   * Repository to use when querying repo knowledge.
   * If omitted, repo-knowledge recall is skipped.
   */
  repository?: string;
}

export class DelegationHelper {
  private readonly errorCapture: ErrorCapture;
  private readonly repoKnowledge: RepoKnowledge;
  private readonly preferenceTracker: PreferenceTracker;

  constructor(
    private readonly backend: IMemoryBackend,
    private readonly embeddings: EmbeddingProvider,
  ) {
    this.errorCapture = new ErrorCapture(backend, embeddings);
    this.repoKnowledge = new RepoKnowledge(backend, embeddings);
    this.preferenceTracker = new PreferenceTracker(backend, embeddings);
  }

  /**
   * Decide how to handle the given task based on stored memory.
   *
   * @param task  Natural-language description of the task.
   * @param opts  Optional configuration (repository scope, score threshold).
   * @returns     A DelegationDecision with target, reason, and confidence.
   */
  async decide(
    task: string,
    opts: DelegationHelperOpts = {},
  ): Promise<DelegationDecision> {
    const minScore = opts.minScore ?? 0.5;

    // 1. Check for matching delegation override preferences
    const prefs = await this.preferenceTracker.recall(task, 3);
    const delegationPref = prefs.find(
      (r) =>
        r.score >= minScore &&
        r.entry.tags.includes("override-type:delegation"),
    );
    if (delegationPref) {
      // Read the stored `target:<value>` tag; only treat as an override if the target is valid.
      const targetTag = delegationPref.entry.tags.find((t) =>
        t.startsWith("target:"),
      );
      const rawTarget = targetTag?.slice("target:".length);
      const isValidTarget =
        rawTarget === "human" || rawTarget === "copilot" || rawTarget === "self";
      if (isValidTarget) {
        const target = rawTarget as DelegationTarget;
        return {
          target,
          reason: `Preference match: ${delegationPref.entry.content.slice(0, MAX_REASON_LENGTH)}`,
          confidence: delegationPref.score,
        };
      }
    }

    // 2. Check for a known error/fix pattern
    const errorFixes = await this.errorCapture.recallFix(task, 3);
    const bestFix = errorFixes.find((r) => r.score >= minScore);
    if (bestFix) {
      return {
        target: "copilot",
        reason: `Known fix available: ${bestFix.entry.content.slice(0, MAX_REASON_LENGTH)}`,
        confidence: bestFix.score,
      };
    }

    // 3. Check for relevant repo context
    if (opts.repository) {
      const repoCtx = await this.repoKnowledge.recall(
        opts.repository,
        task,
        3,
      );
      const bestCtx = repoCtx.find((r) => r.score >= minScore);
      if (bestCtx) {
        return {
          target: "copilot",
          reason: `Repo context available: ${bestCtx.entry.content.slice(0, MAX_REASON_LENGTH)}`,
          confidence: bestCtx.score,
        };
      }
    }

    // 4. Default fallback
    return {
      target: "copilot",
      reason: "No specific memory match; defaulting to Copilot.",
      confidence: 0.3,
    };
  }

  /** Expose sub-modules for direct access when needed. */
  get errors(): ErrorCapture {
    return this.errorCapture;
  }

  get repos(): RepoKnowledge {
    return this.repoKnowledge;
  }

  get preferences(): PreferenceTracker {
    return this.preferenceTracker;
  }
}
