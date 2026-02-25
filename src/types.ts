/**
 * Shared types for pluresLM.
 * Shared type definitions for pluresLM memory entries and search results.
 */

export type MemoryPriority = "critical" | "high" | "normal" | "low";

/** Options accepted by content-only store operations (no pre-computed embedding). */
export interface StoreContentOpts {
  source?: string;
  tags?: string[];
  category?: string;
  priority?: MemoryPriority;
  originator_id?: string;
  originator_name?: string;
  destination?: string;
  status?: string;
  assigned_to?: string;
  due_at?: number;
  last_checkin?: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  created_at: number;
  source: string;
  tags: string[];
  category: string;
  priority?: MemoryPriority;
  last_accessed_at?: number;
  merge_count?: number;
  importance_score?: number;
  conversation_tag_ids?: string[];
  originator_id?: string;
  originator_name?: string;
  destination?: string;
  status?: string;
  assigned_to?: string;
  due_at?: number;
  last_checkin?: number;
}

export interface ConversationTag {
  id: string;
  label: string;
  embedding: number[];
  parent_tag_id?: string;
  message_ids: string[];
  created_at: number;
  updated_at: number;
  similarity_threshold: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface ProfileData {
  summary: string;
  facts: string[];
  updated_at: number;
  capture_count: number;
}

export interface DailySummary {
  date: string;
  summary: string;
  memoryCount: number;
  categories: Record<string, number>;
  created_at: number;
}

/**
 * Determine priority based on category and tags.
 */
export function determinePriority(category: string, tags: string[]): MemoryPriority {
  if (tags.includes("critical") || tags.includes("permanent")) return "critical";
  
  switch (category) {
    case "explicit":
    case "decision":
    case "entity":
    case "preference":
    case "architecture-decision":
      return "high";
    case "conversation":
      return "low";
    default:
      return "normal";
  }
}
