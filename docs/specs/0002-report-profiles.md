# 0002: Report profiles

Status: Accepted
Target: 0.2.0
Depends on: none

## Problem

`src/render.js` hardcodes one report shape: metadata, redactions, "What
happened", "Expected", and the transcript. The prompts fit a bug report. A
security disclosure needs impact and reproduction sections. A code review needs
changes and verification. Users edit the generated Markdown by hand, which
breaks the redaction table placement and adds work to every report.

The summary insertion in `src/index.js` also depends on the literal
`## What happened` heading. A new section list must not preserve that coupling.

## Goals

- Add three profiles: `bug` (default), `security`, and `review`.
- Select a profile with `--profile` or the `profile` config key.
- Keep the redaction table in every profile.
- Keep the default `bug` report unchanged from 0.1.1.
- Record the profile in `--json` output and in the metadata of non-default
  reports.

## Non-goals

- User-defined templates or arbitrary sections.
- Changing detectors, the allow list, entropy, or truncation per profile.
- Localization.
- Changing the exit codes.

## Proposal

### CLI and config

```console
$ sanitrace session.jsonl --profile security
$ sanitrace session.jsonl --profile review -o review.md
```

- `--profile <name>` defaults to `bug`.
- `.sanitrace.json` accepts `"profile": "security"`.
- The CLI value overrides the config value.
- Valid names are lowercase and exact: `bug`, `security`, `review`.
- An unknown name exits 2 before the input is read and lists the valid names.
- `--json` adds `"profile": "<name>"` next to `findings`, `residual`, and
  `markdown`. The field is additive.

### Sections

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

Each narrative section has one short HTML comment with a prompt. The `bug`
prompts stay as they are in 0.1.1. Example prompts:

- `security` / Summary: "Describe what went wrong and the security impact."
- `security` / Reproduction: "List the commands or steps that trigger the
  problem."
- `review` / Verification: "Describe what you ran to check the change."
- `review` / Risks: "Describe what could break and what remains untested."

The prompts contain no user text, so redaction leaves them unchanged.

### Metadata

`bug` keeps the current rows and order, so its output is unchanged.

`security` and `review` add one row after `Format`:

```markdown
| Profile | `security` |
```

The redaction table keeps the current format in every profile.

### Summary insertion

`render()` replaces the hardcoded summary insertion point with a marker. When
the caller passes `summary: false`, the output contains the marker instead of
the table:

```markdown
<!-- sanitrace:redactions -->
```

`sanitize()` renders the report without the table, redacts the text, and
replaces the marker with the table. The marker is an HTML comment, so it does
not render and it cannot contain a secret. If the marker is missing,
`sanitize()` appends the table before the transcript so the report stays valid.

## Behavior

- `--profile bug` produces the same bytes as 0.1.1 for the same input and
  options. Existing tests and the demo output must not change.
- `security` and `review` change the title, the body headings, the prompt text,
  and the metadata row. They do not change the metadata values, the transcript,
  the tool output, or the redaction table.
- The profile does not change detector behavior. `--no-outputs`,
  `--no-entropy`, `--keep-reasoning`, and the other flags keep their meaning.
- The transcript budget still applies to rendered turns. Profile headings and
  prompts sit outside that calculation, as the current header does.
- `sanitrace rules` does not change.
- The report footer keeps the version line.

## Failure modes

| Condition | Result |
| --- | --- |
| `--profile` is missing a value | Exit 2 with the usage text |
| Profile is unknown or has uppercase letters | Exit 2, list `bug`, `security`, `review` |
| `profile` in config is not a string | Exit 2, name the config file and key |
| Marker is missing at summary insertion | Append the table before `## Transcript` |
| Report has no transcript | Append the table at the end |

## Security

The profile changes layout only. It must not disable a detector, lower the
entropy threshold, or drop tool output by default. The security profile must not
hide evidence.

The `security` profile keeps tool output. A user who needs a smaller disclosure
can pass `--no-outputs`; that flag already exists and stays explicit.

## Test plan

- Snapshot the full report for each profile from the Codex fixture.
- Assert that the `bug` snapshot matches the 0.1.1 output, including the title,
  metadata rows, prompts, and footer.
- Assert the heading order for `security` and `review`.
- Assert that every profile contains `## Redactions` and a table when findings
  exist, and the "No redactions were needed." line when none exist.
- Assert that `--profile` overrides `profile` in the config.
- Assert exit 2 for an unknown profile and for a non-string config value.
- Assert the `profile` field in `--json` for each value and the default.
- Run the fixture with a small `--max-total` and a profile to confirm the budget
  logic still elides turns and closes fences.

## Rollout

Release 0.2.0. Add `profile` to `KNOWN_KEYS` and the config validation. Update
the CLI help and README with a table of profiles and their sections. Add a
CHANGELOG entry that states the default output is unchanged.

## Open decisions

- The `security` profile does not default to `--no-outputs`. That would hide
  evidence.
- Per-section selection is not planned. The three fixed profiles cover the
  current use cases.
- Custom templates are a later spec and may reuse the section model.
