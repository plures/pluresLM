/**
 * Tests for the Memory Module Packs feature.
 *
 * Covers:
 *   - signPack / verifyPackSignature (timing-safe HMAC-SHA256)
 *   - checkPackCompatibility
 *   - PackRegistry (register, unregister, list, get, getBundle)
 *   - pluresLM_export_pack (creates a MemoryPack from live store)
 *   - pluresLM_verify_pack (wraps verifyPackSignature)
 *   - pluresLM_import_pack (compatibility, signature, restore, registry)
 *   - pluresLM_uninstall_pack (rollback removes entries)
 *   - pluresLM_list_packs (provenance visible)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import {
  signPack,
  verifyPackSignature,
  checkPackCompatibility,
  PackRegistry,
  type MemoryPack,
  type PackProvenance,
  type PackEmbeddingMeta,
} from "../../src/memory-pack.js";
import {
  pluresLM_export_pack,
  pluresLM_verify_pack,
  pluresLM_import_pack,
  pluresLM_uninstall_pack,
  pluresLM_list_packs,
} from "../../src/index.js";
import { _setIngestState, _resetArchive, _resetPackRegistry } from "../../src/test-helpers.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SIGNING_KEY = "test-secret-key";

const PROVENANCE: Omit<PackProvenance, "createdAt"> = {
  name: "TypeScript Patterns",
  author: "Plures Team",
  description: "Curated TypeScript patterns encyclopedia",
  license: "CC-BY-4.0",
  version: "1.0.0",
  sourceUrl: "https://example.com/ts-patterns",
};

const EMBEDDING_META: PackEmbeddingMeta = {
  modelName: "all-minilm-l6-v2",
  modelVersion: "v2",
  dimensions: 384,
};

// ---------------------------------------------------------------------------
// Test state
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
  _resetPackRegistry();
  cleanup();
});

// ============================================================================
// signPack / verifyPackSignature
// ============================================================================

describe("signPack / verifyPackSignature", () => {
  function makeMockPack(): MemoryPack {
    return {
      packVersion: "1",
      bundle: {
        manifest: {
          bundleId: "bundle-1",
          createdAt: 1000000,
          entryCount: 0,
          bundleChecksum: "abc",
        },
        entries: [],
      },
      provenance: { ...PROVENANCE, createdAt: "2026-01-01T00:00:00.000Z" },
      embeddingMeta: EMBEDDING_META,
    };
  }

  it("signPack adds a 64-char hex signature", () => {
    const pack = makeMockPack();
    const signed = signPack(pack, SIGNING_KEY);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyPackSignature returns true for correct key", () => {
    const signed = signPack(makeMockPack(), SIGNING_KEY);
    expect(verifyPackSignature(signed, SIGNING_KEY)).toBe(true);
  });

  it("verifyPackSignature returns false for wrong key", () => {
    const signed = signPack(makeMockPack(), SIGNING_KEY);
    expect(verifyPackSignature(signed, "wrong-key")).toBe(false);
  });

  it("verifyPackSignature returns false when signature is absent", () => {
    const unsigned = makeMockPack();
    expect(verifyPackSignature(unsigned, SIGNING_KEY)).toBe(false);
  });

  it("verifyPackSignature returns false after bundle content is tampered", () => {
    const signed = signPack(makeMockPack(), SIGNING_KEY);
    const tampered: MemoryPack = {
      ...signed,
      bundle: {
        ...signed.bundle,
        manifest: { ...signed.bundle.manifest, bundleChecksum: "tampered" },
      },
    };
    expect(verifyPackSignature(tampered, SIGNING_KEY)).toBe(false);
  });

  it("verifyPackSignature returns false after provenance is tampered", () => {
    const signed = signPack(makeMockPack(), SIGNING_KEY);
    const tampered: MemoryPack = {
      ...signed,
      provenance: { ...signed.provenance, author: "Attacker" },
    };
    expect(verifyPackSignature(tampered, SIGNING_KEY)).toBe(false);
  });

  it("signature is deterministic (same payload → same signature)", () => {
    const pack = makeMockPack();
    expect(signPack(pack, SIGNING_KEY).signature).toBe(signPack(pack, SIGNING_KEY).signature);
  });
});

// ============================================================================
// checkPackCompatibility
// ============================================================================

describe("checkPackCompatibility", () => {
  function mockPack(modelName: string): MemoryPack {
    return {
      packVersion: "1",
      bundle: { manifest: { bundleId: "x", createdAt: 0, entryCount: 0, bundleChecksum: "x" }, entries: [] },
      provenance: { ...PROVENANCE, createdAt: "2026-01-01T00:00:00.000Z" },
      embeddingMeta: { ...EMBEDDING_META, modelName },
    };
  }

  it("returns compatible=true and no warnings when models match", () => {
    const result = checkPackCompatibility(mockPack("all-minilm-l6-v2"), "all-minilm-l6-v2");
    expect(result.compatible).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns compatible=false and a warning when models differ", () => {
    const result = checkPackCompatibility(mockPack("model-a"), "model-b");
    expect(result.compatible).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("model-a");
    expect(result.warnings[0]).toContain("model-b");
  });

  it("skips model check when currentModelName is not provided", () => {
    const result = checkPackCompatibility(mockPack("any-model"));
    expect(result.compatible).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

// ============================================================================
// PackRegistry
// ============================================================================

describe("PackRegistry", () => {
  function mockPack(moduleId?: string): MemoryPack {
    return {
      packVersion: "1",
      bundle: {
        manifest: { bundleId: "b1", createdAt: 0, entryCount: 1, bundleChecksum: "x", moduleId },
        entries: [{ id: "e1", checksum: "cs", data: { id: "e1", content: "hi", created_at: 0, source: "conversation", tags: [], category: "conversation", embedding: [] } }],
      },
      provenance: { ...PROVENANCE, createdAt: "2026-01-01T00:00:00.000Z" },
      embeddingMeta: EMBEDDING_META,
    };
  }

  it("register + list returns the installed pack info", () => {
    const registry = new PackRegistry();
    registry.register("mod-1", mockPack("mod-1"), 3);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].moduleId).toBe("mod-1");
    expect(list[0].provenance.name).toBe("TypeScript Patterns");
    expect(list[0].entryCount).toBe(3);
  });

  it("get returns info for a registered module", () => {
    const registry = new PackRegistry();
    registry.register("mod-2", mockPack("mod-2"), 5);
    expect(registry.get("mod-2")?.moduleId).toBe("mod-2");
  });

  it("get returns undefined for unknown module", () => {
    expect(new PackRegistry().get("nope")).toBeUndefined();
  });

  it("unregister removes and returns the bundle", () => {
    const registry = new PackRegistry();
    const pack = mockPack("mod-3");
    registry.register("mod-3", pack, 1);
    const bundle = registry.unregister("mod-3");
    expect(bundle).toBeDefined();
    expect(registry.get("mod-3")).toBeUndefined();
  });

  it("unregister returns undefined for unknown module", () => {
    expect(new PackRegistry().unregister("ghost")).toBeUndefined();
  });

  it("getBundle returns the original bundle", () => {
    const registry = new PackRegistry();
    const pack = mockPack("mod-4");
    registry.register("mod-4", pack, 0);
    expect(registry.getBundle("mod-4")).toBe(pack.bundle);
  });
});

// ============================================================================
// pluresLM_export_pack / pluresLM_verify_pack
// ============================================================================

describe("pluresLM_export_pack / pluresLM_verify_pack", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_export_pack([], PROVENANCE, EMBEDDING_META)).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });

  it("creates a MemoryPack with correct provenance and embeddingMeta", async () => {
    const { entry } = await db.storeContent("pack content", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META);

    expect(pack.packVersion).toBe("1");
    expect(pack.provenance.name).toBe("TypeScript Patterns");
    expect(pack.provenance.author).toBe("Plures Team");
    expect(pack.provenance.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pack.embeddingMeta.modelName).toBe("all-minilm-l6-v2");
    expect(pack.embeddingMeta.dimensions).toBe(384);
  });

  it("bundle contains the expected memory content", async () => {
    const { entry } = await db.storeContent("encyclopedia entry", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META);

    expect(pack.bundle.manifest.entryCount).toBe(1);
    expect(pack.bundle.entries[0].data.content).toBe("encyclopedia entry");
  });

  it("does not add a signature when no signingKey is provided", async () => {
    const { entry } = await db.storeContent("unsigned content", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META);
    expect(pack.signature).toBeUndefined();
  });

  it("signs the pack when signingKey is provided", async () => {
    const { entry } = await db.storeContent("signed content", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      signingKey: SIGNING_KEY,
    });
    expect(pack.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("respects a custom moduleId in the bundle manifest", async () => {
    const { entry } = await db.storeContent("custom module id", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "my-custom-pack",
    });
    expect(pack.bundle.manifest.moduleId).toBe("my-custom-pack");
  });

  it("pluresLM_verify_pack returns true for a correctly signed pack", async () => {
    const { entry } = await db.storeContent("verified content", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      signingKey: SIGNING_KEY,
    });
    expect(pluresLM_verify_pack(pack, SIGNING_KEY)).toBe(true);
  });

  it("pluresLM_verify_pack returns false for wrong key", async () => {
    const { entry } = await db.storeContent("wrong key content", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      signingKey: SIGNING_KEY,
    });
    expect(pluresLM_verify_pack(pack, "wrong-key")).toBe(false);
  });
});

// ============================================================================
// pluresLM_import_pack
// ============================================================================

describe("pluresLM_import_pack", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    const fakePack: MemoryPack = {
      packVersion: "1",
      bundle: {
        manifest: { bundleId: "x", createdAt: 0, entryCount: 0, bundleChecksum: "x" },
        entries: [],
      },
      provenance: { ...PROVENANCE, createdAt: "2026-01-01T00:00:00.000Z" },
      embeddingMeta: EMBEDDING_META,
    };
    await expect(pluresLM_import_pack(fakePack)).rejects.toThrow("pluresLM is not initialised");
  });

  it("imports entries into the store", async () => {
    const { entry } = await db.storeContent("importable memory", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "import-test",
    });

    // Remove from store first (simulating distribution scenario)
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack);
    expect(result.restored).toBe(1);
    expect(result.corrupted).toHaveLength(0);

    const memories = await db.listMemories();
    expect(memories.some((m) => m.content === "importable memory")).toBe(true);
  });

  it("returns provenance in the result", async () => {
    const { entry } = await db.storeContent("provenance check", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "provenance-check",
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack);
    expect(result.provenance.name).toBe("TypeScript Patterns");
    expect(result.provenance.author).toBe("Plures Team");
    expect(result.provenance.license).toBe("CC-BY-4.0");
  });

  it("sets embeddingCompatible=true when models match", async () => {
    const { entry } = await db.storeContent("compat true", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "compat-true",
      signingKey: SIGNING_KEY,
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack, {
      currentModelName: "all-minilm-l6-v2",
      signingKey: SIGNING_KEY,
    });
    expect(result.embeddingCompatible).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("adds a warning (embeddingCompatible=false) when models differ", async () => {
    const { entry } = await db.storeContent("compat warning", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "compat-warn",
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack, { currentModelName: "other-model" });
    expect(result.embeddingCompatible).toBe(false);
    expect(result.warnings.some((w) => w.includes("all-minilm-l6-v2"))).toBe(true);
  });

  it("throws when requireCompatibleModel=true and models differ", async () => {
    const { entry } = await db.storeContent("require compat", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "req-compat",
    });
    await db.delete(entry.id);

    await expect(
      pluresLM_import_pack(pack, {
        currentModelName: "other-model",
        requireCompatibleModel: true,
      }),
    ).rejects.toThrow("all-minilm-l6-v2");
  });

  it("warns about unsigned pack when no signingKey is supplied", async () => {
    const { entry } = await db.storeContent("unsigned pack warn", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "unsigned-warn",
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack);
    expect(result.warnings.some((w) => w.toLowerCase().includes("unsigned"))).toBe(true);
  });

  it("passes verification for a correctly signed pack", async () => {
    const { entry } = await db.storeContent("sig check pass", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "sig-pass",
      signingKey: SIGNING_KEY,
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack, { signingKey: SIGNING_KEY });
    expect(result.restored).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("adds a warning when signature verification fails", async () => {
    const { entry } = await db.storeContent("sig check fail", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "sig-fail",
      signingKey: SIGNING_KEY,
    });
    await db.delete(entry.id);

    const result = await pluresLM_import_pack(pack, { signingKey: "wrong-key" });
    expect(result.warnings.some((w) => w.toLowerCase().includes("signature"))).toBe(true);
  });

  it("throws when requireSignature=true and signature fails verification", async () => {
    const { entry } = await db.storeContent("require sig", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "req-sig",
      signingKey: SIGNING_KEY,
    });
    await db.delete(entry.id);

    await expect(
      pluresLM_import_pack(pack, { signingKey: "bad-key", requireSignature: true }),
    ).rejects.toThrow("tampered");
  });

  it("throws when requireSignature=true and pack is unsigned", async () => {
    const { entry } = await db.storeContent("req sig unsigned", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "req-sig-unsigned",
    });
    await db.delete(entry.id);

    await expect(
      pluresLM_import_pack(pack, { requireSignature: true }),
    ).rejects.toThrow("requireSignature");
  });

  it("throws when requireSignature=true and pack is signed but no signingKey provided", async () => {
    const { entry } = await db.storeContent("req sig no key", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "req-sig-no-key",
      signingKey: SIGNING_KEY,
    });
    await db.delete(entry.id);

    await expect(
      pluresLM_import_pack(pack, { requireSignature: true }),
    ).rejects.toThrow("signingKey");
  });

  it("records the imported pack in the registry (visible via pluresLM_list_packs)", async () => {
    const { entry } = await db.storeContent("registry check", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "registry-pack",
    });
    await db.delete(entry.id);

    await pluresLM_import_pack(pack);

    const packs = pluresLM_list_packs();
    const found = packs.find((p) => p.provenance.name === "TypeScript Patterns");
    expect(found).toBeDefined();
    expect(found!.provenance.license).toBe("CC-BY-4.0");
    expect(found!.embeddingMeta.modelName).toBe("all-minilm-l6-v2");
  });

  it("does not register pack when bundle is fully corrupted (restored=0)", async () => {
    const { entry } = await db.storeContent("corrupted bundle", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "corrupted-pack",
    });

    // Tamper the bundle-level checksum so all entries are flagged corrupted.
    const tampered: MemoryPack = {
      ...pack,
      bundle: {
        ...pack.bundle,
        manifest: { ...pack.bundle.manifest, bundleChecksum: "bad" + "0".repeat(61) },
      },
    };

    const result = await pluresLM_import_pack(tampered);
    expect(result.restored).toBe(0);
    expect(result.warnings.some((w) => w.includes("not registered"))).toBe(true);

    // Should not appear in the installed-pack list
    expect(pluresLM_list_packs().find((p) => p.moduleId === "corrupted-pack")).toBeUndefined();
  });
});

// ============================================================================
// pluresLM_uninstall_pack
// ============================================================================

describe("pluresLM_uninstall_pack", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_uninstall_pack("any")).rejects.toThrow("pluresLM is not initialised");
  });

  it("returns null when the pack is not installed", async () => {
    const result = await pluresLM_uninstall_pack("not-installed");
    expect(result).toBeNull();
  });

  it("removes imported entries from the active store (rollback)", async () => {
    const { entry } = await db.storeContent("to be removed", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "rollback-pack",
    });
    await db.delete(entry.id);
    await pluresLM_import_pack(pack);

    // Verify it's in the store now
    let memories = await db.listMemories();
    expect(memories.some((m) => m.content === "to be removed")).toBe(true);

    // Uninstall
    const uninstallResult = await pluresLM_uninstall_pack("rollback-pack");
    expect(uninstallResult).not.toBeNull();
    expect(uninstallResult!.removed).toBe(1);
    expect(uninstallResult!.notFound).toHaveLength(0);

    // Verify entries are gone
    memories = await db.listMemories();
    expect(memories.some((m) => m.content === "to be removed")).toBe(false);
  });

  it("removes the pack from the registry after uninstall", async () => {
    const { entry } = await db.storeContent("uninstall registry check", {
      source: "conversation",
    });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "unreg-pack",
    });
    await db.delete(entry.id);
    await pluresLM_import_pack(pack);

    expect(pluresLM_list_packs().find((p) => p.moduleId === "unreg-pack")).toBeDefined();

    await pluresLM_uninstall_pack("unreg-pack");

    expect(pluresLM_list_packs().find((p) => p.moduleId === "unreg-pack")).toBeUndefined();
  });

  it("returns null on a second uninstall attempt (idempotent-safe)", async () => {
    const { entry } = await db.storeContent("idempotent uninstall", { source: "conversation" });
    const pack = await pluresLM_export_pack([entry.id], PROVENANCE, EMBEDDING_META, {
      moduleId: "idem-pack",
    });
    await db.delete(entry.id);
    await pluresLM_import_pack(pack);

    await pluresLM_uninstall_pack("idem-pack");
    const second = await pluresLM_uninstall_pack("idem-pack");
    expect(second).toBeNull();
  });
});

// ============================================================================
// pluresLM_list_packs
// ============================================================================

describe("pluresLM_list_packs", () => {
  it("returns empty array when no packs are installed", () => {
    expect(pluresLM_list_packs()).toHaveLength(0);
  });

  it("returns all installed packs with provenance", async () => {
    // Install two packs
    for (const name of ["Pack A", "Pack B"]) {
      const { entry } = await db.storeContent(`content for ${name}`, { source: "conversation" });
      const pack = await pluresLM_export_pack(
        [entry.id],
        { ...PROVENANCE, name },
        EMBEDDING_META,
        { moduleId: `pack-${name.toLowerCase().replace(" ", "-")}` },
      );
      await db.delete(entry.id);
      await pluresLM_import_pack(pack);
    }

    const packs = pluresLM_list_packs();
    expect(packs).toHaveLength(2);
    const names = packs.map((p) => p.provenance.name).sort();
    expect(names).toEqual(["Pack A", "Pack B"]);
  });
});
