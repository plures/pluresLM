# PluresLM Roadmap

## Role in OASIS
PluresLM is the **OpenClaw memory plugin** that turns OASIS agents into long‑term, local‑first collaborators. It wires assistants to pluresLM‑mcp so OASIS workflows can recall private context, enforce privacy boundaries, and orchestrate multi‑agent commerce without leaking data to centralized services.

## Current State
Plugin v2.x is stable with tool registration, auto‑recall/auto‑capture hooks, and YAML pattern dispatch. Gaps are around resilience when the daemon restarts, capture quality tuning, and higher‑level recall intelligence for OASIS task flows.

## Roadmap

### Phase 1 — Reliability & Trust (v2.5)
- Session recovery across MCP daemon restarts without losing context.
- Clear user‑facing error states when the daemon is unavailable.
- Auto‑capture quality gates (noise suppression + confidence scoring).
- Pattern engine flexibility for operational policies (YAML schema + validation).
- Health checks for persistent connectivity and degraded‑mode behavior.

### Phase 2 — OASIS Recall Intelligence (v3.0)
- Context‑aware recall tuned for commerce workflows (projects vs. personal, task vs. chat).
- Memory importance learning from user corrections and re‑use frequency.
- Conversation summarization into durable “deal memory” facts.
- Cross‑session context carry‑over with safe scoping.

### Phase 3 — Multi‑Surface Capture (v3.1)
- pluresLM‑mobile integration for phone‑based capture nodes.
- Browser capture for web commerce context.
- Desktop widget for fast memory search during OASIS workflows.
- Voice + image capture (Whisper/OCR) for real‑world context.

### Phase 4 — Shared Commerce Memory (v4.0)
- P2P shared memories with permissions and provenance.
- Merge assistant for conflicting memories across agents.
- Export/import for backup and migration between OASIS installations.
