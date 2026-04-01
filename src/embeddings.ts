/**
 * Embedding providers for pluresLM.
 *
 * Primary: PluresDB native fastembed (Rust/ONNX, via NAPI)
 * Fallback: Ollama (optional, for GPU-accelerated embeddings)
 *
 * The PluresDB provider uses the same fastembed model that auto-embeds on put(),
 * ensuring query embeddings are in the same vector space as stored embeddings.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

// ============================================================================
// PluresDB native embeddings — uses fastembed via NAPI
// ============================================================================

/** Database handle type (from PluresDB NAPI) */
interface PluresDBHandle {
  embed(texts: string[]): number[][];
  embeddingDimension(): number | null;
}

export class PluresDBEmbeddings implements EmbeddingProvider {
  dimension: number;
  private db: PluresDBHandle;

  constructor(db: PluresDBHandle) {
    this.db = db;
    const dim = db.embeddingDimension();
    if (!dim) throw new Error("PluresDB database was not created with embedding support");
    this.dimension = dim;
  }

  async embed(text: string): Promise<number[]> {
    const results = this.db.embed([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.db.embed(texts);
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
// Provider factory
// ============================================================================

export class DualEmbeddings implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private _dimension: number;

  get dimension(): number {
    return this._dimension;
  }

  constructor(
    opts: {
      provider?: "pluresdb" | "ollama" | "transformers";
      pluresdb?: PluresDBHandle;
      ollamaEndpoint?: string;
      ollamaModel?: string;
      dimension?: number;
      debug?: boolean;
      // Legacy compat — ignored
      openaiKey?: string;
      openaiModel?: string;
      transformersModel?: string;
      ollamaFallbackEndpoint?: string;
    },
    logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    const log = logger?.info ?? (() => {});
    const provider = opts.provider ?? (opts.pluresdb ? "pluresdb" : "ollama");

    if (provider === "pluresdb" || (provider === "transformers" && opts.pluresdb)) {
      if (!opts.pluresdb) throw new Error("pluresdb handle required for PluresDB embeddings");
      this.primary = new PluresDBEmbeddings(opts.pluresdb);
      this._dimension = this.primary.dimension;
      log(`[embeddings] PluresDB native fastembed dim=${this._dimension} (Rust/ONNX, zero-copy)`);
    } else if (provider === "ollama") {
      const endpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
      const model = opts.ollamaModel ?? "snowflake-arctic-embed2";
      const dim = opts.dimension ?? 1024;
      this._dimension = dim;
      this.primary = new OllamaEmbeddings(endpoint, model, dim);
      log(`[embeddings] Ollama: ${endpoint} model=${model} dim=${dim}`);
    } else {
      throw new Error(`Unknown embedding provider: ${provider}. Use "pluresdb" or "ollama".`);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.primary.embed(text);
  }
}
