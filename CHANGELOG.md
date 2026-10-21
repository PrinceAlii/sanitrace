# Changelog

## 0.1.1

- Rewrite the README, CONTRIBUTING, and SECURITY files to the repository writing
  standard.
- Add `AGENTS.md` with the writing and review rules.
- Align the package description and CLI help with the README.

## 0.1.0

First release.

- Parse Codex rollouts and Claude Code transcripts, with a plain-text fallback.
- Redact private keys, provider tokens, connection strings, JWTs, env values,
  emails, IPs, high-entropy strings, and local path identities.
- Render a Markdown report with metadata, a redaction table, and collapsed tool
  output.
- `--check` for CI and `--verify` self-check that exits 3 on residuals.
- `.sanitrace.json` config with allow list, rule disabling and truncation limits.
