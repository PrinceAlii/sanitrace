# Roadmap

Repository version: 0.1.1 (2026-10-21). The latest npm release is 0.1.0. The
items below are proposals. None of them is implemented.

## Constraints

An accepted change keeps these properties:

- No runtime dependencies. Node 20 built-ins cover the planned work.
- No network access. The CLI reads local input and writes local output.
- The rule list stays in `src/redact.js`, where a reviewer can read it in one
  file. Custom rules extend it from configuration.
- The tool never claims that a report is free of secrets. The verify pass and
  the Limits section in `README.md` stay accurate.
- The default report remains readable in an issue body.
- Node 20 or newer, ESM, and the current exit codes: 0 for success, 1 for
  `--check`, 2 for usage and I/O errors, 3 for residual matches.

## Shipped in 0.1.x

- Codex and Claude Code parsers, with a plain-text fallback.
- Thirteen detectors, an entropy pass, and path mapping for the working
  directory, home directory, and hostname.
- Markdown report with metadata, a redaction table, prompt sections, collapsed
  tool output, a 120,000 character budget, and a 2,000 character tool limit.
- `--check`, `--verify`, `--json`, `sanitrace rules`, and `.sanitrace.json`.
- 36 tests and CI on Linux, macOS, and Windows with Node 20, 22, and 24.

## Priority order

1. Reduce the chance of a missed credential or a leaked path.
2. Keep the report usable. A report that is too large or hard to read is not
   used, and an unused report cannot help.
3. Add coverage. New formats follow the detection work because every parser
   feeds the same redaction path.
4. Add convenience. Diffing, templates, and editor integration come last.

An item needs a spec before implementation when it adds a flag, a config key, a
session format, or a file format. A small fix does not need a spec.

## 0.2.0: Detector control and report shape

| ID | Work | Spec | Status |
| --- | --- | --- | --- |
| R1 | Custom detectors in config and local modules | [0001](docs/specs/0001-custom-detectors.md) | Draft |
| R2 | Report profiles for bug, security, and review | [0002](docs/specs/0002-report-profiles.md) | Draft |
| R3 | Encrypted mapping export and `mapping show` | [0003](docs/specs/0003-mapping-export.md) | Draft |
| R4 | Detector corpus and parser fuzzing | none | Planned |

R1 adds rules for internal formats, R2 adds report sections, and R3 adds an
encrypted copy of the original values. A team can adopt these without editing
the package.

R4 is an engineering task with no user surface. It requires a generated corpus
of values that match every detector, a set of near-miss values that must not
match, and a seeded fuzz pass over the parsers. The fuzz pass uses `node:test`
and no new dependency.

Release criteria for 0.2.0:

- The three specs are accepted.
- Tests cover each custom rule path, each profile, and the mapping format.
- The default bug report output does not change unless a spec says it does.
- README, CLI help, and CHANGELOG describe the new surface.
- `npm test` and `npm run lint` pass on the full CI matrix.

## 0.3.0: Format coverage and CI

| ID | Work | Spec | Status |
| --- | --- | --- | --- |
| R5 | OpenCode parser | [0004](docs/specs/0004-session-formats.md) | Draft |
| R6 | Gemini CLI parser | [0004](docs/specs/0004-session-formats.md) | Draft |
| R7 | Cursor export parser | [0004](docs/specs/0004-session-formats.md) | Draft, conditional |
| R8 | GitHub Action and example workflow | [0005](docs/specs/0005-github-action.md) | Draft |

R5 comes first because OpenCode sessions are used in this repository's own
workflow. R6 follows with the same normalization layer. R7 ships only if Cursor
provides a stable JSON export. Reading its SQLite store is not planned.
R8 renders a report and posts it to an issue or pull request from a workflow.

## Later

- **Session diff.** Compare two reports from the same task and show where the
  turns diverged. Needs stable turn identifiers, which the current report does
  not emit.
- **Streaming parse.** `sanitrace` reads the whole input into memory. A streaming
  parser would accept large logs without a size limit. No spec yet.
- **Custom report templates.** The profile system defines fixed sections first.
  Arbitrary templates need a file format and a validation story.
- **Arbitrary text mode.** Redact pasted terminal output or a chat log that has
  no session structure. This reuses the detector engine and skips the parser.
- **Editor integration.** A task or command that runs the CLI on the current
  session file. Low value until profiles exist.
- **Browser build.** A separate package could run the detectors in a page with no
  upload. This does not change the CLI.

## Non-goals

- A hosted redaction service.
- Calls to provider APIs to validate a credential. A validation call would send
  the secret to a third party.
- Posting a report to a public issue without a person reading it first.
- Reading Cursor's SQLite database or any other proprietary store.
- A remote rule registry or automatic rule downloads.
- A graphical application.

## Definition of done

An item is done when all of these hold:

- The spec status is Implemented or the spec is rejected with a reason.
- Tests cover the new behavior and the failure paths named in the spec.
- README and CLI help match the code.
- `CHANGELOG.md` has an entry.
- The CI matrix passes on Linux, macOS, and Windows.
- The package still has no runtime dependencies.

## Versioning

The project uses `0.x` releases. A minor release adds features and may change
the default report only when the spec and the changelog say so. A patch release
fixes behavior without changing the report format.

Release tags use `vX.Y.Z`. The npm package and the GitHub tag share the same
version. `VERSION` in `src/render.js` must match `package.json`; a test enforces
this.

## Spec index

| Number | Spec | Target |
| --- | --- | --- |
| 0001 | [Custom detectors](docs/specs/0001-custom-detectors.md) | 0.2.0 |
| 0002 | [Report profiles](docs/specs/0002-report-profiles.md) | 0.2.0 |
| 0003 | [Mapping export](docs/specs/0003-mapping-export.md) | 0.2.0 |
| 0004 | [Session formats](docs/specs/0004-session-formats.md) | 0.3.0 |
| 0005 | [GitHub Action](docs/specs/0005-github-action.md) | 0.3.0 |

Spec status and the writing rules are in
[docs/specs/README.md](docs/specs/README.md).
