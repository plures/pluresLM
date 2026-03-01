# PluresLM Design

## Product Boundary: PluresDB Engine vs pluresLM Application Layer

PluresLM enforces a strict two-layer architecture:

```
┌─────────────────────────────────────────────────────────┐
│  pluresLM application layer                             │
│  PluresDBBackend · MemoryAPI · TopicIndex · ops/…       │
│  Concepts: MemoryEntry, category, priority, TopicEntry  │
└───────────────────────┬─────────────────────────────────┘
                        │ PluresStore interface
┌───────────────────────▼─────────────────────────────────┐
│  PluresDB engine layer  (@plures/pluresdb)               │
│  Graph CRDT · HNSW vector search · Procedures · P2P     │
│  Concepts: nodes, edges, embeddings, DSL procedures      │
└─────────────────────────────────────────────────────────┘
```

### PluresDB engine layer

PluresDB provides **generic graph+vector+procedure primitives** only:

| Primitive       | API                                    |
|-----------------|----------------------------------------|
| Node storage    | `put(id, data)` / `get(id)` / `delete(id)` / `list()` |
| Vector storage  | `putWithEmbedding(id, data, embedding)` |
| Vector search   | `vectorSearch(embedding, limit, threshold)` |
| Text search     | `search(query, limit)`                 |
| Procedures      | `execDsl(query)` / `execIr(steps)`     |

PluresDB has **no knowledge** of "memories", categories, priorities, or
any other application concepts.  The `PluresStore` TypeScript interface
(see `src/plures-store.ts`) is the formal contract at this boundary.

### pluresLM application layer

pluresLM maps memory-domain concepts onto the generic PluresDB primitives:

| Class / Module         | Responsibility                                     |
|------------------------|----------------------------------------------------|
| `PluresDBBackend`      | Memory repository — wraps `PluresStore`, serialises `MemoryEntry` under the `memory:` namespace |
| `TopicIndex`           | Org-memory topic directory — hierarchical topic taxonomy built on `PluresStore` under the `topic:` namespace |
| `MemoryAPI`            | High-level recall/capture API used by Pares Agens  |
| `ops/error-capture`    | CI failure/fix pair capture                        |
| `ops/repo-knowledge`   | Repository context capture                         |
| `ops/preference-tracker` | Human preference capture                        |
| `ops/delegation-helper`  | Task delegation routing                          |
| `MemorySync`           | P2P memory synchronisation via Hyperswarm          |

## Core Architecture

PluresLM is a **dual-purpose memory system**:
1. **OpenClaw Plugin**: Auto-recall/capture with hooks integration
2. **Reusable Library**: Import `PluresDBBackend`, `TopicIndex`, and types

### Connecting the layers

```ts
// Production wiring
const db = new PluresDBBackend(dbPath, vectorDimension);
const topicIndex = new TopicIndex(db.getStore());   // engine primitives only
const memoryApi = new MemoryAPI(db, embedFn);       // full memory backend
```

### Topic Directory / Index

`TopicIndex` is the org-memory topic directory introduced alongside the
product-boundary refactor.  It provides:

- **Hierarchical topic taxonomy** — topics form a parent/child tree
  derived automatically from embedding similarity.
- **Entry indexing** — any entry (memory ID, document ID, …) can be
  indexed under the most semantically similar topic.
- **Pure engine dependency** — depends only on `PluresStore`; never
  imports `MemoryEntry` or other application types.
- **`topic:` namespace** — persists in the shared store under a separate
  key prefix so topic and memory data never collide.

## Memory Schema

Memory entries are stored in PluresDB under the `memory:` key prefix:

```
memory:<uuid>  →  { content, vector, created_at, source, tags, category, priority, … }
edge:<uuid>    →  { from_id, to_id, relation, created_at }
profile:user_profile  →  { summary, facts, updated_at, capture_count }
topic:<uuid>   →  { label, embedding, entryIds, parentTopicId, … }
```

**Memory categories:**
- `preference`: User likes/dislikes
- `decision`: Choices made
- `entity`: People, places, things
- `project`: Work context
- `explicit`: User-requested storage
- `conversation`: Dialog snippets
- `code-pattern`: Function/type/module patterns
- `error-fix`: Error → solution pairs
- `work-in-progress`: Active tasks
- `document`: Ingested document metadata
- `document-chunk`: Semantic chunk of an ingested document

## Embeddings Strategy

**Primary:** OllamaEmbeddings or DualEmbeddings (OpenAI + Ollama)
**Fallback:** PluresDB native fastembed auto-embedding (BAAI/bge-small-en-v1.5)

**Rationale:**
- Local-first: all embeddings can run offline
- Dual provider: OpenAI quality with Ollama fallback
- Native embeddings: zero-config path when no external provider is available

## Auto-Capture Intelligence

**Code Pattern Extraction:**
- Markdown code blocks → extract functions, types, classes
- Classify as: `code-pattern`, `type-definition`, `module-composition`, `api-pattern`
- Link related patterns via graph edges

**Error-Fix Pairs:**
- Detect error descriptions in conversation
- Link to subsequent solutions via `fixed-by` edges
- Boost recall for similar error patterns

**Work-in-Progress Detection:**
- Keywords: "working on", "TODO", "need to", "planning"
- Category: `work-in-progress`
- Higher recall weight for active context

## Design Decisions

### Why a strict PluresDB / pluresLM boundary?

1. **Separation of concerns**: the CRDT/vector/procedure engine evolves
   independently from the memory schema.
2. **Testability**: `TopicIndex` and other application-layer services can
   be tested with a lightweight in-memory store stub — no native binary
   needed.
3. **Future-proofing**: the memory schema and topic taxonomy can be changed
   without touching the engine.

### Why Async-First Interface?

PluresDB requires async operations for CRDT consistency. Making the entire
interface async:
- Enables seamless backend switching
- Future-proofs for other async backends
- Simplifies error handling patterns

### Memory Deduplication

**Threshold:** 0.95 cosine similarity
**Strategy:** Update existing memory rather than create duplicate
**Rationale:** Prevents memory bloat from repetitive conversations

## Performance Considerations

**Vector Search:**
- PluresDB: HNSW indexing for O(log n) approximate nearest-neighbour search

**Memory Footprint:**
- Embeddings stored as Float64Array
- Automatic cleanup of orphaned memories
- Configurable retention policies

**Plugin Integration:**
- Lazy loading: only embed when needed
- Batch operations: group related memories
- Graceful degradation: continue if embeddings fail

## Security Model

**Local-First:** All data stays on user machine by default
**P2P Sync:** Opt-in via Hyperswarm keys
**Privacy:** No cloud dependencies for core functionality
**Encryption:** PluresDB handles sync encryption automatically

## Testing Strategy

**Unit Tests:** Core memory operations, embedding fallbacks, topic indexing
**Boundary Tests:** `test/unit/boundary.test.ts` verifies that `PluresStore`
contains no memory-app types and that `TopicIndex` depends only on
`PluresStore`.
**Integration Tests:** OpenClaw plugin hooks, multi-backend scenarios
**Performance Tests:** Large memory corpus, vector search benchmarks
**Migration Tests:** Data integrity verification