/**
 * Local-only embedding provider using Ollama.
 * No cloud fallback — 100% local.
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
 * Backwards-compatible export — now just wraps OllamaEmbeddings.
 */
export class DualEmbeddings implements EmbeddingProvider {
  private provider: OllamaEmbeddings;

  get dimension(): number {
    return this.provider.dimension;
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
    const endpoint = opts.ollamaEndpoint ?? "http://localhost:11434";
    const model = opts.ollamaModel ?? "snowflake-arctic-embed2";
    const dim = opts.dimension ?? 1024;

    this.provider = new OllamaEmbeddings(endpoint, model, dim);

    if (logger && opts.debug) {
      logger.info(`[embeddings] Ollama-only: ${endpoint} model=${model} dim=${dim}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }
}
