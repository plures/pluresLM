/**
 * Embedding providers: Transformers.js (default), Ollama (optional).
 *
 * Transformers.js runs in-process — no external servers, no API keys.
 * Ollama kept as optional for users who want GPU-accelerated embeddings.
 */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

// ============================================================================
// Transformers.js — zero-config, in-process embeddings
// ============================================================================

export class TransformersEmbeddings implements EmbeddingProvider {
  dimension: number;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private log: (msg: string) => void;

  constructor(
    private model: string = "Xenova/bge-small-en-v1.5",
    dimension: number = 384,
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this.dimension = dimension;
    this.log = logger?.info ?? (() => {});
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.log(`[embeddings] Loading Transformers.js model: ${this.model} (~33MB, first use downloads)`);
      // @ts-ignore — pipeline() returns a union type too complex for TS to resolve (TS2590)
      this.pipelinePromise = pipeline("feature-extraction", this.model);
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const result = await pipe(text, { pooling: "mean", normalize: true });

    // Tensor → flat array
    const embedding = Array.from(result.data as Float32Array) as number[];

    if (embedding.length !== this.dimension) {
      this.log(`[embeddings] Warning: model returned ${embedding.length} dims, expected ${this.dimension}`);
      this.dimension = embedding.length;
    }

    return embedding;
  }
}

// ============================================================================
// Ollama — optional, for GPU-accelerated embeddings
// ============================================================================

export class OllamaEmbeddings implements EmbeddingProvider {
  dimension: number;

  constructor(
    private endpoint: string = "http://localhost:11434",
    private model: string = "snowflake-arctic-embed2",
    dimension: number = 1024,
  ) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    if (data.embedding.length !== this.dimension) {
      this.dimension = data.embedding.length;
    }
    return data.embedding;
  }
}

// ============================================================================
// Provider factory — selects based on config
// ============================================================================

export class DualEmbeddings implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private _dimension: number;
  private log: (msg: string) => void;

  get dimension(): number {
    return this._dimension;
  }

  constructor(
    opts: {
      provider?: "transformers" | "ollama";
      transformersModel?: string;
      ollamaEndpoint?: string;
      ollamaModel?: string;
      ollamaFallbackEndpoint?: string;
      dimension?: number;
      debug?: boolean;
      openaiKey?: string;    // ignored, kept for config compat
      openaiModel?: string;  // ignored, kept for config compat
    },
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this.log = logger?.info ?? (() => {});

    const provider = opts.provider ?? "transformers";

    if (provider === "ollama") {
      const endpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
      const model = opts.ollamaModel ?? "snowflake-arctic-embed2";
      const dim = opts.dimension ?? 1024;
      this._dimension = dim;
      this.primary = new OllamaEmbeddings(endpoint, model, dim);
      this.log(`[embeddings] Ollama: ${endpoint} model=${model} dim=${dim}`);
    } else {
      // Default: Transformers.js (zero config)
      const model = opts.transformersModel ?? "Xenova/bge-small-en-v1.5";
      const dim = opts.dimension ?? 384;
      this._dimension = dim;
      this.primary = new TransformersEmbeddings(model, dim, logger);
      this.log(`[embeddings] Transformers.js: ${model} dim=${dim} (in-process, no external deps)`);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.primary.embed(text);
  }
}
