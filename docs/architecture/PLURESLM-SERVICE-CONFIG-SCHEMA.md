# PLURESLM Service Config Schema Proposal

## 1) Purpose

This schema defines how a central pluresLM service accepts configuration from:
- operator/server config,
- client profile defaults,
- per-client requested overrides.

It explicitly marks each field as:
- **server-only**,
- **client-requested (bounded)**,
- **denied/ignored when policy forbids**.

It covers all current plugin settings from `openclaw.plugin.json`.

---

## 2) Effective config resolution model

Resolution order:
1. Server static config (`service.config.json`)
2. Server env/secret sources
3. Profile defaults (`profiles.<name>.defaults`)
4. Client-requested overrides (`request.config`), bounded by policy
5. Built-in defaults

Output:
- `effectiveConfig`: final applied config (secrets redacted)
- `policyDecisions[]`: allow/deny/clamp records

---

## 3) Proposed service config structure (authoritative)

```json
{
  "$schema": "https://plures.dev/schemas/plureslm-service-config.v1.json",
  "version": 1,
  "service": {
    "mode": "single-host",
    "listen": {
      "transport": ["stdio"],
      "http": { "enabled": false, "host": "127.0.0.1", "port": 7766 }
    },
    "logging": {
      "level": "info",
      "auditPolicyDecisions": true,
      "redactSecrets": true
    }
  },
  "storage": {
    "tenancyMode": "shared",
    "sharedDbPath": "~/.openclaw/pluresLM-store",
    "perClientPathTemplate": "~/.openclaw/pluresLM-store/tenants/{clientId}",
    "isolationClients": []
  },
  "policy": {
    "profileMode": "balanced",
    "allowedEmbeddingProviders": ["transformers", "ollama"],
    "allowedEmbeddingModels": ["text-embedding-3-small", "nomic-embed-text"],
    "numericBounds": {
      "maxRecallResults": { "min": 1, "max": 50 },
      "profileFrequency": { "min": 1, "max": 1000 },
      "dedupeThreshold": { "min": 0.5, "max": 0.99 },
      "sessionStartRecall.maxMemories": { "min": 1, "max": 100 },
      "sessionStartRecall.recencyBias": { "min": 0.0, "max": 1.0 },
      "captureQuality.minContentLength": { "min": 1, "max": 10000 },
      "captureQuality.maxCapturesPerTurn": { "min": 1, "max": 50 },
      "captureQuality.dedupeThreshold": { "min": 0.5, "max": 0.99 },
      "maxAutoLinkDepth": { "min": 1, "max": 6 },
      "autoLinkThresholds.semantic": { "min": 0.0, "max": 1.0 },
      "autoLinkThresholds.category": { "min": 0.0, "max": 1.0 },
      "autoLinkThresholds.temporal": { "min": 0.0, "max": 1.0 }
    },
    "startupScan": {
      "allowClientIndexOnStart": true,
      "allowedRoots": ["~/projects", "~/.openclaw/workspace"],
      "blockedGlobs": ["**/.git/**", "**/node_modules/**", "**/.env*", "**/dist/**"],
      "maxPathsPerClient": 8,
      "maxFilesPerScan": 10000,
      "maxTotalBytesPerScan": 536870912
    }
  },
  "profiles": {
    "openclaw": { "defaults": {}, "allowOverrides": {} },
    "codex": { "defaults": {}, "allowOverrides": {} },
    "claude-code": { "defaults": {}, "allowOverrides": {} }
  },
  "secrets": {
    "openaiApiKey": { "source": "env", "env": "OPENAI_API_KEY" },
    "syncKey": { "source": "env", "env": "PLURESLM_SYNC_KEY" }
  }
}
```

---

## 4) Field policy matrix (all current plugin settings)

Legend:
- **Class**: `server-only` | `client-requested (bounded)`
- **When policy forbids**: `deny` (error) or `ignore` (drop and continue)

