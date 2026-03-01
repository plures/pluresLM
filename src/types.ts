/**
 * Shared types for pluresLM.
 * Shared type definitions for pluresLM memory entries and search results.
 */

export type MemoryPriority = "critical" | "high" | "normal" | "low";

/** Document types supported by the document memory category. */
export type DocType = "google-docs" | "pdf" | "spreadsheet" | "presentation" | "other";

/**
 * Structured metadata for document and document-chunk memory entries.
 * Fields are serialised as `meta:<key>:<value>` tags for backend persistence
 * (the backend stores fixed columns + tags only). Pass via `StoreContentOpts.metadata`.
 */
export interface DocumentMetadata {
  source_path?: string;
  author?: string;
  doc_type?: DocType;
  created_date?: string;
  word_count?: number;
  original_url?: string;
}

/** Options accepted by content-only store operations (no pre-computed embedding). */
export interface StoreContentOpts {
  source?: string;
  tags?: string[];
  category?: string;
  priority?: MemoryPriority;
  /** Document metadata; fields are encoded as `meta:<key>:<value>` tags on storage. */
  metadata?: DocumentMetadata;
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

/** A top-level ingested document as returned by pluresLM_list_sources(). */
export interface DocumentSource {
  /** Stable document identifier (also used as the `source` tag in PluresDB). */
  id: string;
  title: string;
  summary: string;
  keyTopics: string[];
  metadata: DocumentMetadata;
  /** Number of semantic chunks stored for this document. */
  chunkCount: number;
  createdAt: number;
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
    case "document":
    case "note":
    case "reference":
    case "insight":
      return "high";
    case "document-chunk":
      return "normal";
    case "conversation":
      return "low";
    default:
      return "normal";
  }
}
