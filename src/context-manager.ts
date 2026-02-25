/**
 * Real-time context management - maintains optimal memory context without compaction
 *
 * Replaces periodic compaction with intelligent, continuous context curation.
 * Always maintains the most relevant memories within safe token limits.
 */

import type { MemoryEntry } from "./types.js";

export interface ContextConfig {
  /** Maximum memories to inject in session context */
  maxContextMemories: number;
  /** Maximum total characters in context */
  maxContextChars: number;
  /** Recency bias weight (0-1, higher = prefer recent) */
  recencyBias: number;
  /** Categories that always get priority */
  alwaysInclude: string[];
  /** Refresh context analysis interval (minutes) */
  refreshIntervalMinutes: number;
}

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxContextMemories: 10,
  maxContextChars: 4000,
  recencyBias: 0.3,
  alwaysInclude: ["decision", "preference", "error-fix"],
  refreshIntervalMinutes: 5,
};

interface ContextMemory extends MemoryEntry {
  relevanceScore: number;
  contextPriority: number;
  lastAccessed: number;
}

export class ContextManager {
  private config: ContextConfig;
  private currentContext: ContextMemory[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private sessionHistory: string[] = [];

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  }

  /**
   * Start real-time context management
   */
  start(getMemories: () => Promise<MemoryEntry[]>): void {
    if (this.refreshTimer) return;

    // Initial context build
    this.refreshContext(getMemories).catch(console.error);

    // Periodic refresh
    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshContext(getMemories);
      } catch (err) {
        console.error("[ContextManager] Refresh failed:", err);
      }
    }, this.config.refreshIntervalMinutes * 60 * 1000);

    console.log(`[ContextManager] Started real-time context management (${this.config.refreshIntervalMinutes}min refresh)`);
  }

  /**
   * Stop context management
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Add session message to history for context relevance scoring
   */
  addSessionMessage(message: string): void {
    this.sessionHistory.push(message);
    
    // Keep last 20 messages for context analysis
    if (this.sessionHistory.length > 20) {
      this.sessionHistory = this.sessionHistory.slice(-20);
    }
  }

  /**
   * Get current optimal context for session injection
   */
  getCurrentContext(): MemoryEntry[] {
    return this.currentContext
      .sort((a, b) => b.contextPriority - a.contextPriority)
      .slice(0, this.config.maxContextMemories);
  }

  /**
   * Refresh context analysis and selection
   */
  private async refreshContext(getMemories: () => Promise<MemoryEntry[]>): Promise<void> {
    try {
      const allMemories = await getMemories();
      const sessionContext = this.sessionHistory.join(" ");
      
      // Score all memories for current session relevance
      const contextMemories = await this.scoreMemoriesForContext(allMemories, sessionContext);
      
      // Select optimal set
      this.currentContext = this.selectOptimalContext(contextMemories);
      
      console.log(`[ContextManager] Context refreshed: ${this.currentContext.length} memories selected`);
    } catch (err) {
      console.error("[ContextManager] Context refresh failed:", err);
    }
  }

  /**
   * Score memories for current session context relevance
   */
  private async scoreMemoriesForContext(memories: MemoryEntry[], sessionContext: string): Promise<ContextMemory[]> {
    const now = Date.now();
    const sessionWords = new Set(sessionContext.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    
    return memories.map(memory => {
      let score = 0;

      // 1. Semantic relevance to current session
      const memoryWords = new Set(memory.content.toLowerCase().split(/\s+/));
      const overlap = [...sessionWords].filter(w => memoryWords.has(w)).length;
      score += overlap * 2;

      // 2. Category priority
      if (this.config.alwaysInclude.includes(memory.category)) {
        score += 10;
      }

      // 3. Recency boost
      const ageHours = (now - memory.created_at) / (1000 * 60 * 60);
      const recencyScore = Math.max(0, 5 * Math.exp(-ageHours / 168)); // Half-life of 1 week
      score += recencyScore * this.config.recencyBias;

      // 4. Access frequency boost
      const accessScore = (memory as any).accessCount || 0;
      score += Math.log10(accessScore + 1);

      // 5. Content quality heuristics
      if (memory.content.length > 100 && memory.content.length < 2000) score += 2; // Sweet spot
      if (memory.tags && memory.tags.length > 0) score += 1;

      // 6. Avoid very old or very short memories unless high priority
      if (ageHours > 30 * 24 && !this.config.alwaysInclude.includes(memory.category)) score *= 0.5;
      if (memory.content.length < 50) score *= 0.7;

      return {
        ...memory,
        relevanceScore: score,
        contextPriority: score, // Will be adjusted in selection
        lastAccessed: now,
      } as ContextMemory;
    });
  }

  /**
   * Select optimal context set within character/count limits
   */
  private selectOptimalContext(candidates: ContextMemory[]): ContextMemory[] {
    // Sort by relevance score
    const sorted = [...candidates].sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    const selected: ContextMemory[] = [];
    let totalChars = 0;
    
    // First pass: always include high-priority categories
    for (const memory of sorted) {
      if (this.config.alwaysInclude.includes(memory.category) && 
          selected.length < this.config.maxContextMemories &&
          totalChars + memory.content.length <= this.config.maxContextChars) {
        selected.push(memory);
        totalChars += memory.content.length;
      }
    }

    // Second pass: fill remaining slots with highest-scoring memories
    for (const memory of sorted) {
      if (selected.find(s => s.id === memory.id)) continue; // Already included
      
      if (selected.length >= this.config.maxContextMemories || 
          totalChars + memory.content.length > this.config.maxContextChars) {
        break;
      }

      selected.push(memory);
      totalChars += memory.content.length;
    }

    // Adjust context priority based on final selection
    selected.forEach((memory, index) => {
      memory.contextPriority = memory.relevanceScore + (selected.length - index);
    });

    return selected;
  }

  /**
   * Get context statistics for monitoring
   */
  getContextStats(): { 
    count: number; 
    totalChars: number; 
    categories: Record<string, number>;
    avgAge: number;
  } {
    const now = Date.now();
    const categories: Record<string, number> = {};
    let totalAge = 0;
    let totalChars = 0;

    for (const memory of this.currentContext) {
      categories[memory.category] = (categories[memory.category] || 0) + 1;
      totalAge += now - memory.created_at;
      totalChars += memory.content.length;
    }

    return {
      count: this.currentContext.length,
      totalChars,
      categories,
      avgAge: this.currentContext.length > 0 ? totalAge / this.currentContext.length : 0,
    };
  }

  /**
   * Manual context refresh (for testing or immediate updates)
   */
  async forceRefresh(getMemories: () => Promise<MemoryEntry[]>): Promise<void> {
    await this.refreshContext(getMemories);
  }
}