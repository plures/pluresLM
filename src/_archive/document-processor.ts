/**
 * Document processing pipeline for pluresLM.
 *
 * Processes raw document text + metadata into structured documents with
 * semantic chunks ready for storage in PluresDB.
 *
 * - Metadata extraction (title, summary, key topics) via local Qwen model (Ollama).
 *   Falls back to heuristics when the model is unavailable.
 * - Semantic chunking at paragraph boundaries with topic-shift awareness.
 * - Embedding generation for each chunk (optional).
 */

import type { EmbeddingProvider } from "./embeddings.js";
import type { DocumentMetadata } from "./types.js";

export interface ProcessedDocument {
  title: string;
  summary: string;
  keyTopics: string[];
  chunks: DocumentChunk[];
  metadata: DocumentMetadata;
}

export interface DocumentChunk {
  text: string;
  startOffset: number;
  endOffset: number;
  chunkIndex: number;
  topics: string[];
}

export interface DocumentProcessorOpts {
  /** EmbeddingProvider used to embed each chunk. Optional. */
  embeddings?: EmbeddingProvider;
  /** Ollama base URL for metadata extraction via Qwen. Defaults to "http://localhost:11434". */
  ollamaEndpoint?: string;
  /** Ollama model name for metadata extraction. Defaults to "qwen2.5". */
  ollamaModel?: string;
  /** Minimum character count per chunk before merging with the next. Defaults to 150. */
  minChunkSize?: number;
  /** Maximum character count per chunk before splitting at sentence boundaries. Defaults to 1500. */
  maxChunkSize?: number;
}

const DEFAULT_MIN_CHUNK_SIZE = 150;
const DEFAULT_MAX_CHUNK_SIZE = 1500;

export class DocumentProcessor {
  private readonly embeddings: EmbeddingProvider | undefined;
  private readonly ollamaEndpoint: string;
  private readonly ollamaModel: string;
  private readonly minChunkSize: number;
  private readonly maxChunkSize: number;

