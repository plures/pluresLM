# Superlocalmemory Design

## Core Architecture

Superlocalmemory is designed as a **dual-purpose memory system**:
1. **OpenClaw Plugin**: Auto-recall/capture with hooks integration
2. **Reusable Library**: Import `MemoryAPI`, `PluresDBBackend`, embeddings, and types

### Multi-Backend Strategy

**Current State (v2.0.0):**
- **PluresDB NAPI** (sole backend): CRDT sync, native fastembed vector search, graph-native

**Design Philosophy:**
- Single API surface backed by PluresDB
- Local-first, P2P sync via Hyperswarm
- Extensible embedding providers (PluresDB native fastembed or Ollama)

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

**Primary:** PluresDB native fastembed (Rust/ONNX via NAPI, dimension determined by model)
**Optional:** Ollama (e.g. `snowflake-arctic-embed2`, for GPU-accelerated embeddings)

**Rationale:**
- PluresDB fastembed: zero-copy, same vector space as stored embeddings, no external service
- Ollama: GPU acceleration, custom models, privacy-first alternative

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

### Why PluresDB-Only?

1. **Local-First CRDT**: Native conflict-free sync via Hyperswarm
2. **Native Embeddings**: fastembed runs in-process via NAPI — no external embedding service required
3. **Single Distribution Target**: One binary, no SQLite or external DB runtime deps

### Why Async-First Interface?

PluresDB requires async operations for CRDT consistency. Making the entire interface async:
- Future-proofs for additional async backends
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

**Unit Tests:** Core memory operations, embedding providers
**Integration Tests:** OpenClaw plugin hooks, PluresDB backend scenarios
**Performance Tests:** Large memory corpus, vector search benchmarks