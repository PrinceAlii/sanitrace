# Changelog

## 0.3.0

- Add OpenCode 2.1.1 export and Gemini CLI transcript parsers with automatic
  detection and plain-text fallback.
- Add a composite GitHub Action that runs sanitrace, uploads the report and
  findings, and optionally comments on an issue or pull request.

## 0.2.0

- Add `bug`, `security`, and `review` report profiles, selected with `--profile`
  or the `profile` config key. The default `bug` report is unchanged.
- Add `"profile"` to `--json` output.
- Add `customRules` and `ruleModules` config keys and the repeatable
  `--rule-module` flag for local ESM rule modules.
- Custom rules run after the built-in detectors and before path mapping and the
  entropy pass. `sanitrace rules` adds a `source` column, and `--json` findings
  include custom rules.
- Add `--mapping <file>` and `--mapping-passphrase-env` to write an encrypted
  placeholder-to-original map after the report. Add `mapping show` and
  `--report` to decrypt the map and check the Markdown report digest. `--force`
  replaces an existing mapping file. The map uses `node:crypto` and adds no
  runtime dependency.

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
