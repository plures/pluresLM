# pluresLM Roadmap

## Role in Plures Ecosystem
pluresLM is the OpenClaw plugin that wires assistants to the pluresLM‑mcp memory service. It registers tools, injects recall before turns, and captures durable memories after turns.

## Current State
A thin adapter exists with HTTP MCP client, tool registration, auto‑recall/capture hooks, compaction snapshots, and a YAML pattern engine. The plugin intentionally does not manage storage or embeddings. Gaps are around hook stability across OpenClaw versions, better capture heuristics, and project indexing ergonomics.

## Milestones

### Near-term (Q2 2026)
- Stabilize hook lifecycle contracts (pre‑turn recall, post‑turn capture, compaction).
- Refine auto‑capture quality gates (noise suppression + confidence scoring).
- Improve error handling and diagnostics for MCP connectivity issues.
- Document recommended patterns for memory categories and tagging.

### Mid-term (Q3-Q4 2026)
- Project indexing workflows with incremental refresh and ignore files.
- Multi‑session memory context bridging (agentId/sessionStartRecall defaults).
- Pattern engine tooling: validation, linting, and hot‑reload safety.
- Optional local caching for offline resilience when MCP is unavailable.

### Long-term
- Unified memory UX across OpenClaw tools and UI surfaces.
- Cross‑agent recall policies (shared memory scopes and permissions).
- Automated schema evolution for stored memories and task objects.
