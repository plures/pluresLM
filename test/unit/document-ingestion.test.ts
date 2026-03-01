/**
 * Tests for the public document ingestion API:
 *   pluresLM_ingest_document, pluresLM_list_sources, pluresLM_delete_source
 *
 * Module-level state is injected via the exported _setIngestState helper so
 * no plugin runtime is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import type { DocumentMetadata } from "../../src/types.js";
import {
  pluresLM_ingest_document,
  pluresLM_list_sources,
  pluresLM_delete_source,
  _setIngestState,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Deterministic embedding stub
// Uses a djb2-style hash of the full text to pick a unique basis vector,
// using 64 dimensions to minimise collision probability across tests.
// ---------------------------------------------------------------------------

function stubEmbed(text: string): Promise<number[]> {
  let h = 5381;
  for (let i = 0; i < Math.min(text.length, 200); i++) {
    h = Math.imul((h << 5) + h, 1) ^ text.charCodeAt(i);
    h = h >>> 0;
  }
  const dim = 64;
  const vec = new Array(dim).fill(0);
  vec[h % dim] = 1.0;
  return Promise.resolve(vec);
}

// ---------------------------------------------------------------------------

const SAMPLE_TEXT = `Introduction to PluresDB

PluresDB is a local-first CRDT database with native HNSW vector search.
It stores structured data and embeddings in a single binary with no external dependencies.

Architecture Overview

The database uses an append-only log for mutations and a separate HNSW index for
vector similarity search. All writes are CRDT-safe and can be merged across peers.`;

const SAMPLE_METADATA: DocumentMetadata = {
  source_path: "/docs/pluresdb.md",
  author: "Bob",
  doc_type: "other",
};

// ---------------------------------------------------------------------------

describe("pluresLM_ingest_document", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    _setIngestState(db, stubEmbed);
  });

  afterEach(() => {
    _setIngestState(null, null);
    cleanup();
  });

  it("returns a documentId and non-empty chunkIds", async () => {
    const result = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    expect(typeof result.documentId).toBe("string");
    expect(result.documentId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.chunkIds)).toBe(true);
    expect(result.chunkIds.length).toBeGreaterThan(0);
  });

  it("stores a parent document entry with category 'document'", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const all = await db.listMemories();
    const docEntries = all.filter((e) => e.category === "document");
    expect(docEntries.length).toBe(1);
  });

  it("stores chunk entries with category 'document-chunk'", async () => {
    const result = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const all = await db.listMemories();
    const chunkEntries = all.filter((e) => e.category === "document-chunk");
    expect(chunkEntries.length).toBeGreaterThan(0);
    expect(chunkEntries.length).toBe(result.chunkIds.length);
  });

  it("document and chunks share the same source tag", async () => {
    const result = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const all = await db.listMemories();
    const expectedSource = `document:${result.documentId}`;
    for (const entry of all) {
      expect(entry.source).toBe(expectedSource);
    }
  });

  it("encodes metadata as meta:<key>:<value> tags on the document entry", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const all = await db.listMemories();
    const docEntry = all.find((e) => e.category === "document");
    expect(docEntry).toBeDefined();
    expect(docEntry!.tags).toContain("meta:source_path:/docs/pluresdb.md");
    expect(docEntry!.tags).toContain("meta:author:Bob");
    expect(docEntry!.tags).toContain("meta:doc_type:other");
  });

  it("throws when not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_ingest_document(SAMPLE_TEXT, {})).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });
});

// ---------------------------------------------------------------------------

describe("pluresLM_list_sources", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    _setIngestState(db, stubEmbed);
  });

  afterEach(() => {
    _setIngestState(null, null);
    cleanup();
  });

  it("returns an empty array when no documents are ingested", async () => {
    const sources = await pluresLM_list_sources();
    expect(sources).toEqual([]);
  });

  it("returns one DocumentSource per ingested document", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const sources = await pluresLM_list_sources();
    expect(sources.length).toBe(1);
  });

  it("returned source has required fields", async () => {
    const { documentId } = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const sources = await pluresLM_list_sources();
    const source = sources[0];
    expect(source.id).toBe(documentId);
    expect(typeof source.title).toBe("string");
    expect(typeof source.summary).toBe("string");
    expect(Array.isArray(source.keyTopics)).toBe(true);
    expect(typeof source.chunkCount).toBe("number");
    expect(source.chunkCount).toBeGreaterThan(0);
    expect(typeof source.createdAt).toBe("number");
  });

  it("chunkCount matches the ingested chunk count", async () => {
    const { chunkIds } = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const sources = await pluresLM_list_sources();
    expect(sources[0].chunkCount).toBe(chunkIds.length);
  });

  it("reconstructs metadata from meta tags", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    const sources = await pluresLM_list_sources();
    expect(sources[0].metadata.source_path).toBe("/docs/pluresdb.md");
    expect(sources[0].metadata.author).toBe("Bob");
    expect(sources[0].metadata.doc_type).toBe("other");
  });

  it("tracks multiple ingested documents separately", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, { source_path: "/a.md" });
    await pluresLM_ingest_document(
      "Different document with new content about architecture.",
      { source_path: "/b.md" },
    );
    const sources = await pluresLM_list_sources();
    expect(sources.length).toBe(2);
    const paths = sources.map((s) => s.metadata.source_path);
    expect(paths).toContain("/a.md");
    expect(paths).toContain("/b.md");
  });

  it("throws when not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_list_sources()).rejects.toThrow("pluresLM is not initialised");
  });
});

// ---------------------------------------------------------------------------

describe("pluresLM_delete_source", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    _setIngestState(db, stubEmbed);
  });

  afterEach(() => {
    _setIngestState(null, null);
    cleanup();
  });

  it("removes the document and all its chunks from PluresDB", async () => {
    const { documentId } = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);

    const beforeAll = await db.listMemories();
    expect(beforeAll.length).toBeGreaterThan(0);

    await pluresLM_delete_source(documentId);

    const afterAll = await db.listMemories();
    expect(afterAll.length).toBe(0);
  });

  it("document no longer appears in list_sources after deletion", async () => {
    const { documentId } = await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    await pluresLM_delete_source(documentId);
    const sources = await pluresLM_list_sources();
    expect(sources).toEqual([]);
  });

  it("only deletes the targeted document when multiple exist", async () => {
    const { documentId: id1 } = await pluresLM_ingest_document(SAMPLE_TEXT, { source_path: "/a.md" });
    await pluresLM_ingest_document(
      "Different document with new content about architecture.",
      { source_path: "/b.md" },
    );

    await pluresLM_delete_source(id1);

    const sources = await pluresLM_list_sources();
    expect(sources.length).toBe(1);
    expect(sources[0].metadata.source_path).toBe("/b.md");
  });

  it("is a no-op for an unknown sourceId", async () => {
    await pluresLM_ingest_document(SAMPLE_TEXT, SAMPLE_METADATA);
    await expect(pluresLM_delete_source("non-existent-id")).resolves.toBeUndefined();
    const sources = await pluresLM_list_sources();
    expect(sources.length).toBe(1);
  });

  it("throws when not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_delete_source("some-id")).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });
});
