/**
 * Local-only embedding provider using Ollama.
 * Primary: Windows GPU (DirectML) via WSL gateway
 * Fallback: WSL local CPU
 * No cloud calls — 100% local.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

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

/**
 * Dual local Ollama provider with GPU primary + CPU fallback.
 * - Primary: Windows Ollama (GPU via DirectML) at WSL gateway IP
 * - Fallback: WSL-local Ollama (CPU) at 127.0.0.1:11435
 */
export class DualEmbeddings implements EmbeddingProvider {
  private primary: OllamaEmbeddings;
  private fallback: OllamaEmbeddings | null;
  private _dimension: number;
  private log: (msg: string) => void;
  private usingFallback = false;
  private lastPrimaryCheck = 0;
  private readonly PRIMARY_RETRY_MS = 30_000; // retry primary every 30s

  get dimension(): number {
    return this._dimension;
  }

  constructor(
    opts: {
      openaiKey?: string;
      openaiModel?: string;
      ollamaEndpoint?: string;
      ollamaModel?: string;
      ollamaFallbackEndpoint?: string;
      dimension?: number;
      debug?: boolean;
    },
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    const endpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
    const model = opts.ollamaModel ?? "snowflake-arctic-embed2";
    const dim = opts.dimension ?? 1024;
    const fallbackEndpoint = opts.ollamaFallbackEndpoint ?? "http://127.0.0.1:11435";

    this._dimension = dim;
    this.primary = new OllamaEmbeddings(endpoint, model, dim);
    this.log = logger?.info ?? (() => {});

    // Only create fallback if it's a different endpoint
    if (fallbackEndpoint !== endpoint) {
      this.fallback = new OllamaEmbeddings(fallbackEndpoint, model, dim);
    } else {
      this.fallback = null;
    }

    if (opts.debug) {
      this.log(`[embeddings] Ollama primary: ${endpoint} model=${model} dim=${dim}`);
      if (this.fallback) {
        this.log(`[embeddings] Ollama fallback: ${fallbackEndpoint} (CPU)`);
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const now = Date.now();

    // If we were using fallback, periodically retry primary
    if (this.usingFallback && (now - this.lastPrimaryCheck) > this.PRIMARY_RETRY_MS) {
      try {
        const result = await this.primary.embed(text);
        this.usingFallback = false;
        this.log("[embeddings] primary (GPU) recovered");
        return result;
      } catch {
        this.lastPrimaryCheck = now;
        // Stay on fallback
      }
    }

    if (!this.usingFallback) {
      try {
        return await this.primary.embed(text);
      } catch (err) {
        if (this.fallback) {
          this.log(`[embeddings] primary failed (${String(err)}), switching to CPU fallback`);
          this.usingFallback = true;
          this.lastPrimaryCheck = now;
        } else {
          throw err;
        }
      }
    }

    if (this.fallback) {
      return await this.fallback.embed(text);
    }

    throw new Error("No embedding provider available");
  }
}
