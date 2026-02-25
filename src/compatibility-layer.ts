/**
 * Compatibility Layer: Handles dual-mode operation
 * 
 * Enhanced Mode: PluresLM as single source of truth
 * Compatible Mode: Coexists with OpenClaw's file-based memory system
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry } from "./types.js";
import type { OperatingMode, CompatibilityConfig } from "./compatibility.js";

export interface FileMemoryEntry {
  content: string;
  source: string;
  category: string;
  tags: string[];
  created_at: number;
  priority?: string;
}

export class CompatibilityLayer {
  private workspaceDir: string;
  private memoryFile: string;
  private memoryDir: string;
  private lastSyncTime = 0;
  private syncInProgress = false;

  constructor(
    private mode: OperatingMode,
    private config: CompatibilityConfig,
    workspaceDir?: string
  ) {
    this.workspaceDir = workspaceDir || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.openclaw', 'workspace');
    this.memoryFile = path.join(this.workspaceDir, 'MEMORY.md');
    this.memoryDir = path.join(this.workspaceDir, 'memory');
  }

  /**
   * Initialize compatibility layer based on operating mode
   */
  async initialize(): Promise<void> {
    if (this.mode === 'compatible') {
      await this.ensureDirectoriesExist();
      await this.initializeCompatibilityTracking();
    }
  }

  /**
   * Sync PluresLM data to file-based memory (Enhanced → Files)
   */
  async syncToFiles(memories: MemoryEntry[]): Promise<void> {
    if (this.mode === 'enhanced' || !this.config.vanillaFallback.enableFileMemory) {
      return; // No file sync needed
    }

    if (this.syncInProgress) {
      return; // Avoid concurrent syncs
    }

    this.syncInProgress = true;
    try {
      await this.generateMemoryMd(memories);
      await this.syncDailyFiles(memories);
      await this.updateCompatibilityState();
      this.lastSyncTime = Date.now();
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Import file-based memory to PluresLM (Files → Enhanced) 
   */
  async syncFromFiles(): Promise<FileMemoryEntry[]> {
    if (!this.config.vanillaFallback.enableFileMemory) {
      return [];
    }

    const fileMemories: FileMemoryEntry[] = [];

    // Parse MEMORY.md
    if (fs.existsSync(this.memoryFile)) {
      const memoryEntries = await this.parseMemoryMd(this.memoryFile);
      fileMemories.push(...memoryEntries);
    }

    // Parse daily files
    if (fs.existsSync(this.memoryDir)) {
      const dailyEntries = await this.parseDailyFiles();
      fileMemories.push(...dailyEntries);
    }

    return fileMemories;
  }

  /**
   * Get session context based on operating mode
   */
  async getSessionContext(
    pluresMemories: MemoryEntry[], 
    query?: string
  ): Promise<{ content: string; source: 'plures' | 'files' | 'hybrid' }> {
    if (this.mode === 'enhanced') {
      // Enhanced mode: PluresLM only
      return {
        content: this.formatPluresMemories(pluresMemories),
        source: 'plures'
      };
    }

    if (!this.config.vanillaFallback.hybridRecall) {
      // Compatible mode: PluresLM only (files disabled)
      return {
        content: this.formatPluresMemories(pluresMemories),
        source: 'plures'
      };
    }

    // Compatible mode: Hybrid recall
    const fileMemories = await this.syncFromFiles();
    const combinedContent = this.mergeMemoryContext(pluresMemories, fileMemories, query);
    
    return {
      content: combinedContent,
      source: 'hybrid'
    };
  }

  /**
   * Handle compaction assistance (Compatible mode only)
   */
  async handleCompactionAssist(sessionSummary: string): Promise<void> {
    if (this.mode === 'enhanced' || !this.config.vanillaFallback.compactionAssist) {
      return;
    }

    // Extract insights from session summary
    const insights = await this.extractCompactionInsights(sessionSummary);
    
    // Store insights in both PluresLM and daily file
    const today = new Date().toISOString().split('T')[0];
    const dailyFile = path.join(this.memoryDir, `${today}.md`);
    
    await this.appendToDailyFile(dailyFile, insights);
  }

  /**
   * Generate assisted memory.md updates
   */
  async generateAssistedMemoryUpdate(
    memories: MemoryEntry[],
    force = false
  ): Promise<{ updated: boolean; preview: string }> {
    if (this.mode === 'enhanced' && !force) {
      return { updated: false, preview: '' };
    }

    const memoryGenMode = this.config.vanillaFallback.memoryGeneration;
    if (memoryGenMode === 'manual') {
      return { updated: false, preview: '' };
    }

    const newContent = await this.generateMemoryMdContent(memories);
    const currentContent = fs.existsSync(this.memoryFile) 
      ? fs.readFileSync(this.memoryFile, 'utf8')
      : '';

    if (newContent === currentContent.trim()) {
      return { updated: false, preview: newContent };
    }

    if (memoryGenMode === 'auto') {
      await this.writeMemoryFile(newContent);
      return { updated: true, preview: newContent };
    } else {
      // assisted mode - return preview only
      return { updated: false, preview: newContent };
    }
  }

  // ── Implementation Details ──────────────────────────────────────────────

  private async ensureDirectoriesExist(): Promise<void> {
    try {
      await fs.promises.mkdir(this.memoryDir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }
  }

  private async initializeCompatibilityTracking(): Promise<void> {
    const compatFile = path.join(this.workspaceDir, '.pluresLM', 'compatibility.json');
    const compatDir = path.dirname(compatFile);
    
    try {
      await fs.promises.mkdir(compatDir, { recursive: true });
      
      const compatData = {
        mode: this.mode,
        initialized: Date.now(),
        lastSync: this.lastSyncTime,
        version: '1.0.0'
      };
      
      await fs.promises.writeFile(compatFile, JSON.stringify(compatData, null, 2));
    } catch (e) {
      console.warn('[PluresLM] Failed to initialize compatibility tracking:', e);
    }
  }

  private async generateMemoryMd(memories: MemoryEntry[]): Promise<void> {
    const content = await this.generateMemoryMdContent(memories);
    await this.writeMemoryFile(content);
  }

  private async generateMemoryMdContent(memories: MemoryEntry[]): Promise<string> {
    // Group memories by category for better organization
    const categories = new Map<string, MemoryEntry[]>();
    
    for (const memory of memories) {
      if (!categories.has(memory.category)) {
        categories.set(memory.category, []);
      }
      categories.get(memory.category)!.push(memory);
    }

    const sections: string[] = [
      '# MEMORY.md',
      '',
      'Curated long-term memory for PluresLM integration.',
      '',
      '> This file is automatically generated from PluresLM vector memory.',
      '> Manual edits may be overwritten. For permanent changes, store in PluresLM directly.',
      ''
    ];

    // Priority order for categories
    const priorityOrder = ['decision', 'preference', 'project-context', 'error-fix', 'explicit'];
    const orderedCategories = [...priorityOrder, ...Array.from(categories.keys()).filter(cat => !priorityOrder.includes(cat))];

    for (const category of orderedCategories) {
      const categoryMemories = categories.get(category);
      if (!categoryMemories || categoryMemories.length === 0) continue;

      sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}`);
      
      // Sort by priority and recency
      const sorted = categoryMemories
        .sort((a, b) => {
          const priorityScore = (m: MemoryEntry) => 
            m.priority === 'critical' ? 4 : m.priority === 'high' ? 3 : m.priority === 'normal' ? 2 : 1;
          const aPriority = priorityScore(a);
          const bPriority = priorityScore(b);
          if (aPriority !== bPriority) return bPriority - aPriority;
          return b.created_at - a.created_at;
        })
        .slice(0, 10); // Limit to top 10 per category

      for (const memory of sorted) {
        const date = new Date(memory.created_at).toISOString().split('T')[0];
        const tags = memory.tags.length > 0 ? ` (${memory.tags.join(', ')})` : '';
        sections.push(`- **${date}**: ${memory.content}${tags}`);
      }
      
      sections.push('');
    }

    return sections.join('\n');
  }

  private async syncDailyFiles(memories: MemoryEntry[]): Promise<void> {
    // Group memories by date
    const dailyGroups = new Map<string, MemoryEntry[]>();
    
    for (const memory of memories) {
      const date = new Date(memory.created_at).toISOString().split('T')[0];
      if (!dailyGroups.has(date)) {
        dailyGroups.set(date, []);
      }
      dailyGroups.get(date)!.push(memory);
    }

    // Update daily files for recent dates only (last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    for (const [date, dayMemories] of dailyGroups) {
      const dateMs = new Date(date).getTime();
      if (dateMs < thirtyDaysAgo) continue;

      const dailyFile = path.join(this.memoryDir, `${date}.md`);
      const content = this.generateDailyFileContent(date, dayMemories);
      
      try {
        await fs.promises.writeFile(dailyFile, content, 'utf8');
      } catch (e) {
        console.warn(`[PluresLM] Failed to write daily file ${date}:`, e);
      }
    }
  }

  private generateDailyFileContent(date: string, memories: MemoryEntry[]): string {
    const lines: string[] = [
      `# ${date}`,
      '',
      'Daily memories from PluresLM.',
      ''
    ];

    for (const memory of memories.sort((a, b) => a.created_at - b.created_at)) {
      const time = new Date(memory.created_at).toLocaleTimeString();
      const category = memory.category !== 'conversation' ? ` [${memory.category}]` : '';
      lines.push(`**${time}${category}**: ${memory.content}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private async parseMemoryMd(filePath: string): Promise<FileMemoryEntry[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const entries: FileMemoryEntry[] = [];
      
      // Simple parsing - extract bullet points with dates
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^-\s*\*\*(\d{4}-\d{2}-\d{2})\*\*:\s*(.+)$/);
        if (match) {
          const [, date, text] = match;
          entries.push({
            content: text,
            source: 'MEMORY.md',
            category: 'migrated-memory',
            tags: [`date:${date}`],
            created_at: new Date(date).getTime(),
            priority: 'normal'
          });
        }
      }
      
      return entries;
    } catch (e) {
      return [];
    }
  }

  private async parseDailyFiles(): Promise<FileMemoryEntry[]> {
    try {
      const files = await fs.promises.readdir(this.memoryDir);
      const entries: FileMemoryEntry[] = [];
      
      for (const file of files) {
        if (file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
          const date = file.replace('.md', '');
          const filePath = path.join(this.memoryDir, file);
          const fileEntries = await this.parseDailyFile(filePath, date);
          entries.push(...fileEntries);
        }
      }
      
      return entries;
    } catch (e) {
      return [];
    }
  }

  private async parseDailyFile(filePath: string, date: string): Promise<FileMemoryEntry[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const entries: FileMemoryEntry[] = [];
      
      // Parse paragraphs as separate entries
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim());
      
      for (const paragraph of paragraphs) {
        if (paragraph.startsWith('#') || paragraph.length < 10) continue;
        
        entries.push({
          content: paragraph.trim(),
          source: `memory/${date}.md`,
          category: 'daily-summary',
          tags: [`date:${date}`],
          created_at: new Date(date).getTime(),
          priority: 'normal'
        });
      }
      
      return entries;
    } catch (e) {
      return [];
    }
  }

  private formatPluresMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map(memory => {
      const attribution = memory.originator_name || memory.originator_id || 'system';
      const status = memory.status ? ` [${memory.status}]` : '';
      return `- [${memory.category}] [${attribution}]${status} ${memory.content}`;
    });

    return lines.join('\n');
  }

  private mergeMemoryContext(
    pluresMemories: MemoryEntry[],
    fileMemories: FileMemoryEntry[],
    query?: string
  ): string {
    // Deduplicate and merge
    const allContent = new Set<string>();
    const lines: string[] = [];

    // Add PluresLM memories (higher priority)
    for (const memory of pluresMemories) {
      const content = memory.content.toLowerCase();
      if (!allContent.has(content)) {
        allContent.add(content);
        const attribution = memory.originator_name || 'PluresLM';
        lines.push(`- [${memory.category}] [${attribution}] ${memory.content}`);
      }
    }

    // Add file memories if not duplicated
    for (const memory of fileMemories) {
      const content = memory.content.toLowerCase();
      if (!allContent.has(content)) {
        allContent.add(content);
        lines.push(`- [${memory.category}] [${memory.source}] ${memory.content}`);
      }
    }

    return lines.join('\n');
  }

  private async extractCompactionInsights(summary: string): Promise<string> {
    const insights: string[] = [];
    
    // Extract decision-like patterns
    const decisions = summary.match(/(?:decided|will use|going to|plan to|let's use)[^.!?]+[.!?]/gi);
    if (decisions) {
      insights.push('## Decisions\n' + decisions.map(d => `- ${d}`).join('\n'));
    }

    // Extract WIP patterns  
    const wip = summary.match(/(?:working on|building|implementing|TODO|FIXME)[^.!?]+[.!?]/gi);
    if (wip) {
      insights.push('## Work in Progress\n' + wip.map(w => `- ${w}`).join('\n'));
    }

    return insights.length > 0 ? insights.join('\n\n') : `## Session Summary\n\n${summary.slice(0, 500)}...`;
  }

  private async appendToDailyFile(filePath: string, content: string): Promise<void> {
    try {
      const existing = fs.existsSync(filePath) ? await fs.promises.readFile(filePath, 'utf8') : '';
      const newContent = existing + '\n\n' + content;
      await fs.promises.writeFile(filePath, newContent, 'utf8');
    } catch (e) {
      console.warn('[PluresLM] Failed to append to daily file:', e);
    }
  }

  private async writeMemoryFile(content: string): Promise<void> {
    try {
      // Create backup of existing file
      if (fs.existsSync(this.memoryFile)) {
        const backupPath = `${this.memoryFile}.bak.${Date.now()}`;
        await fs.promises.copyFile(this.memoryFile, backupPath);
      }
      
      await fs.promises.writeFile(this.memoryFile, content, 'utf8');
    } catch (e) {
      console.warn('[PluresLM] Failed to write memory file:', e);
      throw e;
    }
  }

  private async updateCompatibilityState(): Promise<void> {
    const compatFile = path.join(this.workspaceDir, '.pluresLM', 'compatibility.json');
    
    try {
      const existing = fs.existsSync(compatFile) 
        ? JSON.parse(await fs.promises.readFile(compatFile, 'utf8'))
        : {};
      
      existing.lastSync = this.lastSyncTime;
      existing.syncCount = (existing.syncCount || 0) + 1;
      
      await fs.promises.writeFile(compatFile, JSON.stringify(existing, null, 2));
    } catch (e) {
      // Non-critical error
    }
  }
}