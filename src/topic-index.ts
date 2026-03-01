/**
 * TopicIndex — hierarchical topic directory for pluresLM org memory.
 *
 * ## Purpose
 *
 * TopicIndex is a pluresLM **application-layer** concept.  It groups memory
 * entries under named, hierarchical topics so that pluresLM can organise and
 * navigate org-level knowledge by subject matter.
 *
 * ## Product boundary
 *
 * TopicIndex depends only on `PluresStore` (the generic engine interface) —
 * not on `PluresDBBackend` or any pluresLM memory types such as `MemoryEntry`.
 * This means the topic layer can be used independently of the memory layer and
 * can be tested with a lightweight in-memory `PluresStore` stub.
 *
 * Persistence uses the `topic:` node-ID namespace inside the shared store.
 */

import { randomUUID } from "node:crypto";
import type { PluresStore } from "./plures-store.js";

/** A single named topic entry in the topic index. */
export interface TopicEntry {
  /** Stable UUID for the topic. */
  id: string;
  /** Human-readable label derived from representative entry content. */
  label: string;
  /** Mean embedding vector across all indexed entries for this topic. */
  embedding: number[];
  /** IDs of memory (or other) entries indexed under this topic. */
  entryIds: string[];
  /** Optional parent topic ID for hierarchical taxonomy. */
  parentTopicId?: string;
  /** Cosine similarity threshold for auto-assignment to this topic. */
  similarityThreshold: number;
  createdAt: number;
  updatedAt: number;
}

/** Construction options for `TopicIndex`. */
export interface TopicIndexOpts {
  /**
   * Similarity threshold for assigning an entry to an existing topic.
   * Default: 0.8.
   */
  defaultSimilarityThreshold?: number;
  /**
   * Similarity threshold at which an existing topic becomes the parent of a
   * newly-created topic rather than a direct assignment target.
   * Default: 0.65.
   */
  parentLinkThreshold?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TOPIC_PREFIX = "topic:";

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function generateLabel(content: string): string {
  const words = content
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);
  return words.length > 0 ? words.join(" ") : content.slice(0, 50).trim();
}

// ---------------------------------------------------------------------------
// TopicIndex
// ---------------------------------------------------------------------------

/**
 * Hierarchical topic directory for pluresLM org memory.
 *
 * All state is persisted in the provided `PluresStore` under the `topic:`
 * namespace prefix, separate from memory nodes (`memory:`) and other
 * application-layer namespaces.
 *
 * @example
 * ```ts
 * const index = new TopicIndex(db.getStore());
 * const topicId = index.indexEntry(memId, embedding, contentText);
 * const topics = index.listTopics();
 * ```
 */
export class TopicIndex {
  private readonly defaultThreshold: number;
  private readonly parentLinkThreshold: number;

  constructor(
    private readonly store: PluresStore,
    opts: TopicIndexOpts = {},
  ) {
    this.defaultThreshold = opts.defaultSimilarityThreshold ?? 0.8;
    this.parentLinkThreshold = opts.parentLinkThreshold ?? 0.65;
  }

  // ── Read operations ──────────────────────────────────────────────────────────

