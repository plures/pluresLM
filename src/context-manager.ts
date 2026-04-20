/**
 * Context management - thin stateless helper for per-turn and session-start memory retrieval.
 *
 * Uses vector similarity search (vectorSearchBoosted) for per-turn context and
 * getMemoriesByCategories for session-start context. No background timer or
 * word-overlap scoring.
 */

import type { MemoryEntry } from "./types.js";
import type { PluresDBBackend } from "./pluresdb-backend.js";

export interface ContextConfig {
  /** Maximum memories to inject in context */
  maxContextMemories: number;
  /** Recency bias weight (0-1, higher = prefer recent) for session-start queries */
  recencyBias: number;
  /** Categories fetched at session start */
  priorityCategories: string[];
  /** Categories excluded from per-turn vector recall */
  excludeCategories?: Set<string>;
  /** Max results from any single category (diversity cap). Default: ceil(maxContextMemories * 0.6) */
  maxPerCategory?: number;
}

export class ContextManager {
  constructor(private db: PluresDBBackend, private config: ContextConfig) {}

  /**
   * Retrieve context memories for the current prompt using vector similarity search.
   * Called on every turn after session start.
   */
  async getContextForPrompt(
    prompt: string,
    embedFn: (text: string) => Promise<number[]>,
  ): Promise<MemoryEntry[]> {
    const embedding = await embedFn(prompt);
    const cap = this.config.maxPerCategory ?? Math.ceil(this.config.maxContextMemories * 0.6);
    const results = await this.db.vectorSearchBoosted(
      embedding,
      this.config.maxContextMemories,
      0.3,
      { "work-in-progress": 1.3 },
      this.config.excludeCategories,
      cap,
    );
    return results.map((r) => r.entry);
  }

  /**
   * Retrieve priority memories for session-start context injection (turn 0).
   * Uses getMemoriesByCategories with recency bias — no embedding required.
   */
  async getSessionStartContext(): Promise<MemoryEntry[]> {
    return this.db.getMemoriesByCategories(
      this.config.priorityCategories,
      this.config.maxContextMemories,
      this.config.recencyBias,
    );
  }
}