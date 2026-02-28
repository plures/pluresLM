/**
 * Tests for document content type schemas (src/types.ts).
 * Validates DocumentMetadata, DocType, and determinePriority for document categories.
 */

import { describe, expect, it } from "vitest";
import { determinePriority } from "../../src/types.js";
import type { DocumentMetadata, DocType } from "../../src/types.js";

describe("determinePriority — document categories", () => {
  it("returns high for document", () => {
    expect(determinePriority("document", [])).toBe("high");
  });

  it("returns normal for document-chunk", () => {
    expect(determinePriority("document-chunk", [])).toBe("normal");
  });

  it("returns high for note", () => {
    expect(determinePriority("note", [])).toBe("high");
  });

  it("returns high for reference", () => {
    expect(determinePriority("reference", [])).toBe("high");
  });

  it("returns high for insight", () => {
    expect(determinePriority("insight", [])).toBe("high");
  });

  it("critical tag overrides document category", () => {
    expect(determinePriority("document", ["critical"])).toBe("critical");
  });

  it("permanent tag overrides document-chunk category", () => {
    expect(determinePriority("document-chunk", ["permanent"])).toBe("critical");
  });
});

describe("DocumentMetadata interface", () => {
  it("accepts all valid doc_type values", () => {
    const docTypes: DocType[] = ["google-docs", "pdf", "spreadsheet", "presentation", "other"];
    for (const doc_type of docTypes) {
      const meta: DocumentMetadata = { doc_type };
      expect(meta.doc_type).toBe(doc_type);
    }
  });

  it("accepts partial metadata", () => {
    const meta: DocumentMetadata = {
      source_path: "/docs/spec.pdf",
      author: "Alice",
    };
    expect(meta.source_path).toBe("/docs/spec.pdf");
    expect(meta.author).toBe("Alice");
    expect(meta.doc_type).toBeUndefined();
  });

  it("accepts full metadata", () => {
    const meta: DocumentMetadata = {
      source_path: "/docs/report.pdf",
      author: "Bob",
      doc_type: "pdf",
      created_date: "2026-01-15",
      word_count: 4200,
      original_url: "https://example.com/report.pdf",
    };
    expect(meta.source_path).toBe("/docs/report.pdf");
    expect(meta.author).toBe("Bob");
    expect(meta.doc_type).toBe("pdf");
    expect(meta.created_date).toBe("2026-01-15");
    expect(meta.word_count).toBe(4200);
    expect(meta.original_url).toBe("https://example.com/report.pdf");
  });

  it("accepts empty metadata object", () => {
    const meta: DocumentMetadata = {};
    expect(Object.keys(meta).length).toBe(0);
  });
});
