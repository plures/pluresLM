/**
 * Error Pattern Capture
 *
 * Stores CI failure/fix pairs with repository context so that when a CI
 * error recurs, recall surfaces the previous fix.
 *
 * Memories are stored under category "error-pattern", with embeddings
 * computed via the configured EmbeddingProvider before being stored in the
 * PluresDB backend for vector search.
 */

import type { IMemoryBackend } from "../backend-factory.js";
import type { EmbeddingProvider } from "../embeddings.js";
import type { MemoryEntry, MemorySearchResult } from "../memory-db.js";

export const ERROR_PATTERN_CATEGORY = "error-pattern";

export interface CaptureErrorOpts {
  /** Repository where the CI failure occurred, e.g. "plures/pluresdb". */
  repository?: string;
  /** CI system identifier, e.g. "github-actions". */
  ciSystem?: string;
  /** Additional tags to attach to the memory. */
  tags?: string[];
}

export class ErrorCapture {
  constructor(
    private readonly backend: IMemoryBackend,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  /**
   * Store a CI failure/fix pair so it can be recalled when the same error
   * recurs in the future.
   */
  async captureError(
    error: string,
    fix: string,
    opts: CaptureErrorOpts = {},
  ): Promise<MemoryEntry> {
    const content = `Error: ${error}\nFix: ${fix}`;
    const embedding = await this.embeddings.embed(content);
    const tags: string[] = [
      ...(opts.repository ? [`repository:${opts.repository}`] : []),
      ...(opts.ciSystem ? [`ci:${opts.ciSystem}`] : []),
      ...(opts.tags ?? []),
    ];

    const result = await this.backend.store(content, embedding, {
      source: "ci-failure",
      category: ERROR_PATTERN_CATEGORY,
      tags,
    });

    return result.entry;
  }

  /**
   * Search for stored fixes that are semantically similar to the given error.
   * Returns results ordered by relevance score.
   */
  async recallFix(error: string, limit = 5): Promise<MemorySearchResult[]> {
    const embedding = await this.embeddings.embed(error);
    const results = await this.backend.vectorSearch(embedding, limit * 3, 0.3);
    return results
      .filter((r) => r.entry.category === ERROR_PATTERN_CATEGORY)
      .slice(0, limit);
  }
}
