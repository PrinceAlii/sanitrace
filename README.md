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

- Parses Codex rollouts, Claude Code transcripts, OpenCode exports, Gemini CLI
  transcripts, and plain text, and detects the format.
- Replaces detected credentials and addresses with numbered placeholders such
  as `[OPENAI_KEY_1]`. Thirteen built-in detectors, an entropy pass, and path
  mapping cover the common cases. Custom rules add formats from the config or a
  local ESM module.
- Drops reasoning summaries and developer/system messages by default, and
  truncates tool output to 2000 characters.
- Budgets reports at 120,000 characters by scaling block text, then eliding
  middle turns.
- Writes `bug`, `security`, or `review` reports with profile-specific sections
  and prompts.
- Writes redacted plain text with `--raw` when the input has no session
  structure.
- Compares two reports with `sanitrace diff` and shows changed, added, and
  removed turns.
- Writes an encrypted placeholder mapping on request, with no plaintext map on
  disk.
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
$ sanitrace notes.txt --raw                 # redacted plain text
$ sanitrace diff old.md new.md              # compare two reports
$ sanitrace mapping show report.map         # decrypt a mapping
```

Flags: `--profile <name>`, `--mapping <file>`,
`--mapping-passphrase-env <name>`, `--force`, `--rule-module <path>`
(repeatable), `--allow <value>` (never redact, repeatable), `--no-emails`,
`--no-ips`, `--no-entropy`, `--no-outputs`, `--keep-reasoning`,
`--keep-developer`, `--max-tool-chars <n>`, `--max-total <n>`, `--json`,
`--format`, `--raw`.

The verify pass runs by default. Pass `--no-verify` to skip the second
detection pass.

## Session formats

sanitrace detects the input format from the file structure. `--format <name>`
overrides detection when a file is ambiguous.

| Format | Input |
| --- | --- |
| `codex` | Codex rollout JSONL |
| `claude` | Claude Code transcript JSONL |
| `opencode` | JSON from `opencode session export <sessionID>` |
| `gemini` | Gemini CLI JSONL under `~/.gemini/tmp/<project>/chats/` |
| `text` | Any other input. Use `--raw` to write redacted text without a report. |

Codex and Claude are checked first. OpenCode checks the `info` envelope and the
typed messages. Gemini checks the `sessionId` and `projectHash` header and a
Gemini event or `toolCalls` array.

Cursor is not supported. Cursor stores chats in a SQLite database, and
sanitrace does not read SQLite.

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

## Plain text

`--raw` skips the session parser and the report renderer. It reads the input as
text and writes the same text with placeholders for detected values. The input
is not clipped at the 6,000 character block limit, so a pasted terminal log
keeps its content.

```console
$ sanitrace notes.txt --raw
$ cat session.log | sanitrace - --raw
$ sanitrace notes.txt --raw -o notes.redacted.txt
$ sanitrace notes.txt --raw --json
```

`--raw` implies `--format text`. `--format` accepts only `auto` or `text` in
this mode. The detector flags and config keys apply, including `--allow`,
`--disable`, `--keep-path`, `--no-entropy`, `--no-emails`, `--no-ips`,
`--config`, and `--rule-module`.

Raw mode maps the working directory to `<REPO>`, the home directory and
`/Users/<user>` or `/home/<user>` to `~`, and the hostname to `<HOST>`.

`--json` returns `{ "text": "...", "findings": [...], "residual": [] }`. The
report-only flags `--profile`, `--mapping`, `--mapping-passphrase-env`,
`--force`, `--max-total`, `--max-tool-chars`, `--keep-reasoning`,
`--keep-developer`, and `--no-outputs` exit 2 with `--raw`. `--check` and
`--no-verify` keep their report-mode meaning.

## Diff reports

`sanitrace diff` compares the transcript sections of two reports and shows the
unchanged, changed, added, and removed turns.

```console
$ sanitrace diff old.md new.md
$ sanitrace diff old.md new.md --json
$ sanitrace diff old.md new.md -o diff.md
```

The command exits 0 when the transcripts are identical, 1 when a turn changed,
was added, or was removed, and 2 for usage or read errors. It writes the output
before it exits 1.

Reports from sanitrace 0.4.0 or later contain a content identifier for every
turn. The identifier is a short SHA-256 digest of the redacted turn text, so it
does not expose a secret. `diff` recomputes the identifiers from the report
text, so an edited report still compares. A report without turn markers exits 2;
regenerate it with the current version.

`diff` compares only the transcript. Metadata rows, narrative sections, and the
redaction table are ignored. The output repeats report text and has the same
sensitivity as the reports.

## Mapping

`--mapping <file>` writes an encrypted placeholder-to-original map when the
report is written.

```console
$ export SANITRACE_MAPPING_PASSPHRASE='correct horse battery staple'
$ sanitrace session.jsonl -o report.md --mapping report.map
$ sanitrace mapping show report.map --report report.md
```

The passphrase comes from `SANITRACE_MAPPING_PASSPHRASE`. Set
`--mapping-passphrase-env <name>` to read another uppercase environment
variable. The value must be at least 12 characters; use 16 or more. The
passphrase never appears in `argv`.

`mapping show` prints the decrypted JSON to stdout and one warning line to
stderr. It does not write a file. `--report <file>` recomputes the SHA-256
digest of the Markdown report and exits 2 when it differs. With `--json`, pass
the Markdown report, not the JSON payload.

The mapping holds original secrets. Treat it as sensitive as the session log.
Store it outside the repository or add it to `.gitignore`. The file uses scrypt
and AES-256-GCM and is written with mode `0600` where the platform supports it.
It contains no plaintext mapping. The report and `--json` output never contain
the mapping.

`--force` replaces an existing mapping file. It does not overwrite the report.
Without `--force`, an existing mapping is an error. A symlink at the mapping
path is rejected even with `--force`. The mapping is written even when
`--check` exits 1 or `--verify` exits 3.

Mapping export uses `node:crypto` and adds no runtime dependency.

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

## Custom detectors

Add a regex rule to `.sanitrace.json` when a credential format is missing:

```json
{
  "customRules": [
    {
      "id": "acme-token",
      "label": "ACME_TOKEN",
      "description": "Acme service tokens",
      "pattern": "\\bacme_[A-Za-z0-9]{24}\\b"
    }
  ],
  "ruleModules": ["./tools/sanitrace-rules.mjs"]
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Lowercase, 2 to 32 characters: letters, digits, hyphens |
| `label` | yes | Uppercase, 2 to 32 characters: letters, digits, underscores |
| `description` | yes | 5 to 120 characters on one line |
| `pattern` | yes | Regex source string |
| `flags` | no | Any of `i`, `m`, `s` |
| `keepGroup` | no | Capture group number, 1 or greater |

Rule ids and labels must be unique and must not reuse a built-in id or label.

The placeholder is `[LABEL_N]`. A repeated value keeps the same placeholder, and
the count covers every occurrence. `keepGroup` keeps the text of that capture
group before the placeholder. If the group does not participate, the placeholder
appears alone. The report shows the label and never prints the description.

Custom rules run after the built-in detectors and before path mapping and the
entropy pass. The order is `customRules`, then `ruleModules` in config order,
then `--rule-module` in flag order. Config module paths resolve relative to the
config file directory. `--rule-module` paths resolve relative to the working
directory.

A rule module default-exports an array of rule objects:

```js
export default [
  {
    id: 'employee-id',
    label: 'EMPLOYEE_ID',
    description: 'Internal employee identifiers',
    pattern: /\bEMP-\d{6}\b/g,
  },
];
```

In a module, patterns may be strings or regex literals. Literal `i`, `m`, and
`s` flags are allowed, and `g` is added when missing. `sanitrace rules` adds a
`source` column with `builtin`, `config:<path>`, or `module:<path>`.

Limits: 50 custom rules, 1,000 characters per pattern, and 20,000 characters
across all patterns. A pattern that matches an empty string is rejected.
`--allow` matches custom rule values, and `--disable` accepts custom rule ids.

A rule module runs as executable code with your privileges, including network
access. Read a module before you run it. The regex engine has no timeout, so a
pattern with catastrophic backtracking can block the process. Do not load rule
files from an untrusted source.

## GitHub Action

The composite action installs an exact sanitrace version, runs it on a session
log, uploads `report.md` and `report.json`, and can update one issue or pull
request comment.

```yaml
permissions:
  contents: read
  issues: write

steps:
  - uses: actions/checkout@v4
  - uses: PrinceAlii/sanitrace@v0.4.0
    with:
      path: logs/session.jsonl
      profile: security
      comment: true
      issue-number: ${{ github.event.issue.number }}
```

The action uploads only the report and findings JSON, never the input log.
`comment: true` needs `issues: write` for an issue or `pull-requests: write` for
a pull request. Without `issue-number`, the action reads the number from the
event payload. `fail-on-redaction: true` maps to `--check`. A residual match
exits 3 and is never commented.

`version` accepts an exact semver and defaults to the version in the action
`package.json`. The `local` value installs the action checkout and is reserved
for this repository's self-test. The action runs on `ubuntu-latest` with Node
22. Windows and macOS runners are not supported.

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
pass re-runs only the rules that exist, so read the report or raw text before
publishing it.

The entropy pass can replace identifiers that are not secrets. Use
`--no-entropy` to disable it. Use a custom rule for an internal format, or add a
built-in rule and a fixture; see [CONTRIBUTING.md](CONTRIBUTING.md).

`sanitrace diff` reads reports, not session logs. It does not re-run detectors
and it does not remove text that was present in the input reports.

## Development

```console
$ npm test        # node:test suite
$ npm run lint    # syntax check
$ npm run demo    # render the fixture
```

`src/parse.js` reads session formats, `src/redact.js` holds the detectors,
`src/render.js` writes Markdown, `src/diff.js` compares reports, `src/index.js`
runs the pipeline, and `bin/sanitrace.js` is the CLI. Fixtures with fake
credentials live in `test/`.

Planned work is tracked in [ROADMAP.md](ROADMAP.md).

## License

MIT
