# 0004: Session formats

Status: Accepted
Target: 0.3.0
Depends on: none

## Problem

`detectFormat()` in `src/parse.js` recognizes Codex and Claude Code. Every other
input becomes `text`, which keeps raw JSONL lines in the transcript. Redaction
still runs, but the report is hard to read, metadata is missing, and tool output
is not collapsed.

OpenCode, Gemini CLI, and Cursor users get that fallback today.

## Goals

- Add parsers for OpenCode and Gemini CLI, and for Cursor when a stable JSON
  export exists.
- Detect each format from at least two structural signals.
- Keep the parser contract: `{ format, meta, turns, usage, skipped, toolCalls }`.
- Skip unknown records and count them instead of throwing.
- Add a fixture captured from a real client for each format, with fake values.
- Add negative detection fixtures so plain text and other JSONL stay `text`.

## Non-goals

- Reading Cursor's SQLite database or any other proprietary store.
- Reverse engineering a format without a captured export.
- Compressed, binary, or encrypted input.
- Live tailing of a session directory.
- Export commands inside the clients.
- Fidelity across every client version. The fixture records the version tested.

## Proposal

### Format ids

`--format` accepts `opencode`, `gemini`, and `cursor` in addition to `auto`,
`codex`, `claude`, and `text`. The report metadata shows the id.

### Detection

`detectFormat()` keeps the Codex and Claude signatures first, then checks the
new formats, then falls back to `text`.

A new format needs at least two independent structural signals. A single key
such as `"messages"` or `"role"` is not enough. Candidate signals below are
starting points. Confirm them against the captured export before implementation:

- **OpenCode:** a session envelope with a session identifier, a message array,
  and message parts that carry a type. Require the envelope plus at least one
  part or message field.
- **Gemini CLI:** a transcript envelope with a session identifier and a
  `messages` array whose entries have a type and content field. Require both.
- **Cursor:** an exported chat document with a conversation or bubble array and
  a bubble type field. Require the export key plus the bubble field.

Detection tests:

- Prose that mentions the client name returns `text`.
- A Codex rollout returns `codex`.
- JSON with one matching key returns `text`.
- `--format` overrides detection and never falls back.

### Normalization

Each parser returns the same shape as `parseCodex` and `parseClaude`:

```json
{
  "format": "opencode",
  "meta": {
    "cwd": null,
    "model": "example-model",
    "cliVersion": "1.2.3",
    "source": "opencode",
    "startedAt": "2026-10-21T12:00:00.000Z",
    "endedAt": null,
    "sessionId": "ses_..."
  },
  "turns": [
    { "role": "user", "blocks": [{ "kind": "text", "text": "...", "originalChars": 42 }] }
  ],
  "usage": { "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0 },
  "skipped": 0,
  "toolCalls": 0
}
```

Block kinds stay `text`, `tool`, `output`, and `reasoning`. The renderer and
the budget logic do not change.

Role mapping:

| Source role | Normalized role |
| --- | --- |
| `user`, `human` | `user` |
| `assistant`, `ai`, `model` | `assistant` |
| `tool`, `function`, `tool_result` | `tool` |
| `developer`, `system` | as written |
| anything else | lowercased source value, or `unknown` if empty |

Tool calls become `tool` blocks with the tool name. Tool results become
`output` blocks. Reasoning summaries become `reasoning` blocks only when the
source marks them.

Content rules:

- Accept a string or an array of content parts. Read `text`, `input_text`, and
  `output_text` parts. Ignore image and file parts in this release.
- Do not decode base64, HTML entities, or compressed payloads.
- Apply `MAX_BLOCK_CHARS` and `MAX_TOOL_CHARS` with the same `clip()` helper.
- Count a tool call once, even when the call and the result are separate
  records.
- Keep the first and last timestamps when the source provides them.
- Read token counts when present. Use zero when absent.

