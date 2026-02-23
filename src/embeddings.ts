/**
 * Embedding providers: Ollama (default for query-side embedding).
 *
 * Storage-side embedding is handled by PluresDB's built-in FastEmbedder
 * (BAAI/bge-small-en-v1.5 via fastembed/ONNX Runtime) when the PluresDB
 * NAPI backend is used.  pluresLM only needs embeddings for query vectors
 * (recall, dedup checks) — Ollama is the recommended provider for that.
 *
 * When Ollama is unavailable a lightweight hash-based fallback is used
 * automatically.  This keeps the system functional offline at the cost of
 * lower recall quality; configure Ollama with BAAI/bge-small-en-v1.5 for
 * full quality matching PluresDB's storage-side embeddings.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

// ============================================================================
// Ollama — query-side embeddings
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
// Hash-based fallback — lightweight, no external deps, low quality
// ============================================================================

/**
 * Deterministic FNV-1a hash-based embedding.
 *
 * Used as a fallback when Ollama is unavailable.  Produces consistent vectors
 * for the same input text so dedup and search work offline, but recall quality
 * is significantly lower than a real ML model.  Not suitable for production;
 * configure Ollama with BAAI/bge-small-en-v1.5 for high-quality embeddings.
 */
export class HashEmbeddings implements EmbeddingProvider {
  dimension: number;

  constructor(dimension = 384) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float32Array(this.dimension);
    let h = 2166136261 >>> 0; // FNV-1a offset basis
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
      vec[Math.abs(h) % this.dimension] += 1;
    }
    // L2-normalise
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec).map((v) => v / norm);
  }
}

// ============================================================================
// Provider factory — selects based on config
// ============================================================================

export class DualEmbeddings implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private secondary: OllamaEmbeddings | null;
  private fallback: HashEmbeddings;
  private _dimension: number;
  private log: (msg: string) => void;

  get dimension(): number {
    return this._dimension;
  }

  constructor(
    opts: {
      provider?: "ollama";
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

    // Ollama is the primary query-side embedding provider.
    // Storage-side embedding is handled by PluresDB's built-in FastEmbedder.
    const endpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
    const model = opts.ollamaModel ?? "snowflake-arctic-embed2";
    const dim = opts.dimension ?? 1024;
    this._dimension = dim;
    this.primary = new OllamaEmbeddings(endpoint, model, dim);
    // Secondary Ollama endpoint tried on primary failure before the hash fallback.
    const fallbackEndpoint = opts.ollamaFallbackEndpoint;
    this.secondary = fallbackEndpoint && fallbackEndpoint !== endpoint
      ? new OllamaEmbeddings(fallbackEndpoint, model, dim)
      : null;
    this.fallback = new HashEmbeddings(dim);
    this.log(`[embeddings] Ollama: ${endpoint} model=${model} dim=${dim}`);
    if (this.secondary) {
      this.log(`[embeddings] Ollama fallback: ${fallbackEndpoint}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      return await this.primary.embed(text);
    } catch {
      // Primary Ollama unavailable — try secondary endpoint before hash fallback.
      if (this.secondary) {
        try {
          return await this.secondary.embed(text);
        } catch { /* fall through to hash */ }
      }
      return this.fallback.embed(text);
    }
  }
}
