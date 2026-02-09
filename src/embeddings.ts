/**
 * Dual embedding provider with OpenAI primary + Ollama fallback
 */

import OpenAI from "openai";

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
      openaiKey?: string;
      openaiModel?: string;
      ollamaEndpoint?: string;
      ollamaModel?: string;
      dimension?: number;
      debug?: boolean;
    },
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this._dimension = opts.dimension ?? 1536;
    this.log = logger?.info ?? (() => {});

    const apiKey = opts.openaiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.primary = new OpenAIEmbeddings(apiKey, opts.openaiModel, this._dimension);
    }

    this.fallback = new OllamaEmbeddings(
      opts.ollamaEndpoint ?? "http://localhost:11434",
      opts.ollamaModel ?? "nomic-embed-text",
      opts.dimension ?? 768,
    );
  }

  async embed(text: string): Promise<number[]> {
    if (this.primary) {
      try {
        return await this.primary.embed(text);
      } catch (err) {
        this.log(`OpenAI embedding failed, falling back to Ollama: ${String(err)}`);
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

    throw new Error("No embedding provider available (set OPENAI_API_KEY or run Ollama)");
  }
}
