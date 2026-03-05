# Plures Local Memory Design

## Core Architecture

pluresLM is designed as a **dual-purpose memory system**:
1. **OpenClaw Plugin**: Auto-recall/capture with hooks integration
2. **Reusable Library**: Import `MemoryAPI`, `PluresDBBackend`, embeddings, and types

### Multi-Backend Strategy

**Current State (v2.0.0):**
- **PluresDB NAPI** (sole supported backend): CRDT sync, native fastembed, graph-native

**Design Philosophy:**
- Single API surface regardless of backend
- Zero-downtime migration path
- Graceful degradation: Ollama fallback if PluresDB embeddings unavailable

### Memory Schema

```
memories: id, content, embedding, created_at, source, tags, category
memory_edges: id, from_id, to_id, relation, created_at  
profile: id, summary, facts, updated_at, capture_count
```

**Categories:**
- `preference`: User likes/dislikes
- `decision`: Choices made
- `entity`: People, places, things
- `project`: Work context
- `explicit`: User-requested storage
- `conversation`: Dialog snippets
- `code-pattern`: Function/type/module patterns
- `error-fix`: Error → solution pairs
- `work-in-progress`: Active tasks
- `document`: Full documents or long-form content
- `document-chunk`: Segments of larger documents for retrieval

### Embeddings Strategy

**Primary:** PluresDB native fastembed (Rust/ONNX via NAPI, auto-embedded on `put()`)
**Optional:** Ollama `nomic-embed-text` (GPU-accelerated, privacy-first alternative)

**Rationale:**
- PluresDB fastembed: Zero-config, same vector space for storage and queries, no external API calls
- Ollama: GPU-accelerated, privacy-first, cost-free alternative

### Auto-Capture Intelligence

**Code Pattern Extraction:**
- Markdown code blocks → extract functions, types, classes
- Classify as: `code-pattern`, `type-definition`, `module-composition`, `api-pattern`
- Link related patterns via edges

**Error-Fix Pairs:**
- Detect error descriptions in conversation
- Link to subsequent solutions via `fixed-by` edges
- Boost recall for similar error patterns

**Work-in-Progress Detection:**
- Keywords: "working on", "TODO", "need to", "planning"
- Category: `work-in-progress`
- Higher recall weight for active context

## Design Decisions

### Why Dual Backends?

1. **Evolution Path**: SQLite → PluresDB without breaking existing setups
2. **Risk Mitigation**: Proven SQLite fallback if PluresDB has issues
3. **Different Use Cases**: Simple local (SQLite) vs. P2P sync (PluresDB)

### Why Async-First Interface?

PluresDB requires async operations for CRDT consistency. Making the entire interface async:
- Enables seamless backend switching
- Future-proofs for other async backends
- Simplifies error handling patterns

### Memory Deduplication

**Threshold:** 0.95 cosine similarity
**Strategy:** Update existing memory rather than create duplicate
**Rationale:** Prevents memory bloat from repetitive conversations

## Future Architecture

### V0.5 Targets

1. **Time Decay**: Older memories gradually lose recall weight
2. **Dashboard CLI**: Memory stats, cleanup, export tools
3. **Hook Fixes**: Resolve OpenClaw plugin kind issues
4. **P2P Sync**: Full Hyperswarm sync integration

### V1.0 Vision

1. **Cross-Instance Sync**: Multiple OpenClaw instances sharing memory
2. **Memory Graphs**: Rich relationship modeling
3. **Advanced Filtering**: Date ranges, source filtering, tag queries
4. **Memory Analytics**: Usage patterns, effectiveness metrics

## Performance Considerations

**Vector Search:**
- SQLite: Custom cosine similarity function
- PluresDB: HNSW indexing for O(log n) search

**Memory Footprint:**
- Embeddings stored as compressed Float64Array
- Automatic cleanup of orphaned memories
- Configurable retention policies

**Plugin Integration:**
- Lazy loading: Only embed when needed
- Batch operations: Group related memories
- Graceful degradation: Continue if embeddings fail

## Security Model

**Local-First:** All data stays on user machine by default
**P2P Sync:** Opt-in via Hyperswarm keys
**Privacy:** No cloud dependencies for core functionality
**Encryption:** PluresDB handles sync encryption automatically

## Testing Strategy

**Unit Tests:** Core memory operations, embedding fallbacks
**Integration Tests:** OpenClaw plugin hooks, multi-backend scenarios
**Performance Tests:** Large memory corpus, vector search benchmarks
**Migration Tests:** SQLite → PluresDB data integrity