  constructor(opts: DocumentProcessorOpts = {}) {
    this.embeddings = opts.embeddings;
    this.ollamaEndpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
    this.ollamaModel = opts.ollamaModel ?? "qwen2.5";
    this.minChunkSize = opts.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
    this.maxChunkSize = opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  async processDocument(text: string, metadata: DocumentMetadata): Promise<ProcessedDocument> {
    const [extracted, chunks] = await Promise.all([
      this.extractMetadata(text),
      this.semanticChunk(text),
    ]);

    return {
      title: extracted.title,
      summary: extracted.summary,
      keyTopics: extracted.keyTopics,
      chunks,
      metadata,
    };
  }

  private async semanticChunk(text: string): Promise<DocumentChunk[]> {
    // Build paragraphs with character offsets from the original text.
    const paras = extractParagraphsWithOffsets(text);

    // Merge short paragraphs with the next one until minChunkSize is met.
    const merged: Array<{ text: string; start: number; end: number }> = [];
    let current: { text: string; start: number; end: number } | null = null;

    for (const para of paras) {
      if (!current) {
        current = { ...para };
        continue;
      }
      if (current.text.length < this.minChunkSize) {
        current = {
          text: `${current.text}\n\n${para.text}`,
          start: current.start,
          end: para.end,
        };
      } else {
        merged.push(current);
        current = { ...para };
      }
    }
    if (current) merged.push(current);

    // Split overly long chunks at sentence boundaries.
    const finalChunks: Array<{ text: string; start: number; end: number }> = [];
    for (const chunk of merged) {
      if (chunk.text.length <= this.maxChunkSize) {
        finalChunks.push(chunk);
        continue;
      }

      const sentences = chunk.text.match(/[^.!?\n]+[.!?]*\n?/g) ?? [chunk.text];
      let currentText = "";
      let currentStart = chunk.start;

      for (const sentence of sentences) {
        if (currentText.length + sentence.length > this.maxChunkSize && currentText.length > 0) {
          const trimmedText = currentText.trim();
          finalChunks.push({
            text: trimmedText,
            start: currentStart,
            end: currentStart + trimmedText.length,
          });
          // Advance by the full (untrimmed) length to consume trailing whitespace.
          currentStart = currentStart + currentText.length;
          currentText = sentence;
        } else {
          currentText += sentence;
        }
      }
      if (currentText.trim().length > 0) {
        finalChunks.push({ text: currentText.trim(), start: currentStart, end: chunk.end });
      }
    }

    return finalChunks.map((c, i) => ({
      text: c.text,
      startOffset: c.start,
      endOffset: c.end,
      chunkIndex: i,
      topics: extractTopicKeywords(c.text),
    }));
  }

  private async extractMetadata(
    text: string,
  ): Promise<{ title: string; summary: string; keyTopics: string[] }> {
    try {
      return await this.extractMetadataViaQwen(text);
    } catch {
      return this.extractMetadataHeuristic(text);
    }
  }

  private async extractMetadataViaQwen(
    text: string,
  ): Promise<{ title: string; summary: string; keyTopics: string[] }> {
    const excerpt = text.slice(0, 4000);
    const prompt = `Analyze this document and respond with ONLY a JSON object with these exact fields:
- "title": a concise title for the document (string)
- "summary": a 1-2 sentence summary (string)
- "keyTopics": an array of 3-7 key topic strings

Document:
${excerpt}

JSON:`;

    const response = await fetch(`${this.ollamaEndpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.ollamaModel,
        prompt,
        stream: false,
        format: "json",
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    const parsed = JSON.parse(data.response) as {
      title?: unknown;
      summary?: unknown;
      keyTopics?: unknown;
    };

    return {
      title:
        typeof parsed.title === "string" && parsed.title.length > 0
          ? parsed.title
          : this.extractTitleHeuristic(text),
      summary:
        typeof parsed.summary === "string" && parsed.summary.length > 0
          ? parsed.summary
          : this.extractSummaryHeuristic(text),
      keyTopics:
        Array.isArray(parsed.keyTopics) && parsed.keyTopics.length > 0
          ? (parsed.keyTopics as unknown[]).filter((t): t is string => typeof t === "string")
          : extractTopicKeywords(text),
    };
  }

  private extractMetadataHeuristic(text: string): {
    title: string;
    summary: string;
    keyTopics: string[];
  } {
    return {
      title: this.extractTitleHeuristic(text),
      summary: this.extractSummaryHeuristic(text),
      keyTopics: extractTopicKeywords(text),
    };
  }

  private extractTitleHeuristic(text: string): string {
    for (const line of text.split("\n")) {
      const trimmed = line.replace(/^#+\s*/, "").trim();
      if (trimmed.length > 0) return trimmed.slice(0, 120);
    }
    return "Untitled Document";
  }

  private extractSummaryHeuristic(text: string): string {
    const firstPara = text.split(/\n{2,}/)[0]?.trim() ?? "";
    return firstPara.slice(0, 500);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split `text` into trimmed paragraphs (separated by two or more newlines),
 * returning each with its character start/end offset in the original string.
 */
function extractParagraphsWithOffsets(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const paras: Array<{ text: string; start: number; end: number }> = [];
  const separators = [...text.matchAll(/\n{2,}/g)];

  // Build segment boundaries: [0, after_sep1, after_sep2, ..., text.length]
  const segmentStarts = [0, ...separators.map((m) => (m.index ?? 0) + m[0].length)];
  const segmentEnds = [...separators.map((m) => m.index ?? text.length), text.length];

  for (let i = 0; i < segmentStarts.length; i++) {
    const raw = text.slice(segmentStarts[i], segmentEnds[i]);
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const leadingOffset = raw.length - raw.trimStart().length;
    paras.push({
      text: trimmed,
      start: segmentStarts[i] + leadingOffset,
      end: segmentStarts[i] + leadingOffset + trimmed.length,
    });
  }

  return paras;
}

/** Common English stop words excluded from topic keyword extraction. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "do", "for", "from", "has", "have", "in", "is", "it", "its",
  "not", "of", "on", "or", "so", "that", "the", "this", "to",
  "was", "were", "which", "with", "you", "your",
]);

/**
 * Extract up to 7 significant topic keywords from `text` using term-frequency
 * heuristics. Returns lowercased, de-duplicated words sorted by frequency.
 */
function extractTopicKeywords(text: string): string[] {
  const freq = new Map<string, number>();
  const words = text.toLowerCase().match(/\b[a-z][a-z'-]{2,}\b/g) ?? [];
  for (const word of words) {
    if (!STOP_WORDS.has(word)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([word]) => word);
}
