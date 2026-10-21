# PLURESLM MCP Client Profiles

> Historical profile design. Use [integrations](../INTEGRATIONS.md) for the
> current service-only client and installer defaults. A profile never expands
> an owner's issued capability.

## 1) Purpose

Defines concrete profile presets for MCP clients:
- OpenClaw
- Codex
- Claude Code

Profiles map client behavior to service policy and effective configuration.

---

## 2) Profile design principles

- Keep secrets and storage topology server-controlled.
- Let clients request behavior-level tuning within safe bounds.
- Prefer deterministic defaults per client to reduce prompt-level drift.
- Support both shared DB and per-client isolation.

---

## 3) Common client identity contract

Each client registration must provide:
- `clientId`: stable unique identifier (e.g., `openclaw-desktop`, `codex-kbh9flow`)
- `profile`: one of `openclaw`, `codex`, `claude-code`
- optional `tenantModeHint`: `shared` or `isolated` (server may ignore)

---

## 4) Preset: OpenClaw

## Intended usage
Primary assistant runtime with auto-recall and auto-capture enabled.

## Recommended defaults
```json
{
  "profile": "openclaw",
  "defaults": {
    "autoRecall": true,
    "autoCapture": true,
    "maxRecallResults": 12,
    "sessionStartRecall": {
      "enabled": true,
      "maxMemories": 20,
      "priorityCategories": ["decision", "preference", "explicit", "work-in-progress"],
      "recencyBias": 0.7
    },
    "projectIndexOnStart": false,
    "projectIndexGlobs": ["**/README.md", "**/docs/**/*.md", "**/src/types/**/*.ts"],
    "patternsWatch": true,
    "autoLinkOnStore": true,
    "autoLinkAlgorithms": ["semantic", "category"],
    "maxAutoLinkDepth": 2
  }
}
```

## Override policy
- Allowed (bounded): recall/capture tuning, indexing paths/globs, sessionStartRecall settings.
- Denied: `dbPath`, secrets, provider endpoints, debug in production profile.

---

## 5) Preset: Codex

## Intended usage
Code-focused client with low side effects and predictable context cost.

## Recommended defaults
```json
{
  "profile": "codex",
  "defaults": {
    "autoRecall": true,
    "autoCapture": false,
    "maxRecallResults": 8,
    "sessionStartRecall": {
      "enabled": true,
      "maxMemories": 10,
      "priorityCategories": ["decision", "work-in-progress", "error-fix"],
      "recencyBias": 0.6
    },
    "projectIndexOnStart": false,
    "patternsWatch": false,
    "autoLinkOnStore": false,
    "maxAutoLinkDepth": 1,
    "captureQuality": {
      "minContentLength": 120,
      "maxCapturesPerTurn": 2,
      "dedupeThreshold": 0.9
    }
  }
}
```

## Override policy
- Allowed (bounded): `maxRecallResults`, selected project paths, sessionStartRecall limits.
- Denied/forced: `autoCapture` (forced false), patterns watch, debug, storage/secrets.

---

## 6) Preset: Claude Code

## Intended usage
Long-running coding workflows with stronger memory continuity than Codex but controlled indexing.

## Recommended defaults
```json
{
  "profile": "claude-code",
  "defaults": {
    "autoRecall": true,
    "autoCapture": true,
    "maxRecallResults": 10,
    "sessionStartRecall": {
      "enabled": true,
      "maxMemories": 15,
      "priorityCategories": ["decision", "work-in-progress", "code-pattern", "error-fix"],
      "recencyBias": 0.65
    },
    "projectIndexOnStart": true,
    "projectIndexGlobs": ["**/README.md", "**/docs/**/*.md", "**/src/**/*.ts", "**/src/**/*.py"],
    "patternsWatch": true,
    "autoLinkOnStore": true,
    "autoLinkAlgorithms": ["semantic", "category"],
    "captureQuality": {
      "minContentLength": 80,
      "maxCapturesPerTurn": 4,
      "dedupeThreshold": 0.87
    }
  }
}
```

## Override policy
- Allowed (bounded): capture quality thresholds, recall limits, project paths under allowed roots.
- Denied: secret fields, db topology, disallowed globs, debug in hardened mode.

---

## 7) MCP registration examples

## 7.1 OpenClaw plugin entry (service-backed)
```json
{
  "plugins": {
    "entries": {
      "pluresLM": {
        "enabled": true,
        "config": {
          "agentId": "openclaw-desktop",
          "agentName": "OpenClaw Desktop",
          "profile": "openclaw"
        }
      }
    }
  }
}
```

## 7.2 Codex MCP command (Docker)
```json
{
  "mcpServers": {
    "plureslm": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "PLURESLM_CLIENT_ID=codex-kbh9flow",
        "-e", "PLURESLM_PROFILE=codex",
        "-v", "plureslm_data:/data",
        "ghcr.io/plures/plureslm-service:latest"
      ]
    }
  }
}
```

## 7.3 Claude Code MCP command (local binary)
```json
{
  "mcpServers": {
    "plureslm": {
      "command": "plureslm-service",
      "env": {
        "PLURESLM_CLIENT_ID": "claude-code-main",
        "PLURESLM_PROFILE": "claude-code"
      }
    }
  }
}
```

---

## 8) Shared vs isolated tenancy profile mapping

Suggested defaults:
- `openclaw`: shared
- `codex`: isolated optional (enable when experimentation/noise is high)
- `claude-code`: shared by default, isolated for enterprise/repo-separated workflows

Server override example:
```json
{
  "storage": {
    "tenancyMode": "hybrid",
    "isolationClients": ["codex-kbh9flow", "claude-code-enterprise"]
  }
}
```

---

## 9) Phased rollout

## Phase 1: Baseline profile onboarding
- Ship openclaw/codex/claude-code presets and docs.
- Provide static registration snippets.

Acceptance criteria:
- Each client connects successfully using one documented snippet.
- Effective config resolves without policy errors using default settings.

## Phase 2: Policy tightening
- Enforce bounded overrides and startup-scan constraints.

Acceptance criteria:
- Invalid client overrides are denied/clamped with explicit reason codes.
- No client can override secrets/storage fields.

## Phase 3: Tenancy optimization
- Enable hybrid mode and isolate selected noisy/sensitive clients.

Acceptance criteria:
- Isolation verified by no cross-tenant query visibility.
- Shared clients retain expected recall quality and latency.

## Phase 4: Discovery automation
- Add discovery file/helper output for client auto-registration.

Acceptance criteria:
- Generated registration artifacts are valid for all three profiles.
