/**
 * Embedding providers: Transformers.js (default), OpenAI, Ollama
 */

import OpenAI from "openai";
import { pipeline } from "@huggingface/transformers";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  private client: OpenAI;
  dimension: number;

  constructor(
    apiKey: string,
    private model: string = "text-embedding-3-small",
    dimension: number = 1536,
  ) {
    this.client = new OpenAI({ apiKey });
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }
}

export class OllamaEmbeddings implements EmbeddingProvider {
  dimension: number;

  constructor(
    private endpoint: string = "http://localhost:11434",
    private model: string = "nomic-embed-text",
    dimension: number = 768,
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
    // Update dimension on first successful call
    if (data.embedding.length !== this.dimension) {
      this.dimension = data.embedding.length;
    }
    return data.embedding;
  }
}

export class TransformersEmbeddings implements EmbeddingProvider {
  dimension: number;
  private pipelinePromise: Promise<any> | null = null;
  private log: (msg: string) => void;

  constructor(
    private model: string = "Xenova/bge-small-en-v1.5",
    dimension: number = 384,
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this.dimension = dimension;
    this.log = logger?.info ?? (() => {});
  }

  private async getPipeline(): Promise<any> {
    if (!this.pipelinePromise) {
      this.log(`Loading Transformers.js model: ${this.model} (first use may download ~33MB)`);
      this.pipelinePromise = pipeline("feature-extraction", this.model);
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const result = await pipe(text, { pooling: "mean", normalize: true });
    
    // Convert tensor to array
    const embedding = Array.from(result.data) as number[];
    
    // Verify dimension
    if (embedding.length !== this.dimension) {
      this.log(`Warning: Model returned ${embedding.length} dimensions, expected ${this.dimension}`);
      this.dimension = embedding.length;
    }
    
    return embedding;
  }
}

export class DualEmbeddings implements EmbeddingProvider {
  private primary: EmbeddingProvider | null = null;
  private fallback: EmbeddingProvider | null = null;
  private _dimension: number;
  private log: (msg: string) => void;

  get dimension(): number {
    return this._dimension;
  }

  constructor(
    opts: {
      provider?: "transformers" | "openai" | "ollama";
      transformersModel?: string;
      openaiKey?: string;
      openaiModel?: string;
      ollamaEndpoint?: string;
      ollamaModel?: string;
      dimension?: number;
      debug?: boolean;
    },
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this._dimension = opts.dimension ?? 384; // Default to 384 for Transformers.js
    this.log = logger?.info ?? (() => {});

    const provider = opts.provider ?? "transformers";

    if (provider === "transformers") {
      // Default: Transformers.js (zero config)
      this.primary = new TransformersEmbeddings(
        opts.transformersModel ?? "Xenova/bge-small-en-v1.5",
        this._dimension,
        logger,
      );
    } else if (provider === "openai") {
      // OpenAI with optional API key
      const apiKey = opts.openaiKey || process.env.OPENAI_API_KEY;
      if (apiKey) {
        this.primary = new OpenAIEmbeddings(apiKey, opts.openaiModel, this._dimension);
      } else {
        throw new Error("OpenAI provider selected but no API key available");
      }
    } else if (provider === "ollama") {
      // Ollama (requires external server)
      this.primary = new OllamaEmbeddings(
        opts.ollamaEndpoint ?? "http://localhost:11434",
        opts.ollamaModel ?? "nomic-embed-text",
        this._dimension,
      );
    }

    // No fallback by default - fail fast
    this.fallback = null;
  }

  async embed(text: string): Promise<number[]> {
    if (this.primary) {
      try {
        return await this.primary.embed(text);
      } catch (err) {
        if (this.fallback) {
          this.log(`Primary embedding failed, falling back: ${String(err)}`);
        } else {
          throw err;
        }
      }
    }

    if (this.fallback) {
      try {
        const vec = await this.fallback.embed(text);
        // Pad or truncate to match expected dimension
        if (vec.length < this._dimension) {
          return [...vec, ...new Array(this._dimension - vec.length).fill(0)];
        }
        return vec.slice(0, this._dimension);
      } catch (err) {
        throw new Error(`All embedding providers failed. Last error: ${String(err)}`);
      }
    }

    throw new Error("No embedding provider available");
  }
}
