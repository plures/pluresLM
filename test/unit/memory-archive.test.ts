/**
 * Tests for the tiered memory storage (archive) system.
 *
 * Covers:
 *   - evaluateTier() policy engine
 *   - MemoryArchive.classifyMemories()
 *   - Archive / restore round-trip (no silent corruption)
 *   - Bundle-level and per-entry checksum verification
 *   - Selective detach / attach by module ID
 *   - Predictable recall behaviour when modules are detached
 *
 * Uses the in-memory PluresDBBackend stub — no native binary required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import {
  evaluateTier,
  checksumEntry,
  MemoryArchive,
  DEFAULT_ARCHIVE_POLICY,
  type ArchiveBundle,
} from "../../src/memory-archive.js";
import {
  pluresLM_classify_memories,
  pluresLM_export_bundle,
  pluresLM_restore_bundle,
  pluresLM_detach_module,
  pluresLM_attach_module,
} from "../../src/index.js";
import { _setIngestState, _resetArchive } from "../../src/test-helpers.js";
import type { MemoryEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    content: "test content",
    embedding: [],
    created_at: Date.now(),
    source: "conversation",
    tags: [],
    category: "conversation",
    importance_score: 0.5,
    access_count: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

let db: PluresDBBackend;
let cleanup: () => void;

beforeEach(() => {
  ({ db, cleanup } = makeTestDB());
  _setIngestState(db, null);
});

afterEach(() => {
  _setIngestState(null, null);
  _resetArchive();
  cleanup();
});

// ============================================================================
// evaluateTier
// ============================================================================

describe("evaluateTier", () => {
  it("returns hot for a fresh entry", () => {
    const entry = makeEntry({ importance_score: 0.5, access_count: 2 });
    expect(evaluateTier(entry)).toBe("hot");
  });

  it("returns hot for entries with sensitivity tags", () => {
    const entry = makeEntry({
      tags: ["critical"],
      importance_score: 0.1,
      created_at: Date.now() - 200 * DAY_MS,
    });
    expect(evaluateTier(entry)).toBe("hot");
  });

  it("returns hot for high importance_score entries regardless of age", () => {
    const entry = makeEntry({
      importance_score: 0.9,
      created_at: Date.now() - 200 * DAY_MS,
    });
    expect(evaluateTier(entry)).toBe("hot");
  });

  it("returns warm after warmAfterDays", () => {
    const entry = makeEntry({
      importance_score: 0.1,
      access_count: 5, // high access — should be warm not cold
      created_at: Date.now() - 45 * DAY_MS,
    });
    expect(evaluateTier(entry)).toBe("warm");
  });

  it("returns cold after coldAfterDays", () => {
    const entry = makeEntry({
      importance_score: 0.1,
      access_count: 5,
      created_at: Date.now() - 100 * DAY_MS,
    });
    expect(evaluateTier(entry)).toBe("cold");
  });

  it("returns cold when warm-age AND access_count below threshold", () => {
    const entry = makeEntry({
      importance_score: 0.1,
      access_count: 0, // below coldBelowAccessCount (default 1)
      created_at: Date.now() - 40 * DAY_MS,
    });
    expect(evaluateTier(entry)).toBe("cold");
  });

  it("respects last_accessed_at over created_at for age calculation", () => {
    const entry = makeEntry({
      importance_score: 0.1,
      access_count: 5,
      created_at: Date.now() - 100 * DAY_MS,
      last_accessed_at: Date.now() - 10 * DAY_MS, // recently accessed
    });
    // Age from last_accessed_at is only 10 days → hot
    expect(evaluateTier(entry)).toBe("hot");
  });

  it("respects custom policy thresholds", () => {
    const policy = { ...DEFAULT_ARCHIVE_POLICY, warmAfterDays: 7, coldAfterDays: 14 };
    const entry = makeEntry({
      importance_score: 0.1,
      access_count: 5,
      created_at: Date.now() - 10 * DAY_MS,
    });
    expect(evaluateTier(entry, policy)).toBe("warm");
  });
});

// ============================================================================
// checksumEntry
// ============================================================================

describe("checksumEntry", () => {
  it("produces a deterministic SHA-256 hex string", () => {
    const entry = makeEntry({ id: "fixed-id", content: "hello" });
    const { embedding: _emb, ...data } = entry;
    const cs1 = checksumEntry(data);
    const cs2 = checksumEntry(data);
    expect(cs1).toBe(cs2);
    expect(cs1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different checksums for different content", () => {
    const e1 = makeEntry({ id: "id-1", content: "foo" });
    const e2 = makeEntry({ id: "id-1", content: "bar" });
    const { embedding: _a, ...d1 } = e1;
    const { embedding: _b, ...d2 } = e2;
    expect(checksumEntry(d1)).not.toBe(checksumEntry(d2));
  });
});

// ============================================================================
// MemoryArchive — classifyMemories
// ============================================================================

describe("MemoryArchive.classifyMemories", () => {
  it("groups memories into hot / warm / cold", () => {
    const now = Date.now();
    const archive = new MemoryArchive();
    const entries: MemoryEntry[] = [
      makeEntry({ importance_score: 0.1, access_count: 5, created_at: now - 5 * DAY_MS }),   // hot
      makeEntry({ importance_score: 0.1, access_count: 5, created_at: now - 45 * DAY_MS }),  // warm
      makeEntry({ importance_score: 0.1, access_count: 5, created_at: now - 100 * DAY_MS }), // cold
    ];

    const result = archive.classifyMemories(entries);
    expect(result.hot).toHaveLength(1);
    expect(result.warm).toHaveLength(1);
    expect(result.cold).toHaveLength(1);
  });
});

// ============================================================================
// MemoryArchive — exportBundle / restoreBundle round-trip
// ============================================================================

describe("MemoryArchive — archive/restore round-trip", () => {
  it("restores all entries unchanged", () => {
    const archive = new MemoryArchive();
    const entries = [
      makeEntry({ id: "id-1", content: "alpha" }),
      makeEntry({ id: "id-2", content: "beta" }),
    ];

    const bundle = archive.exportBundle(entries, "my-module");
    const { entries: restored, result } = archive.restoreBundle(bundle);

    expect(result.restored).toBe(2);
    expect(result.corrupted).toHaveLength(0);
    expect(restored).toHaveLength(2);
    expect(restored.map((e) => e.id).sort()).toEqual(["id-1", "id-2"]);
    expect(restored.find((e) => e.id === "id-1")!.content).toBe("alpha");
  });

  it("does not store an embedding key in the bundle (embeddings are stripped by caller)", () => {
    const archive = new MemoryArchive();
    // Callers use getMemoriesByIds() which returns Omit<MemoryEntry, "embedding">.
    // Simulate that by destructuring the entry before passing it.
    const entry = makeEntry({ embedding: [1, 2, 3] });
    const { embedding: _emb, ...entryWithoutEmbedding } = entry;
    const bundle = archive.exportBundle([entryWithoutEmbedding]);
    // BundleEntry.data must not have an embedding key
    expect((bundle.entries[0].data as Record<string, unknown>).embedding).toBeUndefined();
    // Restored entry gets an empty embedding added back
    const { entries: restored } = archive.restoreBundle(bundle);
    expect(restored[0].embedding).toEqual([]);
  });

  it("populates the manifest correctly", () => {
    const archive = new MemoryArchive();
    const entries = [makeEntry()];
    const bundle = archive.exportBundle(entries, "task-42");
    expect(bundle.manifest.entryCount).toBe(1);
    expect(bundle.manifest.moduleId).toBe("task-42");
    expect(bundle.manifest.bundleChecksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// MemoryArchive — corruption detection
// ============================================================================

describe("MemoryArchive — no silent corruption on restore", () => {
  it("detects tampered per-entry data", () => {
    const archive = new MemoryArchive();
    const entry = makeEntry({ id: "tamper-me", content: "original" });
    const bundle = archive.exportBundle([entry]);

    // Tamper with the entry data after export
    const tampered: ArchiveBundle = {
      ...bundle,
      entries: bundle.entries.map((e) => ({
        ...e,
        data: { ...e.data, content: "TAMPERED" },
        // checksum still refers to the original — mismatch
      })),
    };

    const { entries: restored, result } = archive.restoreBundle(tampered);
    expect(result.corrupted).toContain("tamper-me");
    expect(restored).toHaveLength(0);
  });

  it("rejects the whole bundle when the bundle checksum is wrong", () => {
    const archive = new MemoryArchive();
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })];
    const bundle = archive.exportBundle(entries);

    // Tamper with the manifest checksum
    const tampered: ArchiveBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, bundleChecksum: "000000" + "0".repeat(58) },
    };

    const { entries: restored, result } = archive.restoreBundle(tampered);
    expect(result.corrupted).toHaveLength(2);
    expect(restored).toHaveLength(0);
  });
});

// ============================================================================
// MemoryArchive — selective attach / detach
// ============================================================================

describe("MemoryArchive — selective attach/detach", () => {
  it("attach() returns null for an unknown module", () => {
    const archive = new MemoryArchive();
    expect(archive.attach("does-not-exist")).toBeNull();
  });

  it("detach() then attach() round-trips the entries", () => {
    const archive = new MemoryArchive();
    const entries = [makeEntry({ id: "d1" }), makeEntry({ id: "d2" })];

    archive.detach(entries, "project-x");
    expect(archive.listModules()).toContain("project-x");

    const attachment = archive.attach("project-x");
    expect(attachment).not.toBeNull();
    expect(attachment!.result.restored).toBe(2);
    expect(attachment!.entries.map((e) => e.id).sort()).toEqual(["d1", "d2"]);
  });

  it("listModules() returns all registered module IDs", () => {
    const archive = new MemoryArchive();
    archive.detach([makeEntry()], "mod-a");
    archive.detach([makeEntry()], "mod-b");
    expect(archive.listModules().sort()).toEqual(["mod-a", "mod-b"]);
  });

  it("dropModule() removes the module", () => {
    const archive = new MemoryArchive();
    archive.detach([makeEntry()], "ephemeral");
    expect(archive.dropModule("ephemeral")).toBe(true);
    expect(archive.attach("ephemeral")).toBeNull();
  });

  it("registerBundle() makes an external bundle attachable", () => {
    const archive = new MemoryArchive();
    const entry = makeEntry({ id: "ext-1" });
    const bundle = archive.exportBundle([entry], "external-module");

    const fresh = new MemoryArchive();
    fresh.registerBundle(bundle, "external-module");
    const result = fresh.attach("external-module");
    expect(result).not.toBeNull();
    expect(result!.entries[0].id).toBe("ext-1");
  });
});

// ============================================================================
// Plugin API — pluresLM_classify_memories
// ============================================================================

describe("pluresLM_classify_memories", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_classify_memories()).rejects.toThrow("pluresLM is not initialised");
  });

  it("classifies stored memories correctly", async () => {
    await db.storeContent("fresh memory", {
      source: "conversation",
      category: "conversation",
    });

    const result = await pluresLM_classify_memories({
      warmAfterDays: 30,
      coldAfterDays: 90,
      hotMinImportanceScore: 0.8,
    });

    // The freshly stored memory should be hot (importance_score default 1.0)
    const hotIds = result.hot.map((e) => e.content);
    expect(hotIds).toContain("fresh memory");
  });
});

// ============================================================================
// Plugin API — pluresLM_export_bundle / pluresLM_restore_bundle
// ============================================================================

describe("pluresLM_export_bundle / pluresLM_restore_bundle", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_export_bundle([], "m")).rejects.toThrow("pluresLM is not initialised");
  });

  it("export + restore round-trip preserves content", async () => {
    const { entry } = await db.storeContent("round-trip content", { source: "conversation" });

    const bundle = await pluresLM_export_bundle([entry.id], "rt-module");
    expect(bundle.manifest.entryCount).toBe(1);
    expect(bundle.entries[0].data.content).toBe("round-trip content");

    // Delete and restore
    await db.delete(entry.id);
    const result = await pluresLM_restore_bundle(bundle);
    expect(result.restored).toBe(1);
    expect(result.corrupted).toHaveLength(0);

    const memories = await db.listMemories();
    expect(memories.some((m) => m.content === "round-trip content")).toBe(true);
  });

  it("restore detects bundle-level corruption", async () => {
    const { entry } = await db.storeContent("safe content", { source: "conversation" });
    const bundle = await pluresLM_export_bundle([entry.id]);

    const tampered: ArchiveBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, bundleChecksum: "bad" + "0".repeat(61) },
    };

    const result = await pluresLM_restore_bundle(tampered);
    expect(result.corrupted).toHaveLength(1);
    expect(result.restored).toBe(0);
  });
});

// ============================================================================
// Plugin API — pluresLM_detach_module / pluresLM_attach_module
// ============================================================================

describe("pluresLM_detach_module / pluresLM_attach_module", () => {
  it("throws when plugin is not initialised (detach)", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_detach_module([], "m")).rejects.toThrow("pluresLM is not initialised");
  });

  it("throws when plugin is not initialised (attach)", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_attach_module("m")).rejects.toThrow("pluresLM is not initialised");
  });

  it("detach removes memories from the active store", async () => {
    const { entry } = await db.storeContent("to be detached", { source: "conversation" });

    await pluresLM_detach_module([entry.id], "detach-mod");

    const memories = await db.listMemories();
    expect(memories.some((m) => m.id === entry.id)).toBe(false);
  });

  it("detached memories are absent from recall", async () => {
    const { entry } = await db.storeContent("project alpha docs", { source: "conversation" });

    await pluresLM_detach_module([entry.id], "alpha-docs");

    const all = await db.listMemories();
    const ids = all.map((m) => m.id);
    expect(ids).not.toContain(entry.id);
  });

  it("attach restores detached memories into the active store", async () => {
    const { entry } = await db.storeContent("detach and restore me", { source: "conversation" });

    const bundle = await pluresLM_detach_module([entry.id], "restore-mod");
    expect(bundle.manifest.entryCount).toBe(1);

    const result = await pluresLM_attach_module("restore-mod");
    expect(result).not.toBeNull();
    expect(result!.restored).toBe(1);
    expect(result!.corrupted).toHaveLength(0);

    const memories = await db.listMemories();
    expect(memories.some((m) => m.content === "detach and restore me")).toBe(true);
  });

  it("attach with external bundle registers and restores", async () => {
    const { entry } = await db.storeContent("external bundle restore", { source: "conversation" });
    const bundle = await pluresLM_export_bundle([entry.id], "ext-mod");

    // Remove from DB to simulate cold storage
    await db.delete(entry.id);

    const result = await pluresLM_attach_module("ext-mod", bundle);
    expect(result).not.toBeNull();
    expect(result!.restored).toBe(1);

    const memories = await db.listMemories();
    expect(memories.some((m) => m.content === "external bundle restore")).toBe(true);
  });

  it("returns null when attach is called for an unknown module", async () => {
    const result = await pluresLM_attach_module("no-such-module");
    expect(result).toBeNull();
  });

  it("attach with a fully corrupted bundle keeps module in registry for retry", async () => {
    const { entry } = await db.storeContent("tamper test content", { source: "conversation" });
    const bundle = await pluresLM_export_bundle([entry.id], "tamper-attach-mod");

    // Tamper the bundle-level checksum so all entries are flagged corrupted.
    const tampered: ArchiveBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, bundleChecksum: "bad" + "0".repeat(61) },
    };

    const result = await pluresLM_attach_module("tamper-attach-mod", tampered);
    expect(result).not.toBeNull();
    expect(result!.restored).toBe(0);
    expect(result!.corrupted).toHaveLength(1);

    // The module must survive in the registry so the caller can retry.
    // A second call (without re-supplying a bundle) must return non-null.
    const retryResult = await pluresLM_attach_module("tamper-attach-mod");
    expect(retryResult).not.toBeNull();
  });
});
