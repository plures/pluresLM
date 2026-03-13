/**
 * Intelligent memory.md generation from PluresDB vector memories
 * 
 * Automatically generates OpenClaw-compatible memory files that are smarter
 * than manual maintenance - using vector ranking, semantic clustering, and
 * automatic deduplication.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

export interface MemoryMdConfig {
  /** Where to write memory.md (default: ~/.openclaw/workspace/MEMORY.md) */
  memoryMdPath: string;
  /** Where to write daily files (default: ~/.openclaw/workspace/memory/) */
  dailyMemoryDir: string;
  /** Maximum memories in MEMORY.md (default: 50) */
  maxMemoriesInMain: number;
  /** Categories to prioritize in MEMORY.md */
  priorityCategories: string[];
  /** Minimum similarity threshold for clustering (default: 0.7) */
  clusterThreshold: number;
  /** Enable automatic generation (default: true) */
  enabled: boolean;
  /** Generation interval in minutes (default: 60) */
  intervalMinutes: number;
}

const DEFAULT_CONFIG: MemoryMdConfig = {
  memoryMdPath: "~/.openclaw/workspace/memory/MEMORY-AUTO.md",
  dailyMemoryDir: "~/.openclaw/workspace/memory",
  maxMemoriesInMain: 50,
  priorityCategories: ["decision", "project-context", "preference", "error-fix"],
  clusterThreshold: 0.7,
  enabled: true,
  intervalMinutes: 60,
};

