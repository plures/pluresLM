/**
 * Repo Knowledge
 *
 * Captures build system info, dependency quirks, and repo-specific context.
 * Enables informed issue filing and PR review by surfacing relevant knowledge
 * when working on a specific repository.
 *
 * Memories are stored under category "repo-context" using the PluresDB
 * backend for auto-embedding and vector search.
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
    private readonly embeddings: EmbeddingProvider,
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
    const embedding = await this.embeddings.embed(fullContent);
    const tags: string[] = [
      `repository:${repository}`,
      ...(opts.buildSystem ? [`build:${opts.buildSystem}`] : []),
      ...(opts.tags ?? []),
    ];

    const result = await this.backend.store(fullContent, embedding, {
      source: "repo-knowledge",
      category: REPO_CONTEXT_CATEGORY,
      tags,
    });

    return result.entry;
  }

  /**
   * Recall repository knowledge relevant to the given query.
   * Optionally scoped to a specific repository via tag filtering.
   */
  async recall(
    repository: string,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    const embedding = await this.embeddings.embed(query);
    const results = await this.backend.vectorSearch(embedding, limit * 3, 0.3);
    const repoTag = `repository:${repository}`;
    return results
      .filter(
        (r) =>
          r.entry.category === REPO_CONTEXT_CATEGORY &&
          r.entry.tags.includes(repoTag),
      )
      .slice(0, limit);
  }
}