Unknown record types increment `skipped`. A malformed JSON line increments
`skipped` for JSONL input. A malformed top-level document returns an empty
result with `skipped: 1`; it does not throw.

### Fixtures

Add one fixture per format:

- `test/fixtures/opencode-session.jsonl`
- `test/fixtures/gemini-session.jsonl`
- `test/fixtures/cursor-export.json`

Use the extension of the captured export. The names above are examples; a JSON
document uses `.json`.

Each fixture is under 50 KB and contains:

- fake credentials that match at least three detectors
- one multiline tool output longer than 2,000 characters
- one unknown record
- one malformed record for JSONL fixtures
- a working directory under `/Users/example` or `C:\Users\example`

`test/fixtures/README.md` records the client name, version, capture date,
export command or directory, and the fields that were replaced with fake data.
Do not commit a real session.

## Behavior

- Detection is automatic. `--format` is available when detection is ambiguous.
- The text fallback stays unchanged for unknown input.
- The report metadata `Format` row shows the new id.
- Tool output is collapsed by the renderer as it is today.
- A fixture with a 3,000 character tool result produces the same truncation note
  as the Codex path.
- The parsers do not change redaction or the report budget.

## Failure modes

| Condition | Result |
| --- | --- |
| Empty input | The CLI keeps its current `input is empty` error, exit 2 |
| Truncated JSON document | Empty result, `skipped: 1`, report still written |
| Malformed JSONL line | Line skipped, count incremented |
| Unknown record type | Skipped, count incremented |
| Missing timestamp or token fields | `null` or zero, no error |
| Unsupported role | Lowercased source value, or `unknown` |
| Unsupported content part | Ignored |
| `--format` names an unknown parser | Exit 2, list valid names. In 0.1.1 an unknown name fell back to `text`; the new check is a deliberate change |

## Security

The parsers read untrusted JSON. They must use `JSON.parse` inside a try/catch
and must not evaluate input as code. They must not fetch URLs found in a record,
decode base64 blobs, or render raw HTML.

A parser that drops a block loses evidence, which is a report quality bug. A
parser that copies raw JSON into a `text` block still sends it through redaction.
Prefer the second failure.

The input size limit stays as it is: the whole file is read into memory. A
streaming parser is a later roadmap item.

## Test plan

Parser tests:

- Each fixture produces the expected format, turn count, role order, block
  kinds, tool call count, and metadata.
- A tool result over 2,000 characters is clipped and records `originalChars`.
- An unknown record increments `skipped` and does not throw.
- A malformed JSONL line increments `skipped`.
- An empty document returns zero turns.

Detection tests:

- Each fixture is detected without `--format`.
- A prose file that mentions OpenCode, Gemini, or Cursor returns `text`.
- A Codex fixture still returns `codex`.
- JSON with one candidate key returns `text`.
- `--format opencode` parses a fixture even when detection would return `text`.

End-to-end tests:

- `sanitize()` on each fixture returns zero residuals.
- `--check` exits 1 because the fixtures contain fake credentials.
- A fixture with `--max-total 2000` still closes code fences and details blocks.
- The existing Codex and Claude snapshots do not change.

## Rollout

Release 0.3.0. Ship one parser per pull request in this order: OpenCode, Gemini
CLI, Cursor. R7 in the roadmap stays conditional: if Cursor has no stable JSON
export, mark it rejected and remove it from the release instead of reading
SQLite.

Update the README format table, the `--format` help text, and the CHANGELOG.
Add a short `CONTRIBUTING.md` section for adding a parser and a fixture.

## Open decisions

- Confirm the OpenCode release and export command before implementation. The
  fixture records both.
- Confirm the Gemini CLI transcript format across releases. If it changes,
  record a version check in the parser and fall back to `text` on a mismatch.
- Confirm that Cursor provides a documented export. If it does not, drop Cursor
  from 0.3.0.
- A shared normalization helper is deferred until the second parser repeats the
  same normalization code.
