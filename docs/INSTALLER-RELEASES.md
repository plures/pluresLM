# Verified PluresLM installer releases

## Setup

1. In this public repository, create the `plureslm-release` environment.
   Require your release reviewer and allow deployment from branch `main`.
   Preventing administrator bypass is optional hardening, not a prerequisite.
   Self-review may remain enabled if the initiating maintainer is the reviewer.
2. Add environment secret `PRAXIS_PLATFORM_ARTIFACT_READ_TOKEN`: a fine-grained
   token owned by `plures`, scoped only to `praxis-platform`, with Actions read
   and Contents read. Obtain org approval where required and track expiration.
3. In private `praxis-platform`, add repository Actions secret
   `PLURESLM_RELEASE_NOTIFY_TOKEN`: a separate fine-grained token scoped only
   to public `pluresLM`, Contents read/write, used for repository dispatch.
   Do not paste either token into a chat, source file, issue or log.
4. Merge the public publisher and its checks before merging the private
   notification workflow. Both repositories' normal review/CI rules apply.
   Do not enable a private unprotected release environment or weaken checks.
5. Prepare an approved component version in private platform `main` and a
   matching `plureslm-vVERSION` source tag. Do not manually reuse or move a
   published version. Manifests and lockfile versions must agree.

## Operation

A tagged private package workflow builds Windows MSI and Linux DEB/RPM plus
supplemental developer tarballs. The existing full build, memory/PX, offline
install/start/restart/stop/uninstall gates remain required. Its final job
verifies the assets and sends a `plureslm-release-candidate` dispatch containing
only the version tag, source SHA and run ID. No raw source or build logs are sent.

The public workflow runs trusted code from `main` under environment approval.
Approve it under **Actions / Publish verified PluresLM installers**. It waits
up to five minutes for the notifying source run to close successfully, then
independently verifies:

- the exact same-repository workflow ID/path, successful tag push or tagged
  manual dispatch, run ID, source SHA and current peeled source tag;
- source ancestry in private `main` and matching component manifests;
- exactly one unexpired Windows and Linux artifact for that source and run;
- GitHub's artifact ZIP digest, flat filename allowlist and all fifteen files;
- payload SHA-256, exact source/run/version metadata, bundled-runtime,
  offline-install and native installed-lifecycle evidence;
- required-reviewer environment configuration and absence of an existing
  public release or tag.

The checked-in [PX constraint](../.github/release/publication.px) is evaluated
at the publication boundary with those authenticated observations. The
dependency-free adapter supports only that contract's closed boolean
conjunction grammar and rejects unsupported syntax or missing observations;
it is not a general-purpose PX interpreter or live shared-service registration.

The publisher executes no downloaded code, checks out no private source,
installs no npm dependencies, and uses public `GITHUB_TOKEN` only to upload
the complete draft and then publish it. GitHub environment approval is the
authorization boundary; the script's configuration check alone does not prove
an approval occurred, and an administrator bypass remains an explicit bypass.

The public distribution tag points at the public publisher commit, not the
private source commit. Exact private source/run identity is in the release
metadata; private URLs may require source access. The installer payload,
checksums and metadata are deliberately made public after approval.
Raw Actions artifacts are temporary seven-day transfer objects, not downloads.

## Verification and recovery

Manual dispatch supports `tag`, `source_sha`, `run_id`, and `verify_only`.
Keep `verify_only=true` for a real candidate rehearsal: it performs the same
checks and approval but creates no tag/release. After verification, an approved
dispatch with `verify_only=false` publishes. A branch/PR source run is rejected.
The public workflow itself must always run on public `main`.

Automatic dispatches publish after approval. No registry upload, rebuild,
private canonical release or separate harness release is performed.
Prerelease versions are marked prerelease and do not replace stable latest.
The historical source-package release workflow no longer runs on pushes or
tags; it requires an explicit `publish_legacy_source` manual opt-in. Publishing
an installer tag must not publish the retained historical package to npm.

API failures, expired/missing artifacts, wrong source/tag, incomplete evidence,
and tag/release collisions are errors, not success-shaped skips. A partial
upload can leave a draft; inspect it before deliberate operator recovery.
Never overwrite assets or move a tag to hide a partial release. Notifications
are serialized; GitHub can supersede pending runs, so recover a superseded
notification by manually dispatching its exact candidate. Approve within the
seven-day artifact lifetime or build a fresh eligible candidate.

To download, use [Releases](https://github.com/plures/pluresLM/releases).
Windows users install the MSI, not GitHub's automatically generated source ZIP.
MSI/DEB/RPM are initially unsigned. Optional harness configuration and legacy
Scout data migration remain separate implementation and upgrade-test gates.