| Field | Type | Class | Bounds / constraints | When policy forbids |
|---|---|---|---|---|
| `dbPath` | string | server-only | path resolved by storage policy | ignore client value |
| `embeddingProvider` | enum | server-only or bounded | allowlist: transformers/ollama | deny |
| `embeddingModel` | string | client-requested (bounded) | regex/list allowlist | deny |
| `transformersModel` | string | client-requested (bounded) | allowlist/regex | deny |
| `openaiApiKey` | string(secret) | server-only | env/secret-source only | ignore |
| `embeddingDimension` | number | server-only | fixed by provider/model compatibility | ignore |
| `ollamaModel` | string | client-requested (bounded) | allowlist/regex | deny |
| `ollamaEndpoint` | string | server-only | optional allowlist of endpoints | ignore |
| `ollamaFallbackEndpoint` | string | server-only | optional allowlist of endpoints | ignore |
| `autoRecall` | boolean | client-requested (bounded) | may be forced true/false per profile | deny or clamp to forced value |
| `autoCapture` | boolean | client-requested (bounded) | may be forced true/false per profile | deny or clamp to forced value |
| `maxRecallResults` | number | client-requested (bounded) | clamp to policy numeric bounds | clamp |
| `profileFrequency` | number | client-requested (bounded) | clamp to policy numeric bounds | clamp |
| `dedupeThreshold` | number | client-requested (bounded) | clamp 0.5-0.99 | clamp |
| `debug` | boolean | server-only | default false in prod | ignore |
| `projectContextPaths` | string[] | client-requested (bounded) | allowed roots + max paths | deny invalid entries, keep valid |
| `projectIndexOnStart` | boolean | client-requested (bounded) | allowed only if profile permits | clamp false or deny |
| `projectIndexGlobs` | string[] | client-requested (bounded) | filtered through blocked globs + size limits | strip denied globs |
| `syncEnabled` | boolean | server-only or bounded | usually server-controlled | clamp to policy |
| `syncKey` | string(secret) | server-only | env/secret-source only | ignore |
| `agentId` | string | client-requested (bounded) | length/charset constraints | deny invalid |
| `agentName` | string | client-requested (bounded) | length constraints | deny invalid |
| `sessionStartRecall.enabled` | boolean | client-requested (bounded) | may be forced by profile | clamp |
| `sessionStartRecall.maxMemories` | number | client-requested (bounded) | clamp to 1..100 (policy-defined) | clamp |
| `sessionStartRecall.priorityCategories` | string[] | client-requested (bounded) | intersect with allowed categories | strip disallowed values |
| `sessionStartRecall.recencyBias` | number | client-requested (bounded) | clamp 0..1 | clamp |
| `patternsDirs` | string[] | client-requested (bounded) or server-only | allowlisted roots only | deny invalid entries |
| `patternsWatch` | boolean | client-requested (bounded) | can be forced off in hardened mode | clamp |
| `autoLinkOnStore` | boolean | client-requested (bounded) | can be forced off per performance profile | clamp |
| `autoLinkAlgorithms` | enum[] | client-requested (bounded) | subset of semantic/category/temporal | strip invalid values |
| `autoLinkThresholds.semantic` | number | client-requested (bounded) | clamp 0..1 | clamp |
| `autoLinkThresholds.category` | number | client-requested (bounded) | clamp 0..1 | clamp |
| `autoLinkThresholds.temporal` | number | client-requested (bounded) | clamp 0..1 | clamp |
| `maxAutoLinkDepth` | number | client-requested (bounded) | clamp 1..6 (example) | clamp |
| `captureQuality.minContentLength` | number | client-requested (bounded) | clamp policy range | clamp |
| `captureQuality.maxCapturesPerTurn` | number | client-requested (bounded) | clamp policy range | clamp |
| `captureQuality.dedupeThreshold` | number | client-requested (bounded) | clamp 0.5..0.99 | clamp |

---

## 5) Profile override policy map (example)

```json
{
  "profiles": {
    "openclaw": {
      "allowOverrides": {
        "autoRecall": true,
        "autoCapture": true,
        "maxRecallResults": true,
        "projectIndexOnStart": true,
        "projectContextPaths": true,
        "projectIndexGlobs": true,
        "sessionStartRecall.*": true,
        "captureQuality.*": true,
        "debug": false,
        "dbPath": false,
        "openaiApiKey": false,
        "syncKey": false
      }
    },
    "codex": {
      "allowOverrides": {
        "autoRecall": true,
        "autoCapture": false,
        "projectIndexOnStart": false,
        "projectContextPaths": true,
        "projectIndexGlobs": true,
        "sessionStartRecall.*": true,
        "captureQuality.*": false,
        "debug": false,
        "dbPath": false,
        "openaiApiKey": false,
        "syncKey": false
      }
    }
  }
}
```

---

## 6) Validation and enforcement algorithm

1. Identify client (`clientId`, `profile`).
2. Load profile defaults and override permissions.
3. Merge request into candidate config.
4. For each field:
   - deny/ignore if server-only,
   - validate type,
   - apply bounds/clamps,
   - apply path/glob policy checks.
5. Resolve secrets from env/secret source.
6. Emit `effectiveConfig` and `policyDecisions[]`.

Policy decisions record format:
```json
{
  "field": "projectContextPaths[1]",
  "action": "deny",
  "reason": "path-outside-allowed-root",
  "clientId": "codex-local",
  "profile": "codex"
}
```

---

## 7) Phased execution and acceptance criteria

## Phase A: Schema freeze
- Publish v1 schema and policy matrix.
- Add compatibility notes with existing `openclaw.plugin.json`.

Acceptance:
- Every plugin field appears in matrix.
- No ambiguous ownership (server vs client) remains.

## Phase B: Effective config engine
- Implement merge + validation + policy decision records.

Acceptance:
- Golden tests for allow/deny/clamp behavior.
- Redaction tests for secret fields.

## Phase C: Client profile integration
- Apply profile presets for OpenClaw/Codex/Claude Code.

Acceptance:
- Each profile has deterministic effective config from same input request.

## Phase D: Audit and operator UX
- Surface policy decision logs and effective config inspection.

Acceptance:
- Operator can explain why each denied/ignored field occurred.
