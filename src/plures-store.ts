/**
 * PluresStore — generic graph+vector+procedure interface for the PluresDB engine.
 *
 * This interface is the **product boundary** between the PluresDB engine layer
 * and the pluresLM application layer.
 *
 * ## Design principle
 *
 * PluresDB provides only generic primitives:
 *   - Graph nodes   (`put` / `get` / `delete` / `list`)
 *   - Vector search (`putWithEmbedding` / `vectorSearch`)
 *   - Text search   (`search`)
 *   - Procedures    (`execDsl` / `execIr`)
 *
 * PluresDB does **not** know about "memories", categories, priorities, or any
 * other application-level concepts.  Those live in the pluresLM layer above
 * this interface (see `PluresDBBackend`, `TopicIndex`, `MemoryAPI`, etc.).
 *
 * Any class or module that depends only on `PluresStore` is guaranteed to
 * stay within the engine layer; anything that imports `MemoryEntry`,
 * `MemorySearchResult`, or similar types has crossed into the application
 * layer.
 */

/** A generic node as returned by PluresDB list / vector operations. */
export interface PluresNode {
  /** Namespaced node identifier, e.g. `"memory:uuid"` or `"topic:uuid"`. */
  id: string;
  /** Arbitrary key-value data stored with this node. */
  data: Record<string, unknown>;
  /** Relevance score populated by vector / text search operations. */
  score?: number;
  /** Optional wall-clock timestamp attached by the CRDT engine. */
  timestamp?: string;
}

/** Result returned by a PluresDB DSL or IR procedure execution. */
export interface ProcedureResult {
  nodes?: PluresNode[];
  aggregate?: unknown;
  mutated?: number;
}

/**
 * Generic graph+vector+procedure primitives provided by the PluresDB engine.
 *
 * Implementors:
 *  - Production: the native `PluresDatabase` NAPI object loaded from
 *    `@plures/pluresdb/embedded` (Rust → N-API bridge).
 *  - Tests: the in-memory mock in `test/helpers/db.ts`.
 *
 * `PluresDBBackend` wraps a `PluresStore` and layers memory-specific logic
 * on top of it (namespacing, `MemoryEntry` serialisation, deduplication, …).
 */
export interface PluresStore {
  /** Store a node by ID. Overwrites any existing data for the same ID. */
  put(id: string, data: Record<string, unknown>): void;

  /** Store a node together with its pre-computed vector embedding. */
  putWithEmbedding(id: string, data: Record<string, unknown>, embedding: number[]): void;

  /** Retrieve a node's data by ID.  Returns `null` when not found. */
  get(id: string): Record<string, unknown> | null;

  /** Remove a node by ID. */
  delete(id: string): void;

  /** Return all nodes in the store. */
  list(): PluresNode[];

  /** Return nodes whose IDs start with `nodeType` (used as a type prefix). */
  listByType(nodeType: string): PluresNode[];

  /**
   * Approximate nearest-neighbour vector search.
   *
   * @param embedding  Query vector.
   * @param limit      Maximum results to return (default: 10).
   * @param threshold  Minimum cosine similarity score (default: 0).
   */
  vectorSearch(embedding: number[], limit?: number, threshold?: number): PluresNode[];

  /**
   * Full-text search across node content.
   *
   * @param query  Search query string.
   * @param limit  Maximum results to return.
   */
  search(query: string, limit?: number): PluresNode[];

  /** Execute a PluresDB query DSL string and return the result. */
  execDsl(query: string): ProcedureResult;

  /** Execute a PluresDB IR (intermediate-representation) plan. */
  execIr(steps: Array<Record<string, unknown>>): ProcedureResult;
}
