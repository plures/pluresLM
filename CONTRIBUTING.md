# Contributing and support

## Choose the right surface

Use this public repository for product documentation, release-publisher
improvements, reproducible installation problems, and integration/support
reports. Current runtime implementation belongs to `packages/plureslm` in the
private [Praxis Platform monorepo](https://github.com/plures/praxis-platform).
Ask maintainers for the appropriate source access; do not independently patch
the historical runtime here and imply it changes current installer builds.

Historical public source is retained for provenance and compatibility context,
not two-way synchronization. Public visibility does not change the
[license](LICENSE) or settle bundled-dependency licensing.

## A useful support report

Include the product version/tag, OS/architecture, installer format, host/version,
the operation attempted, expected/actual behavior, and a minimal redacted error.
Say whether the package was a public release or a temporary Actions artifact.
Include the relevant workflow URL for publisher problems.

Do not attach tokens, service configs, database files, memory contents, private
build logs or a whole data-directory backup. Local paths and source references
may also be sensitive. For sensitive security concerns, contact the maintainer
privately through an available GitHub security advisory/reporting channel;
do not disclose exploit details or credentials in a public issue.

## Documentation changes

Keep public user guides self-contained. Private source links may supplement,
not replace, installation, privacy and compatibility explanations.
Differentiate implementation, enabled defaults, CI evidence, host acceptance
and public publication. Do not claim automatic hooks, migration, signing,
policy enforcement or platform support without matching evidence.

Validate Markdown links, relative paths, anchors and example shapes when
editing them. Preserve labeled historical documents instead of silently
rewriting old decisions as current guarantees.

## Publisher changes

Follow the governing Plures development guide and existing branch rules.
Use a branch and reviewed PR; never weaken approval or CI to make a release.
The narrow validation for the publisher is:

```sh
node --test .github/scripts/publish-installers.test.mjs
npm run lint
```

Lint requires the locked development dependencies; restore them with
`npm ci --ignore-scripts` if missing. The publisher itself uses Node built-ins
and runner `gh`/`unzip`, not the historical runtime dependencies. On Windows,
archive tests also need Python and an available `unzip`; CI runs them on Ubuntu.

Keep tokens in GitHub secrets, pin workflow actions, reject untrusted candidate
code and validate exact-source asset identity. Read
[release operation and recovery](docs/INSTALLER-RELEASES.md) before changing
publication. No production tag/release or credential update belongs in a
documentation-only PR.
