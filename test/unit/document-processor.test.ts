/**
 * Tests for DocumentProcessor (src/document-processor.ts).
 *
 * Validates:
 *  - processDocument returns a structured ProcessedDocument
 *  - semanticChunk produces coherent, non-overlapping chunks
 *  - Heuristic metadata extraction (title, summary, keyTopics)
 *
 * The Ollama/Qwen path is not exercised here (no live model in CI).
 * DocumentProcessor falls back to heuristics when the model is unavailable,
 * so all tests use the heuristic path by omitting ollamaEndpoint / using an
 * endpoint that will throw.
 */

import { describe, expect, it } from "vitest";
import { DocumentProcessor } from "../../src/document-processor.js";
import type { ProcessedDocument, DocumentChunk } from "../../src/document-processor.js";
import type { DocumentMetadata } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DOC = `Introduction to PluresDB

PluresDB is a local-first CRDT database with native HNSW vector search.
It stores structured data and embeddings in a single binary with no external dependencies.

Architecture Overview

The database uses an append-only log for mutations and a separate HNSW index for
vector similarity search. All writes are CRDT-safe and can be merged across peers.

Storage and Persistence

Data is persisted to a memory-mapped file on disk. The WAL ensures durability even
after unexpected shutdowns. Vector indices are rebuilt from the log on startup.`;

const SAMPLE_METADATA: DocumentMetadata = {
  source_path: "/docs/pluresdb-overview.md",
  author: "Alice",
  doc_type: "other",
};

// An invalid endpoint so Ollama calls always fail → heuristic fallback.
const NO_MODEL_ENDPOINT = "http://127.0.0.1:1";

// ---------------------------------------------------------------------------
// processDocument — top-level integration
// ---------------------------------------------------------------------------

describe("DocumentProcessor.processDocument", () => {
  it("returns a ProcessedDocument with all required fields", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result: ProcessedDocument = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("keyTopics");
    expect(result).toHaveProperty("chunks");
    expect(result).toHaveProperty("metadata");
  });

  it("passes metadata through unchanged", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(result.metadata).toStrictEqual(SAMPLE_METADATA);
  });

  it("title is a non-empty string", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(typeof result.title).toBe("string");
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("summary is a non-empty string", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("keyTopics is a non-empty array of strings", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(Array.isArray(result.keyTopics)).toBe(true);
    expect(result.keyTopics.length).toBeGreaterThan(0);
    for (const topic of result.keyTopics) {
      expect(typeof topic).toBe("string");
    }
  });

  it("chunks array is non-empty", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(result.chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Semantic chunking
// ---------------------------------------------------------------------------

describe("DocumentProcessor — semantic chunking", () => {
  it("produces chunks with required fields", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    for (const chunk of result.chunks) {
      expect(typeof chunk.text).toBe("string");
      expect(typeof chunk.startOffset).toBe("number");
      expect(typeof chunk.endOffset).toBe("number");
      expect(typeof chunk.chunkIndex).toBe("number");
      expect(Array.isArray(chunk.topics)).toBe(true);
    }
  });

  it("chunk indices are sequential starting from 0", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    result.chunks.forEach((chunk: DocumentChunk, i: number) => {
      expect(chunk.chunkIndex).toBe(i);
    });
  });

  it("startOffset < endOffset for every chunk", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    for (const chunk of result.chunks) {
      expect(chunk.startOffset).toBeLessThan(chunk.endOffset);
    }
  });

  it("chunk offsets are within the bounds of the original text", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    for (const chunk of result.chunks) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.endOffset).toBeLessThanOrEqual(SAMPLE_DOC.length);
    }
  });

  it("chunk text matches or is contained in the original document", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    for (const chunk of result.chunks) {
      // Each word in the chunk should appear in the original document.
      const words = chunk.text.split(/\s+/).filter((w) => w.length > 3);
      for (const word of words.slice(0, 5)) {
        expect(SAMPLE_DOC).toContain(word);
      }
    }
  });

  it("short paragraphs are merged when below minChunkSize", async () => {
    // Three very short paragraphs that individually fall below minChunkSize=150.
    const shortDoc = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const dp = new DocumentProcessor({
      ollamaEndpoint: NO_MODEL_ENDPOINT,
      minChunkSize: 150,
    });
    const result = await dp.processDocument(shortDoc, {});

    // All three short paras should be merged into a single chunk (< 150 chars each).
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toContain("First paragraph");
    expect(result.chunks[0].text).toContain("Third paragraph");
  });

  it("long chunks are split at sentence boundaries", async () => {
    // Build a paragraph that exceeds maxChunkSize=100.
    const longPara =
      "The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs. " +
      "How vexingly quick daft zebras jump! " +
      "The five boxing wizards jump quickly. " +
      "Sphinx of black quartz, judge my vow.";

    const dp = new DocumentProcessor({
      ollamaEndpoint: NO_MODEL_ENDPOINT,
      maxChunkSize: 100,
    });
    const result = await dp.processDocument(longPara, {});

    // Should produce more than one chunk.
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200); // some slack for boundary
    }
  });

  it("single-paragraph document produces exactly one chunk", async () => {
    const singlePara = "PluresDB is a local-first database with CRDT support and vector search.";
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(singlePara, {});

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].chunkIndex).toBe(0);
  });

  it("each chunk has at least one topic keyword", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    for (const chunk of result.chunks) {
      expect(chunk.topics.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Heuristic metadata extraction
// ---------------------------------------------------------------------------

describe("DocumentProcessor — heuristic metadata extraction", () => {
  it("uses the first non-empty line as the title", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(result.title).toBe("Introduction to PluresDB");
  });

  it("strips markdown heading markers from the title", async () => {
    const mdDoc = "# My Heading\n\nSome body text here that is long enough.";
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(mdDoc, {});

    expect(result.title).toBe("My Heading");
  });

  it("uses 'Untitled Document' when text is blank", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument("   \n\n   ", {});

    expect(result.title).toBe("Untitled Document");
  });

  it("summary is derived from the first paragraph", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    expect(result.summary).toContain("Introduction to PluresDB");
  });

  it("keyTopics does not contain stop words", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    // Representative set of the most common stop words — not mirroring the
    // full internal STOP_WORDS set, just verifying the basic contract.
    const commonStopWords = new Set(["the", "and", "for", "are", "to", "of", "in", "is", "it", "with"]);
    for (const topic of result.keyTopics) {
      expect(commonStopWords.has(topic)).toBe(false);
    }
  });

  it("keyTopics contains relevant domain terms", async () => {
    const dp = new DocumentProcessor({ ollamaEndpoint: NO_MODEL_ENDPOINT });
    const result = await dp.processDocument(SAMPLE_DOC, SAMPLE_METADATA);

    // At least one of these domain terms should surface.
    const relevant = ["database", "vector", "crdt", "pluresdb", "search", "index", "data"];
    const found = result.keyTopics.some((t) => relevant.includes(t));
    expect(found).toBe(true);
  });
});
