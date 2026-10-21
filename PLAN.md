# Plan: `sanitrace`

## Goal

Ship a small, genuinely useful OSS tool, then apply to the Codex for Open Source
program with a repository that reads as credible to a reviewer.

## The problem

Agent sessions are the new stack trace. When you file a bug against Codex, Claude
Code, Cursor or OpenCode, the first thing a maintainer asks for is the session
log. Those logs are JSONL dumps that contain:

- API keys, tokens and env values the agent echoed
- your home directory, hostname and internal URLs
- private repo names, branch names and file contents
- full tool output, mostly noise

So people either paste a 4 MB unsanitized blob or nothing at all. There is no
`git diff`-equivalent for sessions: a compact, reviewable, scrubbed artifact you
can attach to an issue.

`sanitrace` is that artifact generator. It parses a session log, redacts secrets
and identifying paths with typed placeholders, and renders a compact Markdown
incident report you can read before you paste it.

## Why this qualifies for the program

- **Directly serves Codex.** It reads Codex rollout logs natively, so it makes
  Codex bug reports better for everyone.
- **Greenfield.** A GitHub search for transcript redaction tooling returns
  essentially nothing; the closest hits are redaction *libraries*, not session
  tooling. The category is unclaimed.
- **Broad ecosystem value.** Works on Codex, Claude Code and plain text logs, so
  it is not tied to one vendor.
- **Credible maintenance surface.** A redaction engine has an obvious roadmap:
  new credential formats, new session formats, allowlists, a GitHub Action, a
  reviewer-facing "residual risk" score.

## Scope (v0.1, this bootstrap)

- `sanitrace <session.jsonl | ->`: parse, redact, render Markdown report.
- Format detection: Codex rollouts, Claude Code transcripts, generic text.
- Rule engine with typed placeholders (`[OPENAI_KEY_1]`), allowlists, custom
  rules, entropy fallback, per-run finding counts.
- `--check` mode for CI: exit 1 when anything was redacted.
- `--verify` self-check: re-scan the rendered report and fail if a detector still
  matches.
- Path and identity scrubbing: `$HOME` → `~`, repo root → `<REPO>`, hostname.
- Zero runtime dependencies. Auditable, `npx`-able, no supply chain surface.
- Tests with fixtures containing fake but realistic credentials.
- CI on Linux/macOS/Windows, Node 20/22/24; issue templates; SECURITY.md.

## Non-goals for v0.1

- Uploading anything to a server. Local-only, always.
- Perfect secret detection (see "residual risk" in the README).
- Reversible un-redaction / encryption of transcripts.

## Milestones

1. **Bootstrap** — repo, license, rule engine, parser, renderer, tests, CI.
2. **v0.1.0 release** — npm publish, one real bug report rendered as the README
   demo, `--check` wired into CI for the repo itself.
3. **Adoption** — post the demo to r/Codex and the Codex Discord; open a docs PR
   to the Codex repo suggesting `sanitrace` for session attachments.
4. **Apply** — submit the form using the drafts below once the repo has CI green
   and a tagged release.
5. **Post-apply** — GitHub Action wrapper, Claude Code JSONL hardening, allowlist
   config, "residual risk" scoring, fuzz tests on the redactor.

## Success signals

- Zero secrets survive a `--verify` run on 25 real local sessions.
- First external issue or PR within 30 days.
- Stars are lagging but durable: target 100 within 60 days via the demo post.

## Application drafts (form at openai.com/form/codex-for-oss)

**Role:** Primary maintainer

**Why does this repository qualify?** (≤500 chars)

> Agent session logs are the new stack trace, but they leak API keys, home paths
> and private repo names, so most bug reports against coding agents ship with no
> log at all. sanitrace turns a Codex rollout into a compact, scrubbed Markdown
> report with typed placeholders and a `--verify` self-check. It is the only
> purpose-built transcript sanitizer, works across Codex and other agents, and
> has zero runtime dependencies. It exists to make Codex bug reports better for
> everyone, not just its users.

**How will you use API credits?** (≤500 chars)

> Automated maintainer work: generating redaction fixtures from real sessions,
> running a nightly job that verifies every supported session format still
> parses, and driving Codex in CI to triage new credential formats and
> regressions. Credits also fund a fuzz harness for the redactor, since a missed
> pattern is a leaked key, plus an automated bot that renders and attaches a safe
> report to incoming issues.

**Anything else?** (≤500 chars)

> Redaction correctness is the whole product, so the project is deliberately
> boring: zero dependencies, no network calls, snapshot tests over realistic
> fixtures. v0.1 supports Codex and Claude Code; the roadmap covers new formats,
> allowlists and residual-risk scoring. Built as a solo maintainer after filing
> agent bugs and having no safe way to attach the log.
