/**
 * Tests for the topic directory/index model (src/topic-index.ts).
 *
 * All tests use a lightweight in-memory PluresStore stub — no native binary
 * or PluresDBBackend required.  This demonstrates that TopicIndex depends
 * only on the generic `PluresStore` interface (the PluresDB engine boundary).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { TopicIndex } from "../../src/topic-index.js";
import type { PluresStore, PluresNode } from "../../src/plures-store.js";

// ---------------------------------------------------------------------------
// Minimal in-memory PluresStore stub
// ---------------------------------------------------------------------------

function makeTestStore(): PluresStore {
  const store = new Map<string, Record<string, unknown>>();
  const vectors = new Map<string, number[]>();

  function cosine(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }

  return {
    put(id, data) { store.set(id, data); },
    putWithEmbedding(id, data, emb) { store.set(id, { ...data, vector: emb }); vectors.set(id, emb); },
    get(id) { return store.get(id) ?? null; },
    delete(id) { store.delete(id); vectors.delete(id); },
    list(): PluresNode[] {
      return Array.from(store.entries()).map(([id, data]) => ({ id, data }));
    },
    listByType(prefix): PluresNode[] {
      return Array.from(store.entries())
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, data]) => ({ id, data }));
    },
    vectorSearch(emb, limit = 10, threshold = 0): PluresNode[] {
      const results: PluresNode[] = [];
      for (const [id, data] of store) {
        const vec = vectors.get(id) ?? (Array.isArray(data.vector) ? data.vector as number[] : null);
        if (!vec) continue;
        const score = cosine(emb, vec);
        if (score >= threshold) results.push({ id, data, score });
      }
      return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
    },
    search(): PluresNode[] { return []; },
    execDsl(): never { throw new Error("not available in test stub"); },
    execIr(): never { throw new Error("not available in test stub"); },
  };
}

// ---------------------------------------------------------------------------
// Helpers: deterministic unit vectors
// ---------------------------------------------------------------------------

function unitVec(dim: number, hotIdx: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === hotIdx ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TopicIndex", () => {
  let index: TopicIndex;

  beforeEach(() => {
    index = new TopicIndex(makeTestStore(), {
      defaultSimilarityThreshold: 0.8,
      parentLinkThreshold: 0.5,
    });
  });

  // ── listTopics ─────────────────────────────────────────────────────────────

  describe("listTopics", () => {
    it("returns empty array when no topics exist", () => {
      expect(index.listTopics()).toEqual([]);
    });

    it("returns a topic after indexEntry creates one", () => {
      index.indexEntry("m1", unitVec(8, 0), "rust type safety memory ownership");
      const topics = index.listTopics();
      expect(topics).toHaveLength(1);
      expect(topics[0].label.length).toBeGreaterThan(0);
      // Label is derived from the most significant words in the content
      expect(topics[0].label).toMatch(/rust|type|safety|memory|ownership/);
      expect(topics[0].entryIds).toContain("m1");
    });
  });

  // ── getTopic ──────────────────────────────────────────────────────────────

  describe("getTopic", () => {
    it("returns null for unknown topic id", () => {
      expect(index.getTopic("no-such-id")).toBeNull();
    });

    it("returns the correct topic when it exists", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 1), "typescript generics");
      const topic = index.getTopic(topicId);
      expect(topic).not.toBeNull();
      expect(topic!.id).toBe(topicId);
      expect(topic!.entryIds).toContain("m1");
    });
  });

  // ── indexEntry ────────────────────────────────────────────────────────────

  describe("indexEntry", () => {
    it("creates a new topic for the first entry", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 0), "rust ownership model explained");
      expect(typeof topicId).toBe("string");
      expect(index.listTopics()).toHaveLength(1);
    });

    it("assigns a second similar entry to the same topic", () => {
      const id1 = index.indexEntry("m1", unitVec(8, 0), "rust ownership model prevents data races at compile time");
      const id2 = index.indexEntry("m2", unitVec(8, 0), "rust ownership model guarantees memory safety without gc");
      expect(id1).toBe(id2);
      const topic = index.getTopic(id1);
      expect(topic!.entryIds).toEqual(["m1", "m2"]);
    });

    it("creates a separate topic for a dissimilar entry", () => {
      index.indexEntry("m1", unitVec(8, 0), "rust ownership");
      index.indexEntry("m2", unitVec(8, 7), "python garbage collection");
      expect(index.listTopics()).toHaveLength(2);
    });

    it("does not duplicate an entry already in a topic", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 0), "rust ownership");
      index.indexEntry("m1", unitVec(8, 0), "rust ownership");
      const topic = index.getTopic(topicId);
      expect(topic!.entryIds).toHaveLength(1);
    });

    it("links a new topic to a parent when similarity is in the parent-link range", () => {
      // Same direction → close enough to be parent-linked but not to be merged.
      // Use parallel vectors with a small orthogonal component so similarity
      // falls between parentLinkThreshold (0.5) and defaultSimilarityThreshold (0.8).
      const base = [1, 0, 0, 0, 0, 0, 0, 0];
      const near = [1, 1, 0, 0, 0, 0, 0, 0]; // cos ~ 0.71

      const parentId = index.indexEntry("m1", base, "rust memory management");
      const childId = index.indexEntry("m2", near, "rust stack allocation");

      expect(childId).not.toBe(parentId);
      const child = index.getTopic(childId);
      expect(child!.parentTopicId).toBe(parentId);
    });

    it("stores a meaningful label derived from content", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 3), "typescript strict mode configuration options");
      const topic = index.getTopic(topicId);
      expect(topic!.label.length).toBeGreaterThan(0);
      // Label should contain words from the content (longest words, lowercased)
      expect(topic!.label).toMatch(/typescript|strict|mode|configuration|options/);
    });
  });

  // ── removeEntry ───────────────────────────────────────────────────────────

  describe("removeEntry", () => {
    it("removes an entry from its topic", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 0), "some content here for topic");
      index.removeEntry("m1");
      // Topic should be deleted when empty
      expect(index.getTopic(topicId)).toBeNull();
    });

    it("keeps the topic when other entries remain", () => {
      const topicId = index.indexEntry("m1", unitVec(8, 0), "some content here for topic");
      index.indexEntry("m2", unitVec(8, 0), "some content here for topic");
      index.removeEntry("m1");
      const topic = index.getTopic(topicId);
      expect(topic).not.toBeNull();
      expect(topic!.entryIds).not.toContain("m1");
      expect(topic!.entryIds).toContain("m2");
    });

    it("is a no-op for an entry that does not exist", () => {
      index.indexEntry("m1", unitVec(8, 0), "content here for topic test");
      expect(() => index.removeEntry("ghost-id")).not.toThrow();
      expect(index.listTopics()).toHaveLength(1);
    });
  });

  // ── deleteTopic ───────────────────────────────────────────────────────────

  describe("deleteTopic", () => {
    it("removes the topic from the index", () => {
      const id = index.indexEntry("m1", unitVec(8, 0), "content here for topic test");
      index.deleteTopic(id);
      expect(index.getTopic(id)).toBeNull();
      expect(index.listTopics()).toHaveLength(0);
    });

    it("re-parents orphaned child topics to undefined", () => {
      const base = [1, 0, 0, 0, 0, 0, 0, 0];
      const near = [1, 1, 0, 0, 0, 0, 0, 0];
      const parentId = index.indexEntry("m1", base, "parent content label words");
      const childId = index.indexEntry("m2", near, "child content label words");

      // Confirm parent link was created
      const childBefore = index.getTopic(childId);
      expect(childBefore?.parentTopicId).toBe(parentId);

      index.deleteTopic(parentId);
      const childAfter = index.getTopic(childId);
      expect(childAfter?.parentTopicId).toBeUndefined();
    });
  });

  // ── getChildren ───────────────────────────────────────────────────────────

  describe("getChildren", () => {
    it("returns empty array when no children exist", () => {
      const id = index.indexEntry("m1", unitVec(8, 0), "content with enough words here");
      expect(index.getChildren(id)).toEqual([]);
    });

    it("returns child topics", () => {
      const base = [1, 0, 0, 0, 0, 0, 0, 0];
      const near = [1, 1, 0, 0, 0, 0, 0, 0];
      const parentId = index.indexEntry("m1", base, "parent content label here words");
      const childId = index.indexEntry("m2", near, "child content label here words");
      const children = index.getChildren(parentId);
      expect(children.map((c) => c.id)).toContain(childId);
    });
  });
});
