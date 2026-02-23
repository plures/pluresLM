/**
 * Preference Tracker
 *
 * Learns from human overrides — when the human corrects a delegation
 * decision, code style choice, or priority, this captures the preference
 * so it is not repeated.
 *
 * Memories are stored under category "preference" using the PluresDB
 * backend for auto-embedding and vector search.
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
  /** Additional tags to attach to the memory. */
  tags?: string[];
}

export class PreferenceTracker {
  constructor(
    private readonly backend: IMemoryBackend,
    private readonly embeddings: EmbeddingProvider,
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
    const embedding = await this.embeddings.embed(content);
    const overrideType = opts.overrideType ?? "other";
    const tags: string[] = [
      `override-type:${overrideType}`,
      ...(opts.tags ?? []),
    ];

    const result = await this.backend.store(content, embedding, {
      source: "human-override",
      category: PREFERENCE_CATEGORY,
      tags,
    });

    return result.entry;
  }

  /**
   * Recall preferences relevant to the given context.
   * Returns results ordered by relevance score.
   */
  async recall(context: string, limit = 5): Promise<MemorySearchResult[]> {
    const embedding = await this.embeddings.embed(context);
    const results = await this.backend.vectorSearch(embedding, limit * 3, 0.3);
    return results
      .filter((r) => r.entry.category === PREFERENCE_CATEGORY)
      .slice(0, limit);
  }
}
