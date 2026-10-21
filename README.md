# sanitrace

Turn an agent session log into a Markdown report that can be attached to a bug
report or a review.

## The problem

Bug reports against coding agents often include a session log. Those logs are
JSONL files that can contain API keys the agent echoed, home directory paths,
internal hostnames, private repository names, and full tool output. An
unredacted log can leak credentials; omitting the log slows triage.

sanitrace reads the log, replaces detected credentials and local paths with
placeholders, drops boilerplate, and writes a report that is smaller than the
log and can be read before it is published.

## What it does

- Parses Codex rollouts, Claude Code transcripts, and plain text, and detects
  the format.
- Replaces detected credentials and addresses with numbered placeholders such
  as `[OPENAI_KEY_1]`. Thirteen detectors, an entropy pass, and path mapping
  cover the common cases.
- Drops reasoning summaries and developer/system messages by default, and
  truncates tool output to 2000 characters.
- Budgets reports at 120,000 characters by scaling block text, then eliding
  middle turns.
- Writes `bug`, `security`, or `review` reports with profile-specific sections
  and prompts.
- Runs every detector again over its own output and exits 3 if a match remains.
- Runs locally, with no network access and no runtime dependencies.

```console
$ sanitrace ~/.codex/sessions/2026/09/12/rollout-....jsonl -o report.md
sanitrace: 13 redaction(s) across 10 rule(s)
sanitrace: wrote report.md
```

```markdown
| Working directory | `<REPO>` |
| Turns | 2 (1 tool calls) |

## Redactions

| Placeholder | Count |
| --- | --- |
| `<REPO>`, `~`, `<HOST>` | 2 |
| `[OPENAI_KEY_*]` | 1 |
| `[GITHUB_TOKEN_*]` | 1 |
| `[PRIVATE_KEY_*]` | 1 |
| `[EMAIL_*]` | 1 |

### 1. user

The deploy script fails on my machine but works in CI. Check the env setup, my
OPENAI_API_KEY=[OPENAI_KEY_1] is set and so is GITHUB_TOKEN=[GITHUB_TOKEN_1].
Ping me at [EMAIL_1] if it needs my laptop, it is [IPV4_1].
```

## Install

```console
$ npm install -g sanitrace
$ sanitrace <session.jsonl>
```

Without a global install:

```console
$ npx sanitrace <session.jsonl>
```

Node 20 or newer.

## Usage

```console
$ sanitrace <session.jsonl>                 # report to stdout
$ sanitrace <session.jsonl> -o report.md    # report to a file
$ cat session.jsonl | sanitrace -           # read stdin
$ sanitrace rules                           # list detectors
$ sanitrace <session.jsonl> --check         # exit 1 if anything was redacted
```

Flags: `--profile <name>`, `--allow <value>` (never redact, repeatable),
`--no-emails`, `--no-ips`, `--no-entropy`, `--no-outputs`, `--keep-reasoning`,
`--keep-developer`, `--max-tool-chars <n>`, `--max-total <n>`, `--json`,
`--format`.

The verify pass runs by default. Pass `--no-verify` to skip the second
detection pass.

## Profiles

`--profile` selects the report layout. The default is `bug`. `.sanitrace.json`
accepts `"profile": "security"`, and `--profile` overrides the config value.
Valid names are `bug`, `security`, and `review`. An unknown or uppercase name
exits 2 before sanitrace reads the log.

| Order | `bug` | `security` | `review` |
| --- | --- | --- | --- |
| Title | Agent session report | Agent session security report | Agent session review |
| 1 | Metadata | Metadata | Metadata |
| 2 | Redactions | Redactions | Redactions |
| 3 | What happened | Summary | Summary |
| 4 | Expected | Impact | Changes |
| 5 | Transcript | Affected versions | Verification |
| 6 | | Reproduction | Risks |
| 7 | | Expected behavior | Transcript |
| 8 | | Transcript | |

The profile sets the title, the section headings, the prompt comments, and one
`Profile` metadata row for `security` and `review`. Detectors, truncation, and
the redaction table do not change. `--json` includes the selected profile as
`"profile"`.

```console
$ sanitrace session.jsonl --profile security
$ sanitrace session.jsonl --profile review -o review.md
```

## Configuration

sanitrace reads `.sanitrace.json` from the working directory upward. CLI flags
override the file. Unknown keys are an error.

```json
{
  "allow": ["@mycompany.example", "github.com/myorg"],
  "disable": ["ipv4"],
  "profile": "security",
  "outputs": true,
  "maxToolChars": 1200,
  "maxTotal": 60000,
  "keepPaths": ["/Users/me/dev/open-source"]
}
```

## Continuous integration

```yaml
- run: npx sanitrace session.jsonl --check -o report.md
```

`--check` exits 1 when at least one redaction occurred. It writes the report
before it exits.

## Detectors

| Placeholder | Matches |
| --- | --- |
| `[PRIVATE_KEY_N]` | PEM private keys, including OpenSSH |
| `[URL_CREDENTIALS_N]` | `https://user:pass@host` |
| `[CONNECTION_STRING_N]` | `postgres://`, `mongodb://`, `redis://`, `amqp://` |
| `[ANTHROPIC_KEY_N]`, `[OPENAI_KEY_N]` | `sk-ant-...`, `sk-...` |
| `[GITHUB_TOKEN_N]` | `ghp_...`, `gho_...`, `github_pat_...` |
| `[CLOUD_KEY_N]` | AWS, Google, and Slack tokens |
| `[PAYMENT_KEY_N]` | Stripe live and test keys |
| `[JWT_N]` | JSON Web Tokens |
| `[BEARER_TOKEN_N]` | `Authorization: Bearer ...` and `Basic ...` values |
| `[ENV_VALUE_N]` | values assigned to `*_KEY`, `*_TOKEN`, `*_SECRET`; the name is kept |
| `[EMAIL_N]`, `[IPV4_N]` | addresses |
| `[HIGH_ENTROPY_N]` | random-looking strings without a matching rule |
| `<REPO>`, `~`, `<HOST>` | working directory, home directory, hostname |

UUIDs, commit SHAs, and file names are kept because they identify the trace.

## Limits

Detection covers known formats. A report can still contain proprietary names,
customer data in tool output, and credentials that no rule matches. The verify
pass re-runs only the rules that exist, so read the report before publishing it.

The entropy pass can replace identifiers that are not secrets. Use
`--no-entropy` to disable it. Add a rule and a fixture when a credential format
is missing; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```console
$ npm test        # node:test suite
$ npm run lint    # syntax check
$ npm run demo    # render the fixture
```

`src/parse.js` reads session formats, `src/redact.js` holds the detectors,
`src/render.js` writes Markdown, `src/index.js` runs the pipeline, and
`bin/sanitrace.js` is the CLI. Fixtures with fake credentials live in `test/`.

Planned work is tracked in [ROADMAP.md](ROADMAP.md).

## License

MIT
