# sanitrace

Turn an agent session log into a compact, shareable, secret-free bug report.

Agent sessions are the new stack trace. When you report a bug against Codex,
Claude Code or OpenCode, a maintainer asks for the log — and the log is a JSONL
dump full of API keys, your home directory, internal hostnames and private repo
names. So people paste a 4 MB blob, or nothing.

`sanitrace` reads the log, replaces secrets and identifying paths with typed
placeholders, drops boilerplate, and renders a reviewable Markdown report you can
read before you attach it.

```console
$ sanitrace ~/.codex/sessions/2026/09/12/rollout-....jsonl -o report.md
sanitrace: 11 redaction(s) across 9 rule(s)
sanitrace: wrote report.md
```

```markdown
| Working directory | `<REPO>` |
| Tokens | 71,152 in / 3,396 out |

## Redactions

| Placeholder | Count |
| --- | --- |
| `<REPO>`, `~`, `<HOST>` | 7 |
| `[OPENAI_KEY_*]` | 1 |
| `[GITHUB_TOKEN_*]` | 1 |
| `[JWT_*]` | 1 |
| `[EMAIL_*]` | 1 |

### 1. user

The deploy script fails on my machine but works in CI. Check the env setup, my
OPENAI_API_KEY=[OPENAI_KEY_1] is set and so is GITHUB_TOKEN=[GITHUB_TOKEN_1].
Ping me at [EMAIL_1] if it needs my laptop, it is [IPV4_1].
```

## Why

- **Reviewable.** A report is ~10× smaller than the raw log and reads top to
  bottom: metadata, what you were doing, what happened, then the turns.
- **Local.** No network calls, no telemetry, no upload. Zero runtime
  dependencies.
- **Typed placeholders.** A leak is obvious in review: `[OPENAI_KEY_1]` did not
  come from your log.
- **Safe by default, verifiable.** After rendering, `sanitrace` runs every
  detector a second time over its own output and exits `3` if anything still
  matches (`--no-verify` to skip).
- **Agent-agnostic.** Codex rollouts, Claude Code transcripts, or any plain text
  log. Format is auto-detected.

## Install

```console
$ npm install -g sanitrace      # or: npx sanitrace <log>
```

Node 20+. No dependencies.

## Usage

```console
$ sanitrace <session.jsonl>                 # report to stdout
$ sanitrace <session.jsonl> -o report.md    # report to a file
$ cat session.jsonl | sanitrace -           # stdin
$ sanitrace rules                           # list detectors
$ sanitrace <session.jsonl> --check         # exit 1 if anything was redacted
```

Useful flags: `--allow <value>` (never redact, repeatable), `--no-emails`,
`--no-ips`, `--no-entropy`, `--no-outputs`, `--keep-reasoning`,
`--keep-developer`, `--max-tool-chars <n>`, `--max-total <n>`, `--json`,
`--format`.

Default output drops reasoning summaries and developer/system boilerplate, and
truncates tool output to 2000 characters. Reports are budgeted to 120k chars:
block text is scaled down first, then middle turns are elided. Nothing is
dropped silently — the report says what was trimmed.

### Config

`.sanitrace.json` is read from the working directory upward:

```json
{
  "allow": ["@mycompany.example", "github.com/myorg"],
  "disable": ["ipv4"],
  "outputs": true,
  "maxToolChars": 1200,
  "maxTotal": 60000,
  "keepPaths": ["/Users/me/dev/open-source"]
}
```

CLI flags win over config. Unknown keys are an error, not a silent typo.

### In CI

```yaml
- run: npx sanitrace session.jsonl --check -o report.md
  continue-on-error: true
```

## What it redacts

| Placeholder | Catches |
| --- | --- |
| `[PRIVATE_KEY_N]` | PEM private keys, including OpenSSH |
| `[URL_CREDENTIALS_N]` | `https://user:pass@host` |
| `[CONNECTION_STRING_N]` | `postgres://`, `mongodb://`, `redis://`, `amqp://`, … |
| `[ANTHROPIC_KEY_N]`, `[OPENAI_KEY_N]` | `sk-ant-…`, `sk-…` |
| `[GITHUB_TOKEN_N]` | `ghp_…`, `gho_…`, `github_pat_…` |
| `[CLOUD_KEY_N]` | AWS, Google, Slack tokens |
| `[PAYMENT_KEY_N]` | Stripe live/test keys |
| `[JWT_N]` | JSON Web Tokens |
| `[ENV_VALUE_N]` | values assigned to `*_KEY`, `*_TOKEN`, `*_SECRET`, … (name kept) |
| `[EMAIL_N]`, `[IPV4_N]` | addresses |
| `[HIGH_ENTROPY_N]` | random-looking strings, off-list secrets |
| `<REPO>`, `~`, `<HOST>` | working directory, home directory, hostname |

UUIDs, commit SHAs and file names are deliberately kept: they are how you read
the report.

## Residual risk

`sanitrace` is a net, not a proof. It will miss proprietary names, customer data
in tool output, and credentials in formats nobody has added yet. `--verify`
catches only what a detector knows about. Read the report before you publish it;
if you get burned, add a rule to `src/redact.js` and a fixture to `test/`.

The high-entropy pass can also over-redact legitimate identifiers. `--no-entropy`
turns it off.

## Development

```console
$ npm test        # node:test, 35 tests
$ npm run demo    # render the fixture
```

Layout: `src/parse.js` (session formats), `src/redact.js` (detectors),
`src/render.js` (Markdown), `src/index.js` (pipeline), `bin/sanitrace.js` (CLI).
Adding a detector is one object in `RULES` plus one test case; a fixture with
fake credentials is worth more than a paragraph of prose.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the bar on new rules.

## Roadmap

- GitHub Action that attaches a report to bug issues
- Codex `AGENTS.md`/skill snippet so agents produce reports themselves
- Reversible `--mapping` export, encrypted when it contains values
- More formats: OpenCode, Cursor, Gemini CLI
- Fuzz tests over the redactor, and a corpus of real-world credential shapes

## License

MIT
