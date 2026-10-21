# 0006: Plain-text mode

Status: Accepted
Target: 0.4.0
Depends on: none

## Problem

`--format text` sends a pasted log through `parseText()` and `render()`. The
result is a report with metadata sections, and `MAX_BLOCK_CHARS` cuts the input
to 6,000 characters. A user who wants to paste a redacted terminal session into
a ticket loses most of the session and has to remove report text by hand.

The detector engine works on arbitrary strings, so the parser and renderer are
not needed for this case.

## Goals

- Add `--raw`, which writes the input with placeholders in place of detected
  values.
- Keep every detector, custom rule, path mapping, allow entry, and disable
  entry available in this mode.
- Preserve the input except for replacements. Do not add report headings, do not
  clip the text, and do not change line endings.
- Map the working directory, home directory, and hostname in raw mode.
- Support `--out`, `--json`, `--check`, and `--no-verify`.

## Non-goals

- Streaming input. The whole file is still read into memory.
- Binary input, compressed input, or terminal escape decoding.
- Redacting a report that was already rendered.
- Mapping export. The mapping digest is tied to a Markdown report.
- New config keys.
- New detectors.

## Proposal

### CLI

```console
$ sanitrace notes.txt --raw
$ cat session.log | sanitrace - --raw
$ sanitrace notes.txt --raw -o notes.redacted.txt
$ sanitrace notes.txt --raw --json
```

`--raw` is a boolean flag. It implies `--format text` and skips `parse()` and
`render()`.

`--format` is accepted only when its value is `auto` or `text`. Any other value
exits 2 before the input is read:

```text
sanitrace: --raw supports --format text only
```

The report-only flags exit 2 when combined with `--raw`:

| Flag | Reason |
| --- | --- |
| `--profile` | No report is rendered |
| `--mapping` | The mapping digest is tied to a report |
| `--mapping-passphrase-env` | Used only with `--mapping` |
| `--force` | Used only with `--mapping` |
| `--max-total` | No report budget is applied |
| `--max-tool-chars` | No parser runs |
| `--keep-reasoning` | No parser runs |
| `--keep-developer` | No parser runs |
| `--no-outputs` | No parser runs |

The message names the first conflicting flag and exits 2 before the input is
read.

The detector flags stay available: `--config`, `--rule-module`, `--allow`,
`--disable`, `--keep-path`, `--no-entropy`, `--no-emails`, and `--no-ips`.
The config keys `allow`, `disable`, `entropy`, `emails`, `ips`, `keepPaths`,
`customRules`, and `ruleModules` apply. Other config keys are read and ignored
in raw mode, including `profile`, `maxToolChars`, and `maxTotal`.

### Output

Text mode writes the redacted input to stdout or to `--out`. The output contains
no report wrapper. A trailing newline is preserved when the input has one and
omitted when it does not.

`--json` writes this object:

```json
{
  "text": "redacted text",
  "findings": [
    { "rule": "openai-key", "label": "OPENAI_KEY", "count": 1, "samples": ["sk-proj-…"] }
  ],
  "residual": []
}
```

The `samples` field has the same truncation and content as report findings.
`--json` does not include a `markdown` field. `--out` writes the JSON payload
with one trailing newline.

The stderr summary stays the same:

```text
sanitrace: 2 redaction(s) across 1 rule(s)
```

### Path mapping

Raw mode maps these prefixes to the existing placeholders:

- the working directory to `<REPO>`
- the home directory to `~`
- the hostname to `<HOST>`
- `/Users/<user>` and `/home/<user>` to `~`

`--keep-path` removes a prefix from this list. A path shorter than four
characters is not mapped.

### Library

Add `sanitizeText(text, options)` to `src/index.js` and export it from the
package entry point. It returns `{ text, findings, residual }` and accepts the
detector subset of `SanitizeOptions`, plus `cwd`.

```js
import { sanitizeText } from 'sanitrace';

const result = sanitizeText('key sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t', {
  cwd: '/Users/example/project',
});
```

`sanitizeText()` calls `redact()` and `verify()`. It does not call `parse()` or
`render()`.

## Behavior

- The input is passed to `redact()` unchanged.
- The verify pass runs over the redacted text unless the caller passes
  `noVerify: true` or the CLI receives `--no-verify`.
- `--check` exits 1 when at least one replacement occurred.
- A residual match prints the same stderr lines as report mode and exits 3.
- `--raw` with `--json` returns the JSON object above. `--raw` without `--json`
  writes text.
- An empty input still exits 2 with `input is empty`.
- Read errors and write errors keep exit 2.
- Custom rules run in the same order as in report mode.

## Failure modes

| Condition | Result |
| --- | --- |
| `--raw --format codex` | Exit 2, `--raw supports --format text only` |
| `--raw --profile review` | Exit 2, report-only flag named |
| `--raw --mapping map` | Exit 2, `--mapping requires a report` |
| `--raw` with an empty input | Exit 2, `input is empty` |
| `--raw --check` with a match | Exit 1 after writing the output |
| `--raw` with a residual match | Exit 3 after writing the output |
| `--raw --out` to a missing directory | Exit 2, write error |
| Unknown config key | Exit 2, unchanged config validation |

## Security

Raw mode uses the same detectors and the same verify pass. It does not read a
session format, so it cannot recover metadata such as the original working
directory. The path list therefore uses the process working directory.

The output is not guaranteed to be free of secrets. The Limits section in
`README.md` applies unchanged. No network access is added. The command does not
write the mapping.

## Test plan

Unit tests:

- `sanitizeText()` redacts a credential and returns a finding.
- A 20,000-character input is preserved except for the replacement and is not
  clipped.
- Path mapping replaces the working directory, home directory, and hostname.
- `allow`, `disable`, `entropy: false`, `emails: false`, `ips: false`, and a
  custom rule behave as in report mode.
- `verify()` sees no match after a normal redaction.
- A no-op input returns the input unchanged.

CLI tests:

- `--raw` on a file writes text without `# Agent session report`.
- `--raw` on stdin works.
- `--raw` preserves text over `MAX_BLOCK_CHARS`.
- `--raw -o` writes the text file.
- `--raw --json` returns `text`, `findings`, and `residual`.
- `--raw --check` exits 1 for a credential and 0 for clean text.
- `--raw --format codex` exits 2 before reading a missing file.
- `--raw --profile` exits 2 before reading a missing file.
- `--raw --mapping` exits 2 before reading a missing file.
- Config and custom rules apply.
- A path in the input is replaced with `<REPO>`.
- CRLF input keeps CRLF in the output.

Cross-platform checks:

- Path mapping works with a Windows-style working directory on Windows.
- The CLI test suite runs on Linux, macOS, and Windows.

## Rollout

Release 0.4.0. Update `README.md` with a "Plain text" section, the `--help`
text, and `CHANGELOG.md`. Add the item to `ROADMAP.md` as implemented.

## Open decisions

None.
