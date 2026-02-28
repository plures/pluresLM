import { describe, expect, it, beforeEach } from "vitest";
import { createSyncDBAdapter, type SyncDBAdapter } from "../../src/sync-db-adapter.js";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";

describe("createSyncDBAdapter", () => {
  let db: PluresDBBackend;
  let adapter: SyncDBAdapter;

  beforeEach(() => {
    ({ db } = makeTestDB());
    adapter = createSyncDBAdapter(db);
  });

  it("getAllMemoryIds returns empty array when no memories stored", async () => {
    const ids = await adapter.getAllMemoryIds();
    expect(ids).toEqual([]);
  });

  it("getAllMemoryIds returns id and created_at for each stored memory", async () => {
    await db.store("hello world", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], { source: "test" });
    await db.store("another memory", [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2], { source: "test" });

    const ids = await adapter.getAllMemoryIds();
    expect(ids).toHaveLength(2);
    for (const item of ids) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.created_at).toBe("number");
      expect(item.created_at).toBeGreaterThan(0);
    }
  });

  it("getMemoriesByIds returns the requested memories", async () => {
    const { entry: e1 } = await db.store("memory one", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], { source: "test" });
    const { entry: e2 } = await db.store("memory two", [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2], { source: "test" });

    const results = await adapter.getMemoriesByIds([e1.id, e2.id]);
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("memory one");
    expect(contents).toContain("memory two");
  });

  it("getMemoriesByIds returns empty array for unknown ids", async () => {
    const results = await adapter.getMemoriesByIds(["nonexistent-id"]);
    expect(results).toEqual([]);
  });

  it("getMemoriesByIds returns empty array for empty input", async () => {
    const results = await adapter.getMemoriesByIds([]);
    expect(results).toEqual([]);
  });

  it("getMemoriesSince returns only memories newer than the given timestamp", async () => {
    const cutoff = 1_000_000;
    await adapter.storeRaw({
      id: "old-mem",
      content: "old memory",
      created_at: cutoff - 1000,
      source: "test",
      tags: [],
      category: "other",
    });
    await adapter.storeRaw({
      id: "new-mem",
      content: "new memory",
      created_at: cutoff + 1000,
      source: "test",
      tags: [],
      category: "other",
    });

    const results = await adapter.getMemoriesSince(cutoff);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("new memory");
  });

  it("getMemoriesSince returns empty array when no memories are newer than timestamp", async () => {
    await db.store("old memory", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], { source: "test" });
    const results = await adapter.getMemoriesSince(Date.now() + 10000);
    expect(results).toEqual([]);
  });

  it("getLastSyncTime returns 0 when no sync recorded for peerId", async () => {
    const ts = await adapter.getLastSyncTime("peer-abc");
    expect(ts).toBe(0);
  });

  it("setLastSyncTime and getLastSyncTime round-trip correctly", async () => {
    const now = Date.now();
    await adapter.setLastSyncTime("peer-xyz", now);
    const result = await adapter.getLastSyncTime("peer-xyz");
    expect(result).toBe(now);
  });

  it("setLastSyncTime tracks different peers independently", async () => {
    const ts1 = Date.now();
    const ts2 = ts1 + 5000;
    await adapter.setLastSyncTime("peer-A", ts1);
    await adapter.setLastSyncTime("peer-B", ts2);

    expect(await adapter.getLastSyncTime("peer-A")).toBe(ts1);
    expect(await adapter.getLastSyncTime("peer-B")).toBe(ts2);
  });

  it("storeRaw stores a new entry and returns true", async () => {
    const changed = await adapter.storeRaw({
      id: "sync-entry-1",
      content: "synced memory content",
      created_at: Date.now(),
      source: "remote-peer",
      tags: ["synced"],
      category: "explicit",
    });
    expect(changed).toBe(true);

    const results = await adapter.getMemoriesByIds(["sync-entry-1"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("synced memory content");
  });

  it("storeRaw updates an existing entry when called with same id", async () => {
    const id = "sync-entry-2";
    const created_at = Date.now();
    await adapter.storeRaw({ id, content: "original", created_at, source: "peer", tags: [], category: "other" });
    await adapter.storeRaw({ id, content: "updated", created_at, source: "peer", tags: [], category: "other" });

    const results = await adapter.getMemoriesByIds([id]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("updated");
  });

  it("delete removes a stored memory", async () => {
    const { entry } = await db.store("to be deleted", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], { source: "test" });
    const deleted = await adapter.delete(entry.id);
    expect(deleted).toBe(true);

    const results = await adapter.getMemoriesByIds([entry.id]);
    expect(results).toHaveLength(0);
  });

  it("setEmbedding attaches an embedding to a stored memory", async () => {
    await adapter.storeRaw({
      id: "embed-me",
      content: "memory needing embedding",
      created_at: Date.now(),
      source: "peer",
      tags: [],
      category: "other",
    });

    const embedding = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9];
    await adapter.setEmbedding("embed-me", embedding);

    // After setting embedding, vector search should find it
    const matches = await adapter.vectorSearch(embedding, 1, 0.9);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].entry.id).toBe("embed-me");
  });

  it("vectorSearch returns memories above the threshold", async () => {
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    await db.store("memory to find", vec, { source: "test" });

    const results = await adapter.vectorSearch(vec, 5, 0.9);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThanOrEqual(0.9);
  });

  it("vectorSearch returns empty when no memories exceed threshold", async () => {
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    await db.store("unrelated memory", [0, 1, 0, 0, 0, 0, 0, 0], { source: "test" });

    const results = await adapter.vectorSearch(vec, 5, 0.99);
    expect(results).toEqual([]);
  });
});