export class MemoryMdGenerator {
  private config: MemoryMdConfig;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: Partial<MemoryMdConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.memoryMdPath = this.resolvePath(this.config.memoryMdPath);
    this.config.dailyMemoryDir = this.resolvePath(this.config.dailyMemoryDir);
  }

  private resolvePath(filePath: string): string {
    if (filePath.startsWith("~/")) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
      return path.join(homeDir, filePath.slice(2));
    }
    return path.resolve(filePath);
  }

  /**
   * Start automatic memory.md generation
   */
  start(getMemories: () => Promise<MemoryEntry[]>): void {
    if (!this.config.enabled || this.intervalId) return;

    // Generate immediately
    this.generateMemoryFiles(getMemories).catch(console.error);

    // Schedule periodic generation
    this.intervalId = setInterval(async () => {
      try {
        await this.generateMemoryFiles(getMemories);
      } catch (err) {
        console.error("[MemoryMdGenerator] Generation failed:", err);
      }
    }, this.config.intervalMinutes * 60 * 1000);

    console.log(`[MemoryMdGenerator] Started automatic generation (${this.config.intervalMinutes}min intervals)`);
  }

  /**
   * Stop automatic generation
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[MemoryMdGenerator] Stopped automatic generation");
    }
  }

  /**
   * Generate memory.md and daily files from current memory state
   */
  async generateMemoryFiles(getMemories: () => Promise<MemoryEntry[]>): Promise<void> {
    try {
      const memories = await getMemories();
      console.log(`[MemoryMdGenerator] Generating from ${memories.length} memories...`);

      // Generate main MEMORY.md with vector-ranked content
      await this.generateMainMemoryMd(memories);

      // Generate today's daily file  
      await this.generateDailyMemoryMd(memories);

      console.log("[MemoryMdGenerator] Generation complete");
    } catch (err) {
      console.error("[MemoryMdGenerator] Failed to generate memory files:", err);
    }
  }

  /**
   * Generate main MEMORY.md with top vector-ranked memories
   */
  private async generateMainMemoryMd(memories: MemoryEntry[]): Promise<void> {
    // Score and rank memories by importance
    const scoredMemories = this.scoreMemories(memories);
    
    // Cluster similar memories to avoid duplication
    const clusters = this.clusterMemories(scoredMemories);
    
    // Select top memories across clusters
    const selectedMemories = this.selectTopMemories(clusters, this.config.maxMemoriesInMain);

    // Generate markdown content
    const content = this.formatMemoryMd(selectedMemories);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(this.config.memoryMdPath), { recursive: true });

    // Write with metadata header
    const fullContent = this.addMetadataHeader(content, selectedMemories.length, memories.length);
    await fs.promises.writeFile(this.config.memoryMdPath, fullContent, "utf-8");

    console.log(`[MemoryMdGenerator] Updated ${this.config.memoryMdPath} (${selectedMemories.length}/${memories.length} memories)`);
  }

  /**
   * Generate daily memory file for today
   */
  private async generateDailyMemoryMd(memories: MemoryEntry[]): Promise<void> {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const dailyPath = path.join(this.config.dailyMemoryDir, `${today}.md`);

    // Get memories from today
    const todayStart = new Date(today).getTime();
    const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
    
    const todayMemories = memories.filter(m => 
      m.created_at >= todayStart && m.created_at < tomorrowStart
    );

    if (todayMemories.length === 0) {
      console.log(`[MemoryMdGenerator] No memories for ${today}, skipping daily file`);
      return;
    }

    // Sort by creation time
    todayMemories.sort((a, b) => b.created_at - a.created_at);

    // Generate content grouped by category
    const content = this.formatDailyMemoryMd(todayMemories, today);

    // Ensure directory exists  
    await fs.promises.mkdir(this.config.dailyMemoryDir, { recursive: true });

    // Write daily file
    await fs.promises.writeFile(dailyPath, content, "utf-8");

    console.log(`[MemoryMdGenerator] Updated ${dailyPath} (${todayMemories.length} memories)`);
  }

  /**
   * Score memories by importance using multiple signals
   */
  private scoreMemories(memories: MemoryEntry[]): Array<MemoryEntry & { score: number }> {
    return memories.map(memory => {
      let score = 0;

      // Category priority boost
      if (this.config.priorityCategories.includes(memory.category)) {
        score += 10;
      }

      // Recency boost (logarithmic decay)
      const ageHours = (Date.now() - memory.created_at) / (1000 * 60 * 60);
      score += Math.max(0, 5 - Math.log10(ageHours + 1));

      // Content length boost (longer = more substantial)
      score += Math.min(3, memory.content.length / 1000);

      // Tag diversity boost
      score += Math.min(2, (memory.tags?.length || 0) * 0.5);

      // Deduplication penalty (rough heuristic)
      if (memory.content.length < 50) score -= 2;
      if (memory.content.includes("duplicate") || memory.content.includes("repeat")) score -= 1;

      return { ...memory, score };
    });
  }

  /**
   * Cluster similar memories to avoid duplication in output
   */
  private clusterMemories(memories: Array<MemoryEntry & { score: number }>): Array<Array<MemoryEntry & { score: number }>> {
    const clusters: Array<Array<MemoryEntry & { score: number }>> = [];
    const used = new Set<string>();

    // Sort by score descending
    const sorted = [...memories].sort((a, b) => b.score - a.score);

    for (const memory of sorted) {
      if (used.has(memory.id)) continue;

      const cluster = [memory];
      used.add(memory.id);

      // Find similar memories for this cluster
      for (const other of sorted) {
        if (used.has(other.id)) continue;
        if (this.areSimilar(memory, other)) {
          cluster.push(other);
          used.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * Check if two memories are similar (for clustering)
   */
  private areSimilar(a: MemoryEntry, b: MemoryEntry): boolean {
    // Same category + overlapping keywords = similar
    if (a.category === b.category) {
      const aWords = new Set(a.content.toLowerCase().split(/\s+/));
      const bWords = new Set(b.content.toLowerCase().split(/\s+/));
      const intersection = new Set([...aWords].filter(w => bWords.has(w)));
      const overlap = intersection.size / Math.min(aWords.size, bWords.size);
      return overlap > this.config.clusterThreshold;
    }
    return false;
  }

  /**
   * Select top memories from clusters, ensuring diversity
   */
  private selectTopMemories(
    clusters: Array<Array<MemoryEntry & { score: number }>>, 
    maxCount: number
  ): Array<MemoryEntry & { score: number }> {
    const selected: Array<MemoryEntry & { score: number }> = [];
    
    // Sort clusters by best memory score
    clusters.sort((a, b) => b[0].score - a[0].score);

    // Take one from each cluster, then round-robin for remaining slots
    let clusterIndex = 0;
    while (selected.length < maxCount && clusterIndex < clusters.length) {
      const cluster = clusters[clusterIndex];
      if (cluster.length > Math.floor(selected.length / clusters.length)) {
        const memoryIndex = Math.floor(selected.length / clusters.length);
        if (cluster[memoryIndex]) {
          selected.push(cluster[memoryIndex]);
        }
      }
      clusterIndex = (clusterIndex + 1) % clusters.length;
    }

    return selected;
  }

  /**
   * Format memories as MEMORY.md content
   */
  private formatMemoryMd(memories: Array<MemoryEntry & { score: number }>): string {
    const sections = new Map<string, Array<MemoryEntry & { score: number }>>();

    // Group by category
    for (const memory of memories) {
      const category = memory.category || "uncategorized";
      if (!sections.has(category)) sections.set(category, []);
      sections.get(category)!.push(memory);
    }

    let content = "# MEMORY.md\n\nCurated long-term memory (auto-generated from vector memory).\n\n";

    // Sort sections by priority
    const sortedSections = Array.from(sections.entries()).sort(([a], [b]) => {
      const aPrio = this.config.priorityCategories.indexOf(a);
      const bPrio = this.config.priorityCategories.indexOf(b);
      if (aPrio >= 0 && bPrio >= 0) return aPrio - bPrio;
      if (aPrio >= 0) return -1;
      if (bPrio >= 0) return 1;
      return a.localeCompare(b);
    });

    for (const [category, categoryMemories] of sortedSections) {
      content += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n`;
      
      for (const memory of categoryMemories) {
        const excerpt = memory.content.substring(0, 200);
        const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : "";
        content += `- **${new Date(memory.created_at).toLocaleDateString()}**: ${excerpt}${excerpt.length >= 200 ? "..." : ""}${tags}\n`;
      }
      
      content += "\n";
    }

    return content;
  }

  /**
   * Format daily memories as daily.md content
   */
  private formatDailyMemoryMd(memories: MemoryEntry[], date: string): string {
    let content = `# Daily Memory - ${date}\n\nMemories captured today:\n\n`;

    const byCategory = new Map<string, MemoryEntry[]>();
    for (const memory of memories) {
      const cat = memory.category || "uncategorized";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(memory);
    }

    for (const [category, categoryMemories] of byCategory) {
      content += `## ${category}\n\n`;
      for (const memory of categoryMemories) {
        const time = new Date(memory.created_at).toLocaleTimeString();
        content += `**${time}**: ${memory.content}\n\n`;
      }
    }

    return content;
  }

  /**
   * Add metadata header to memory.md
   */
  private addMetadataHeader(content: string, selectedCount: number, totalCount: number): string {
    const timestamp = new Date().toISOString();
    const header = `<!--
Auto-generated by PluresLM on ${timestamp}
Selected ${selectedCount} of ${totalCount} memories using vector ranking
Priority categories: ${this.config.priorityCategories.join(", ")}
-->\n\n`;
    
    return header + content;
  }
}