/**
 * Preference Tracker
 *
 * Learns from human overrides — when the human corrects a delegation
 * decision, code style choice, or priority, this captures the preference
 * so it is not repeated.
 *
 * Memories are stored under category "preference". When an
 * `EmbeddingProvider` is supplied, embeddings are computed before storage and
 * vector search is available for recall. When `null` is supplied, storage is
 * delegated to `backend.storeContent()` and recall returns an empty array.
 */

import type { IMemoryBackend } from "../backend-factory.js";
import type { EmbeddingProvider } from "../embeddings.js";
import type { MemoryEntry, MemorySearchResult } from "../memory-db.js";

export const PREFERENCE_CATEGORY = "preference";

export type PreferenceOverrideType =
  | "delegation"
  | "code-style"
  | "priority"
  | "other";

export interface CapturePreferenceOpts {
  /** The kind of decision that was overridden by the human. */
  overrideType?: PreferenceOverrideType;
  /**
   * When `overrideType` is `"delegation"`, the intended routing target.
   * Stored as a `target:<value>` tag and read back by `DelegationHelper`.
   */
  delegationTarget?: "copilot" | "human" | "self";
  /** Additional tags to attach to the memory. */
  tags?: string[];
}

export class PreferenceTracker {
  constructor(
    private readonly backend: IMemoryBackend,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  /**
   * Record a human override so the same preference is applied in future
   * similar situations.
   *
   * @param context   Description of the situation where the override occurred.
   * @param preference The corrected or preferred behaviour.
   * @param opts      Optional metadata (override type, extra tags).
   */
  async capture(
    context: string,
    preference: string,
    opts: CapturePreferenceOpts = {},
  ): Promise<MemoryEntry> {
    const content = `Context: ${context}\nPreference: ${preference}`;
    const overrideType = opts.overrideType ?? "other";
    const tags: string[] = [
      `override-type:${overrideType}`,
      ...(opts.delegationTarget ? [`target:${opts.delegationTarget}`] : []),
      ...(opts.tags ?? []),
    ];
    const storeOpts = { source: "human-override", category: PREFERENCE_CATEGORY, tags };

    if (this.embeddings) {
      const embedding = await this.embeddings.embed(content);
      const result = await this.backend.store(content, embedding, storeOpts);
      return result.entry;
    }

    const result = await this.backend.storeContent(content, storeOpts);
    return result.entry;
  }

  /**
   * Recall preferences relevant to the given context.
   * Returns results ordered by relevance score.
   * Returns an empty array when no `EmbeddingProvider` was supplied.
   */
  async recall(context: string, limit = 5): Promise<MemorySearchResult[]> {
    if (!this.embeddings) return [];
    const embedding = await this.embeddings.embed(context);
    const results = await this.backend.vectorSearch(embedding, limit * 3, 0.3);
    return results
      .filter((r) => r.entry.category === PREFERENCE_CATEGORY)
      .slice(0, limit);
  }
}
