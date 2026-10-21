# Roadmap

Repository version: 0.4.0 (2026-10-21). The latest npm release is 0.3.0. Items
under "Shipped in 0.4.0", "Shipped in 0.3.0", and "Shipped in 0.2.0" are
implemented in this repository. The remaining items are proposals.

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

## Shipped in 0.2.0

- Custom detectors from `.sanitrace.json` and local ESM modules.
- `bug`, `security`, and `review` report profiles.
- Encrypted mapping export and `sanitrace mapping show`.

## Shipped in 0.3.0

- OpenCode 2.1.1 export and Gemini CLI transcript parsers.
- A composite GitHub Action with report artifacts and optional comments.
- Cursor is rejected because its chats are stored only in SQLite.

## Shipped in 0.4.0

- Detector corpus and seeded parser fuzzing.
- Plain-text mode with `--raw`.
- `sanitrace diff` and content identifiers in report turns.
- Report turns carry markers, so a diff can align them after an insertion.

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
| R1 | Custom detectors in config and local modules | [0001](docs/specs/0001-custom-detectors.md) | Implemented |
| R2 | Report profiles for bug, security, and review | [0002](docs/specs/0002-report-profiles.md) | Implemented |
| R3 | Encrypted mapping export and `mapping show` | [0003](docs/specs/0003-mapping-export.md) | Implemented |

R1 adds rules for internal formats, R2 adds report sections, and R3 adds an
encrypted copy of the original values. A team can adopt these without editing
the package.

Release criteria for 0.2.0:

- The three specs are implemented.
- Tests cover each custom rule path, each profile, and the mapping format.
- The default bug report output does not change unless a spec says it does.
- README, CLI help, and CHANGELOG describe the new surface.
- `npm test` and `npm run lint` pass on the full CI matrix.

## 0.3.0: Format coverage and CI

| ID | Work | Spec | Status |
| --- | --- | --- | --- |
| R5 | OpenCode parser | [0004](docs/specs/0004-session-formats.md) | Implemented |
| R6 | Gemini CLI parser | [0004](docs/specs/0004-session-formats.md) | Implemented |
| R7 | Cursor export parser | [0004](docs/specs/0004-session-formats.md) | Rejected |
| R8 | GitHub Action and example workflow | [0005](docs/specs/0005-github-action.md) | Implemented |

R5 and R6 read local exports and normalize them into the existing report shape.
R7 is rejected because Cursor stores chats only in SQLite, which is a non-goal.
R8 renders a report and posts it to an issue or pull request from a workflow.

Release criteria for 0.3.0:

- R5, R6, and R8 are implemented. R7 is rejected with a reason.
- Tests cover detection, both parsers, and the action failure paths.
- README, CLI help, and CHANGELOG describe the new surface.
- `npm test`, `npm run lint`, and the action self-test pass on CI.

## 0.4.0: Plain text, diff, and test coverage

| ID | Work | Spec | Status |
| --- | --- | --- | --- |
| R4 | Detector corpus and parser fuzzing | none | Implemented |
| R9 | Plain-text mode with `--raw` | [0006](docs/specs/0006-plain-text-mode.md) | Implemented |
| R10 | Report diff and turn identifiers | [0007](docs/specs/0007-report-diff.md) | Implemented |

R4 adds a generated corpus that covers every detector, near-miss values that
must not match, and a seeded fuzz pass over the parsers. It has no user surface.

R9 writes redacted text without a report. R10 adds `sanitrace diff` and a
content identifier to every rendered turn. The turn marker changes the default
report, as spec 0007 records.

Release criteria for 0.4.0:

- R4, R9, and R10 are implemented.
- Tests cover the corpus, the fuzz seed, raw mode, and every diff outcome.
- README, CLI help, and CHANGELOG describe the new surface.
- `npm test` and `npm run lint` pass on the full CI matrix.

## Later

- **Streaming parse.** `sanitrace` reads the whole input into memory. A streaming
  parser would accept large logs without a size limit. No spec yet.
- **Custom report templates.** The profile system defines fixed sections first.
  Arbitrary templates need a file format and a validation story.
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
| 0006 | [Plain-text mode](docs/specs/0006-plain-text-mode.md) | 0.4.0 |
| 0007 | [Report diff](docs/specs/0007-report-diff.md) | 0.4.0 |

Spec status and the writing rules are in
[docs/specs/README.md](docs/specs/README.md).
