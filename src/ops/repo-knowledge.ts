/**
 * Repo Knowledge
 *
 * Captures build system info, dependency quirks, and repo-specific context.
 * Enables informed issue filing and PR review by surfacing relevant knowledge
 * when working on a specific repository.
 *
 * Memories are stored under category "repo-context". When an
 * `EmbeddingProvider` is supplied, embeddings are computed before storage and
 * vector search is available for recall. When `null` is supplied, storage is
 * delegated to `backend.storeContent()` and recall returns an empty array.
 */

import type { IMemoryBackend } from "../backend-factory.js";
import type { EmbeddingProvider } from "../embeddings.js";
import type { MemoryEntry, MemorySearchResult } from "../memory-db.js";

export const REPO_CONTEXT_CATEGORY = "repo-context";

export interface CaptureRepoContextOpts {
  /** Build system used in the repository, e.g. "cargo", "npm", "gradle". */
  buildSystem?: string;
  /** Additional tags to attach to the memory. */
  tags?: string[];
}

export class RepoKnowledge {
  constructor(
    private readonly backend: IMemoryBackend,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  /**
   * Store a piece of knowledge about a repository — build quirks, dependency
   * constraints, architectural notes, etc.
   */
  async capture(
    repository: string,
    content: string,
    opts: CaptureRepoContextOpts = {},
  ): Promise<MemoryEntry> {
    const fullContent = `[${repository}] ${content}`;
    const tags: string[] = [
      `repository:${repository}`,
      ...(opts.buildSystem ? [`build:${opts.buildSystem}`] : []),
      ...(opts.tags ?? []),
    ];
    const storeOpts = { source: "repo-knowledge", category: REPO_CONTEXT_CATEGORY, tags };

    if (this.embeddings) {
      const embedding = await this.embeddings.embed(fullContent);
      const result = await this.backend.store(fullContent, embedding, storeOpts);
      return result.entry;
    }

    const result = await this.backend.storeContent(fullContent, storeOpts);
    return result.entry;
  }

  /**
   * Recall repository knowledge relevant to the given query,
   * optionally scoped to the specified repository via tag filtering.
   * Returns an empty array when no `EmbeddingProvider` was supplied.
   */
  async recall(
    repository: string | undefined,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    if (!this.embeddings) return [];
    const embedding = await this.embeddings.embed(query);
    const results = await this.backend.vectorSearch(embedding, limit * 3, 0.3);
    const repoTag = repository ? `repository:${repository}` : null;
    return results
      .filter((r) => {
        if (r.entry.category !== REPO_CONTEXT_CATEGORY) {
          return false;
        }
        if (!repoTag) {
          return true;
        }
        return r.entry.tags.includes(repoTag);
      })
      .slice(0, limit);
  }
}
