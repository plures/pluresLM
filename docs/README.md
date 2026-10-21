# PluresLM documentation

## Users and operators

| Guide | Use it for |
| --- | --- |
| [Installation](INSTALLATION.md) | Release status, Windows MSI, Linux packages, first start and checksum verification |
| [Integrations](INTEGRATIONS.md) | Service-only MCP, host-specific format differences, permissions and fresh-session acceptance |
| [Capabilities](CAPABILITIES.md) | Memory provenance, PX, managed policy, working memory and procedures |
| [Architecture](ARCHITECTURE.md) | Ownership, data flow, isolation and trust boundaries |
| [Operations](OPERATIONS.md) | Status, restart, upgrade, retained data, failures and legacy migration |
| [Release publishing](INSTALLER-RELEASES.md) | Private CI/public approval handoff, credentials, verification and recovery |
| [Roadmap](../ROADMAP.md) | Current priorities and what is not yet supported |
| [Contributing](../CONTRIBUTING.md) | Source ownership, support reports and safe disclosures |

These guides stand alone for public readers. They describe the canonical
platform implementation, not the old source package retained in this repo.
Installed behavior is bound to the version and notes of the downloaded release.
The publisher is under review in
[PR #186](https://github.com/plures/pluresLM/pull/186); do not mistake a
workflow implementation for a completed public release.

## Historical designs and compatibility references

The following files are retained to explain prior decisions, not as current
installer instructions or proof that all features were delivered:

- [Old OpenClaw README](LEGACY-OPENCLAW.md)
- [Old OASIS roadmap](LEGACY-OASIS-ROADMAP.md)
- [Design](DESIGN.md), [graph DSL](GRAPH_DSL.md),
  [procedure experiments](PROCEDURES.md), [file-based migration](MIGRATION.md)
- [Database directory override](database-directory-override.md)
- [Former roadmap](ROADMAP.md)
- [Distribution/service plan](architecture/PLURESLM-DISTRIBUTION-AND-SERVICE-PLAN.md)
- [MCP client profiles](architecture/PLURESLM-MCP-CLIENT-PROFILES.md)
- [MCP contract](architecture/PLURESLM-MCP-CONTRACT.md)
- [Service configuration proposal](architecture/PLURESLM-SERVICE-CONFIG-SCHEMA.md)
- [Single-owner ADR](decisions/ADR-0001-plureslm-single-store-owner-boundary.md):
  the ownership principle remains relevant; implementation details are versioned.

## Documentation principles

- Say whether a feature is implemented, enabled, host-verified, or merely planned.
- Do not substitute CI artifacts or source archives for public installer assets.
- Never present MCP tools as automatic lifecycle integration.
- Preserve memory, credentials and prior evidence during migration.
- Keep private source links supplemental, not the only explanation available.
