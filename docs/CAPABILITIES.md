# Memory, policy, and executable knowledge

[Documentation index](README.md) | [Trust boundaries](ARCHITECTURE.md)

These capabilities describe the current canonical service implementation.
A published installer's exact behavior is determined by its source version.
Implemented, enabled by default, and proven in a specific host are different
claims. Advanced owner capabilities are not automatically granted by the MSI.

## Durable memory

The service-only bridge exposes `plureslm_store`, `plureslm_search`,
`plureslm_get`, `plureslm_memory_history`, `plureslm_status`, and `plureslm_sync`.
Use text recall when deterministic keyword matching is needed; semantic recall
depends on the configured native embedding/runtime path.

Memory can represent user decisions, model inferences, observations,
imported conversations or legacy unknown records. Capture can include:

- `recordType` to distinguish evidence from inference;
- `sourceRef` for origin and supporting context;
- `observedAt` and `verifiedAt` epoch-millisecond timestamps;
- `supersedes` to retain lineage while replacing an active assertion;
- `expiresAt` for bounded relevance.

`verifiedAt` is a caller claim, not trusted external verification. Normal recall
omits expired and superseded records and down-ranks imported conversations.
History access exposes retained lineage; consolidation proposes auditable
relationships rather than deleting original evidence.

Memory rights are bounded by the caller's capability. Project routing derives
partitions in the owner; do not send both `project` and `space`. Unified/split
profiles affect sharing, but matching a project identifier never expands an
issued capability. Status can describe the resolved route without exposing
credentials or database paths.

## Transient PX evaluation

`plureslm_px_evaluate` evaluates actual caller-supplied constraint source
against an action context:

```json
{
  "source": "constraint amount_cap:\n  require: amount <= 10\n  severity: error\n",
  "context": {
    "action_type": "validate",
    "target": "example",
    "session_type": "main",
    "metadata": { "amount": 12 }
  }
}
```

The proposed amount violates this example constraint. Source and serialized
context are each bounded to 64 KiB in the service contract. The response
reports evaluated constraints, violations, and `passed`.

Invalid source, rejected credentials and unavailable service are errors,
not permission to continue. The evaluator uses transient state separate from
conversational memory. It does not persist the submitted constraints, execute
submitted procedures, grant authority, or automatically block an agent's tools.
The agent/host must enforce the relevant decision at an actual action boundary.

## Managed policies

Owner-authorized clients can create immutable policy revisions, explicitly
activate or retire them, and compose bundles pinned to exact member revisions.
Historical simulation and durable evaluation receipts require additional rights.
Policy data is separate from conversational memory, under the same owner.

Bridge tools include:

- `plureslm_policy_list`, `plureslm_policy_get`, `plureslm_policy_create`;
- `plureslm_policy_revise`, `plureslm_policy_activate`, `plureslm_policy_retire`;
- `plureslm_policy_evaluate`, `plureslm_policy_bundle_create`,
  `plureslm_policy_bundle_evaluate`, `plureslm_policy_receipts`.

Owner capabilities are separately named `policy.read`, `policy.write`,
`policy.activate`, `policy.evaluate`, `policy.simulate`, and `policy.audit`.
Policy scope defaults to the client ID. Shared libraries need an explicitly
shared operator-assigned scope; memory sharing alone does not share policies.
The default installer MCP client is not a policy administrator.

## Reactive working memory and verification obligations

The host API can prepare bounded context from scoped memory, unresolved
verification obligations, and optionally an active managed policy bundle.
The context packet is bounded to 16 KiB. This is a host-before-turn path,
not an extra model-issued tool requirement.

Tasks and evidence can be bound to an exact Git commit and required build
targets. Completion stays pending until authorized evidence covers the
required successful targets for that exact commit.

| Right | Intended holder |
| --- | --- |
| `context.prepare` | Context-reading client; included in the native installer's default MCP capability |
| `task.write` | Authorized host task-registration adapter |
| `task.attest` | Separately trusted CI/evidence adapter, not an ordinary model client |

The host must consume the packet in its real model request and separately
enforce pre-action decisions. The Scout reactive path is opt-in; adapter output
does not prove the host's model consumer inserted it. There is no implied CI
webhook registration, automatic policy activation, or universal host support.

## Host-bound procedures

`plureslm_procedure` provides capability-gated registration, test, promotion,
execution and receipt access. Procedure revisions and actor descriptions are
immutable and pinned to host binding revisions and supporting memory.

The initial `bounded-sequence-v1` profile accepts typed parameters, `define`,
host `call`, and a final `return`. It rejects arbitrary code blocks, loops,
branching, queues, unknown actions, stale bindings and replay mismatches.
A matching successful test receipt and explicit promotion are required before
production `run`.

The trusted owner supplies in-process bindings and independently authorizes
each invocation. A stored memory, policy, procedure registration or actor
description is not an execution grant. Rights such as `procedure.read`,
`procedure.write`, `procedure.test`, `procedure.promote` and `procedure.run`
must be deliberately issued. Attempts leave durable receipts.

This is not a shell runner or a promise that the stock installer contains
your organization's host-binding catalog.

## What is not implied

- Automatic capture of every conversation in every assistant.
- Trusted verification just because a model wrote a timestamp or receipt-like text.
- Encryption at rest, remote access, P2P rollout or backup merely from local storage.
- A managed policy automatically intercepting tool execution.
- Arbitrary PX programs executing through the transient evaluation tool.
- A public source archive containing the canonical runtime source or an installer.