  /** Return all topics in the index, sorted by most-recently updated. */
  listTopics(): TopicEntry[] {
    return this.store
      .list()
      .filter((n) => n.id.startsWith(TOPIC_PREFIX))
      .map((n) => this.nodeToEntry(n.id.slice(TOPIC_PREFIX.length), n.data))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Return a single topic by ID, or `null` when not found. */
  getTopic(id: string): TopicEntry | null {
    const data = this.store.get(TOPIC_PREFIX + id);
    if (!data) return null;
    return this.nodeToEntry(id, data);
  }

  /**
   * Return all direct children of a given topic (topics whose
   * `parentTopicId` equals `topicId`).
   */
  getChildren(topicId: string): TopicEntry[] {
    return this.listTopics().filter((t) => t.parentTopicId === topicId);
  }

  // ── Write operations ─────────────────────────────────────────────────────────

  /**
   * Index an entry under the most semantically similar topic.
   *
   * When no existing topic exceeds `defaultSimilarityThreshold` a new topic
   * is created.  If a topic exceeds `parentLinkThreshold` (but not the full
   * assignment threshold) it becomes the parent of the newly-created topic,
   * building the hierarchy automatically.
   *
   * @param entryId   Stable ID of the entry being indexed (e.g. a memory ID).
   * @param embedding Embedding vector for the entry.
   * @param content   Representative text used to label a newly-created topic.
   * @returns The ID of the topic the entry was assigned to.
   */
  indexEntry(entryId: string, embedding: number[], content: string): string {
    const topics = this.listTopics();
    let bestId: string | null = null;
    let bestSim = -1;
    let potentialParentId: string | null = null;
    let potentialParentSim = -1;

    for (const topic of topics) {
      if (topic.embedding.length === 0) continue;
      const sim = cosineSimilarity(embedding, topic.embedding);
      if (sim >= topic.similarityThreshold && sim > bestSim) {
        bestSim = sim;
        bestId = topic.id;
      } else if (sim >= this.parentLinkThreshold && sim > potentialParentSim) {
        potentialParentSim = sim;
        potentialParentId = topic.id;
      }
    }

    if (bestId) {
      this.addEntryToTopic(bestId, entryId, embedding);
      return bestId;
    }

    // Create a new topic
    const newId = randomUUID();
    const now = Date.now();
    const topic: TopicEntry = {
      id: newId,
      label: generateLabel(content),
      embedding,
      entryIds: [entryId],
      parentTopicId: potentialParentId ?? undefined,
      similarityThreshold: this.defaultThreshold,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(TOPIC_PREFIX + newId, this.entryToNode(topic));
    return newId;
  }

  /**
   * Remove an entry from all topics it belongs to.
   * Topics that become empty after removal are deleted from the store.
   */
  removeEntry(entryId: string): void {
    for (const topic of this.listTopics()) {
      if (!topic.entryIds.includes(entryId)) continue;
      const remaining = topic.entryIds.filter((id) => id !== entryId);
      if (remaining.length === 0) {
        this.store.delete(TOPIC_PREFIX + topic.id);
      } else {
        this.store.put(TOPIC_PREFIX + topic.id, this.entryToNode({
          ...topic,
          entryIds: remaining,
          updatedAt: Date.now(),
        }));
      }
    }
  }

  /**
   * Delete a topic by ID.
   * Child topics that referenced the deleted topic as their parent are
   * re-parented to `undefined` (become root topics).
   */
  deleteTopic(id: string): void {
    this.store.delete(TOPIC_PREFIX + id);
    for (const topic of this.listTopics()) {
      if (topic.parentTopicId === id) {
        this.store.put(TOPIC_PREFIX + topic.id, this.entryToNode({
          ...topic,
          parentTopicId: undefined,
          updatedAt: Date.now(),
        }));
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private addEntryToTopic(topicId: string, entryId: string, newEmbedding: number[]): void {
    const topic = this.getTopic(topicId);
    if (!topic) return;
    if (topic.entryIds.includes(entryId)) return;

    const entryIds = [...topic.entryIds, entryId];
    const count = entryIds.length;
    // Incrementally update the centroid embedding.
    // Both vectors are expected to share the same dimensionality (they come
    // from the same embedding model), but we guard against length mismatches
    // by padding the shorter vector with zeros rather than silently skewing
    // the centroid.
    const dim = Math.max(topic.embedding.length, newEmbedding.length);
    const updatedEmbedding = Array.from({ length: dim }, (_, i) => {
      const prev = topic.embedding[i] ?? 0;
      const next = newEmbedding[i] ?? 0;
      return (prev * (count - 1) + next) / count;
    });
    this.store.put(TOPIC_PREFIX + topicId, this.entryToNode({
      ...topic,
      embedding: updatedEmbedding,
      entryIds,
      updatedAt: Date.now(),
    }));
  }

  private nodeToEntry(id: string, data: Record<string, unknown>): TopicEntry {
    return {
      id,
      label: (data.label as string) ?? "",
      embedding: Array.isArray(data.embedding) ? (data.embedding as number[]) : [],
      entryIds: Array.isArray(data.entryIds) ? (data.entryIds as string[]) : [],
      parentTopicId: (data.parentTopicId as string | undefined) ?? undefined,
      similarityThreshold: typeof data.similarityThreshold === "number"
        ? data.similarityThreshold
        : this.defaultThreshold,
      createdAt: (data.createdAt as number) ?? 0,
      updatedAt: (data.updatedAt as number) ?? 0,
    };
  }

  private entryToNode(entry: TopicEntry): Record<string, unknown> {
    return {
      id: entry.id,
      label: entry.label,
      embedding: entry.embedding,
      entryIds: entry.entryIds,
      parentTopicId: entry.parentTopicId ?? null,
      similarityThreshold: entry.similarityThreshold,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }
}
