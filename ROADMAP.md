# PluresLM roadmap

This is the public product direction, not a dated version promise.
Current source lives in private Praxis Platform; this repository owns public
documentation, support, and verified installer publication.

## Present implementation

- One broker owns each store; service-only MCP clients share scoped access.
- Durable recall/capture with provenance, lineage, expiry and history.
- Transient PX evaluation separate from conversational memory.
- Opt-in managed policy revisions, pinned bundles, activation and receipts.
- Host-prepared working memory and exact-commit verification obligations.
- Capability-gated bounded procedures with trusted host bindings and receipts.
- Windows x64 MSI and Linux x64 DEB/RPM build/lifecycle gates.

These are implementation boundaries, not universal host-support or public
release claims. See [capabilities](docs/CAPABILITIES.md).

## First distribution milestone

- Complete reviewed private-build/public-publisher rollout.
- Rehearse verification-only dispatch with an eligible tagged source build.
- Confirm credentials, approval, complete assets and public browser downloads.
- Publish the first version-specific installer notes, checksums and limitations.
- Resolve release-required CI, licensing and distribution review before release.

At this documentation baseline no product installer assets have been published.
Do not mark this milestone complete because a PR artifact or source tag exists.

## Unified installation experience

- One installer per supported OS/architecture; Windows first.
- Optional, explicitly selected harness integrations of the same broker.
- Tested discovery/configuration without silently overwriting existing hosts.
- Safe migration from legacy Scout owners with data/credential preservation.
- Installed upgrade, rollback/recovery and fresh-session host acceptance evidence.
- Establish signing and distribution trust beyond unsigned checksum-verified payloads.

The current MSI supplies a broker and service-only client configuration, not
automatic installation of every adapter. Legacy Scout ZIPs remain compatibility
distributions rather than another PluresLM product line.

## Host integration and platform expansion

Prove actual before-turn/model-request consumption and pre-action enforcement
separately for each host. Keep task attestation and policy/procedure management
least-privileged. Add macOS, ARM64, other Linux compatibility and remote/mobile
clients only with native runtime, lifecycle, trust and migration evidence.
No ship dates or universal cross-platform support are implied.

## Historical plans

The former [OASIS roadmap](docs/LEGACY-OASIS-ROADMAP.md) and
[technical roadmap](docs/ROADMAP.md) remain historical evidence, not current
version commitments.
