# Specs

This directory holds design documents for proposed work. A spec describes the
problem, the intended behavior, and the checks that must pass. It is not user
documentation. The README and `--help` describe shipped behavior.

Specs are not part of the npm package. The `files` field in `package.json`
includes `bin`, `src`, `README.md`, and `LICENSE`.

## Status

| Status | Meaning |
| --- | --- |
| Idea | The problem is recorded. There is no design. |
| Draft | The design is under review. No code has shipped. |
| Accepted | The design is approved. Implementation may start. |
| Implementing | Code is in progress and the spec may still change. |
| Implemented | The feature shipped. The spec stays for rationale and history. |
| Rejected | The work is not planned. The reason is recorded. |

A spec starts as Draft. Moving it to Accepted means the open questions are
resolved or explicitly deferred. Moving it to Implemented means the test plan
passed on the CI matrix and the documentation changed in the same release.

If an implementation contradicts an accepted spec, update the spec in the same
pull request. Do not leave a stale design in the repository.

## Numbering

Numbers are four digits and are never reused: `0001`, `0002`, and so on. The
file name is `NNNN-short-name.md`. A spec that is rejected keeps its number.

## Template

Each spec uses these sections. Remove a section only when it does not apply.

- **Header:** number, title, status, target release, related specs.
- **Problem:** what a user cannot do today, with the current behavior.
- **Goals:** the outcomes the change must produce.
- **Non-goals:** work that is out of scope, with a reason.
- **Proposal:** the CLI surface, config keys, file formats, and report changes.
- **Behavior:** defaults, ordering, and compatibility in detail.
- **Failure modes:** each error, its exit code, and what the user sees.
- **Security:** what the change protects, what it does not protect, and the
  trust boundary.
- **Test plan:** unit, fixture, CLI, and cross-platform checks.
- **Rollout:** target release, documentation changes, and compatibility notes.
- **Open decisions:** decisions still needed before the spec is accepted.

Write for an implementer who has read `src/redact.js`, `src/parse.js`,
`src/render.js`, and `bin/sanitrace.js`. Reference real symbols and files.

## Index

| Number | Spec | Status | Target |
| --- | --- | --- | --- |
| 0001 | [Custom detectors](0001-custom-detectors.md) | Implemented | 0.2.0 |
| 0002 | [Report profiles](0002-report-profiles.md) | Implemented | 0.2.0 |
| 0003 | [Mapping export](0003-mapping-export.md) | Implemented | 0.2.0 |
| 0004 | [Session formats](0004-session-formats.md) | Implemented | 0.3.0 |
| 0005 | [GitHub Action](0005-github-action.md) | Draft | 0.3.0 |

The release order and priority model are in [ROADMAP.md](../../ROADMAP.md).
