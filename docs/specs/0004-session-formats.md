# 0004: Session formats

Status: Implemented
Target: 0.3.0
Depends on: none

## Problem

`detectFormat()` in `src/parse.js` recognizes Codex and Claude Code. Every other
input becomes `text`, which keeps raw JSONL lines in the transcript. Redaction
still runs, but the report is hard to read, metadata is missing, and tool output
is not collapsed.

OpenCode, Gemini CLI, and Cursor users get that fallback today.

## Goals

- Add parsers for OpenCode and Gemini CLI.
- Reject Cursor because it has no stable JSON export.
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

`--format` accepts `opencode` and `gemini` in addition to `auto`, `codex`,
`claude`, and `text`. The report metadata shows the id.

Cursor is rejected. Its chat data is stored in `state.vscdb` SQLite files, and
reading SQLite is a non-goal.

### Detection

`detectFormat()` keeps the Codex and Claude signatures first, then checks the
new formats, then falls back to `text`.

A new format needs at least two independent structural signals. A single key
such as `"messages"` or `"role"` is not enough. The confirmed formats are:

- **OpenCode:** a JSON export with an `info` object, a `messages` array, and a
  typed message or content part. Require the envelope plus the type signal.
- **Gemini CLI:** a JSONL transcript with a `sessionId` and `projectHash`
  header and a `gemini` event or a `toolCalls` array. Require both.

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

Add one fixture per supported format:

- `test/fixtures/opencode-session.json`
- `test/fixtures/gemini-session.jsonl`

Use the extension of the captured export. Each fixture is under 50 KB and
contains:

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

Release 0.3.0. The OpenCode parser uses the 2.1.1 export command
`opencode session export <sessionID>`. The Gemini CLI parser uses the JSONL
files under `~/.gemini/tmp/<project>/chats/`. Cursor is rejected and removed
from the release instead of reading SQLite.

Update the README format table, the `--format` help text, and the CHANGELOG.
Add a short `CONTRIBUTING.md` section for adding a parser and a fixture.

## Open decisions

- OpenCode 2.1.1 and its export command are confirmed. The fixture records both.
- The Gemini CLI transcript does not record a client version. The parser reads
  the fields that are present and counts unknown records instead of failing.
- Cursor has no documented JSON export. It provides only SQLite storage, so it
  is rejected.
- A shared normalization helper is deferred until the two parsers repeat the
  same normalization code. The current parsers share small helpers only.
