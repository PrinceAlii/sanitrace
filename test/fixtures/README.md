# Fixture provenance

These fixtures are synthetic. No real session content is committed. All
credentials, addresses, hostnames, and paths are fake.

## OpenCode

- Client: OpenCode
- Version: 2.1.1, from `opencode --version`
- Capture date: 2026-10-21
- Export: `opencode session export <sessionID>`, which writes a JSON document
  with `info` and `messages` keys
- File: `opencode-session.json`
- Structure: one `user` message, one `assistant` message with `reasoning`,
  `text`, and `tool` content parts, and one `compaction` message
- Tool output: 4,249 characters, which exercises renderer truncation
- Replaced with fake data: session id, model id and provider, token counts,
  timestamps, title, working directory, user text, reasoning text, tool input,
  tool output, and compaction summary

## Gemini CLI

- Client: Gemini CLI
- Version: the transcript does not record a client version, and the local files
  do not show one
- Capture date: 2026-10-21
- Source: `~/.gemini/tmp/<project>/chats/session-<timestamp>-<id>.jsonl`
- File: `gemini-session.jsonl`
- Structure: one header record, one `user` record, two `gemini` records, one
  `info` record that a parser can count as skipped, and one malformed JSONL line
- Tool output: 3,636 characters, which exercises renderer truncation
- Replaced with fake data: session id, project hash, timestamps, token counts,
  model name, working directory, user text, thought summaries, tool arguments,
  and tool output

## Cursor

Cursor has no fixture. Spec 0004 rejects Cursor because it stores chat data in
SQLite.
