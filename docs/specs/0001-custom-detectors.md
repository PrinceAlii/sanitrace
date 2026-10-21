# 0001: Custom detectors

Status: Implemented
Target: 0.2.0
Depends on: none

## Problem

The detector list is fixed in `src/redact.js`. A team that uses an internal
credential format, such as `acme_` tokens, can patch the package, rely on the
entropy pass, or accept the miss. The entropy pass may skip a short token and
may replace unrelated strings. `--allow` and `--disable` change the built-in
list but cannot add to it.

A custom rule must behave like a built-in rule: it produces a placeholder, runs
during `--verify`, appears in `--json` findings, respects `--allow` and
`--disable`, and appears in `sanitrace rules`.

## Goals

- Declare regex rules in `.sanitrace.json`.
- Load additional rules from a local ESM module when a pattern must be computed.
- Keep rule order deterministic and documented.
- Reject an invalid rule before the session log is read.
- Keep the runtime dependency count at zero and add no network access.

## Non-goals

- A remote rule registry or automatic downloads.
- Sandboxing module code. Node runs it with the user's privileges.
- Overriding a built-in rule id.
- Proving that a pattern is safe against catastrophic backtracking.
- A `replace` callback in the stable API. `keepGroup` covers the prefix cases
  that the built-in rules use.

## Proposal

### Config

Two keys are added to `.sanitrace.json`:

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

`customRules` is an array of objects. `ruleModules` is an array of local ESM
paths. Module paths are resolved relative to the directory that contains the
config file, not the working directory. A path given with `--rule-module` is
resolved relative to the working directory.

### Rule object

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Lowercase, `^[a-z][a-z0-9-]{1,31}$`, unique |
| `label` | yes | Uppercase, `^[A-Z][A-Z0-9_]{1,31}$`, unique |
| `description` | yes | 5 to 120 characters, single line |
| `pattern` | yes | String in config, string or RegExp in a module |
| `flags` | no | Any of `i`, `m`, `s`. `g` is added by the engine |
| `keepGroup` | no | Capture group number, 1 or greater |

The placeholder is `[LABEL_N]`, where `N` starts at 1 for each rule id.
Repeated values reuse the same placeholder within one run, which matches the
behavior of `placeholderFor` in `src/redact.js`.

`keepGroup` keeps the text of that capture group before the placeholder. A rule
with the pattern `\b(ACME_TOKEN=)acme_[A-Za-z0-9]{24}\b` and `keepGroup: 1`
produces `ACME_TOKEN=[ACME_TOKEN_1]`. If the group does not participate in a
match, the rule inserts the placeholder without a prefix.

Limits: 50 custom rules in total, 1,000 characters per pattern, and 20,000
characters across all patterns. A pattern that matches an empty string is
rejected. Test the pattern against `''` and `'a b'`; a match with length 0 is an
error even when the source text is not empty.

### Module contract

A module default-exports an array of rule objects:

```js
// tools/sanitrace-rules.mjs
export default [
  {
    id: 'employee-id',
    label: 'EMPLOYEE_ID',
    description: 'Internal employee identifiers',
    pattern: /\bEMP-\d{6}\b/g,
  },
];
```

Modules exist for computed patterns and for patterns that are easier to read as
regex literals. The module executes during config load. A module can do anything
the user can do, including network access. `sanitrace` never imports a module
from a URL, a `node:` specifier, or a `data:` URL.

### CLI

- `--rule-module <path>` loads a module without a config entry. The flag is
  repeatable.
- `sanitrace rules` keeps its first three tab-separated columns and appends a
  fourth column named `source`: `builtin`, `config:<path>`, or
  `module:<path>`.
- `--allow` and `--disable` accept values and ids from custom rules.

`printRules()` currently returns before `loadConfig()` runs. Move the config
load before the `rules` branch so the listing includes custom rules and module
rules. A missing or invalid config still exits 2. `rules()` keeps its current
signature and returns the built-in list; the CLI adds the source column.

### Order

Custom rules run after the built-in `RULES` list and before path mapping and the
entropy pass:

1. Built-in rules, in source order.
2. `customRules`, in declaration order.
3. `ruleModules` from the config, in config order.
4. `--rule-module` values, in flag order.
5. Path mapping.
6. Entropy.

Built-ins run first so existing reports keep the same placeholders. Custom
rules run before entropy so a specific format wins over the generic fallback.

## Behavior

- No `customRules` and no `ruleModules`: output is unchanged.
- A custom rule that matches text already replaced by a built-in rule does not
  see the original value. It sees the placeholder.
- A custom rule can match a placeholder produced by an earlier rule. `--verify`
  reports the result if the match survives the `isPlaceholder` check, and the
  CLI exits 3 unless `--no-verify` is set. Choose a label and pattern that do not
  match each other.
- Findings from custom rules use the same shape as built-in findings:
  `{ rule, label, count, samples }`.
- Custom labels join `PLACEHOLDER_LABELS`, so `verify()` treats
  `[ACME_TOKEN_1]` as a placeholder and does not flag it as a leftover.
- The redaction table shows the custom label. The count covers occurrences.
- The report never prints the rule description.

## Failure modes

All config and module errors exit 2 before the input file is read.

| Condition | Message contains |
| --- | --- |
| Unknown field in a rule object | File, rule index, field name |
| Invalid `id`, `label`, or `description` | File, rule index, expected format |
| Duplicate id or label | The id or label and both sources |
| Pattern does not compile | Rule id and the regex error |
| Pattern matches an empty string | Rule id |
| `flags` contains a flag outside `i`, `m`, `s` | Rule id and the allowed flags |
| More than 50 rules or the pattern length limit | The limit and the current count |
| Module file does not exist | Resolved path |
| Module import throws | Path and the error message |
| Default export is not an array | Path and the received type |
| A module rule is invalid | Path, rule index, and the same field errors |

## Security

Custom rules are local input. A config file contains patterns, not credentials.
A module file contains code. Treat both like `package.json` scripts: read them
before you run them.

The Node regex engine has no timeout. A pattern with catastrophic backtracking
can block the process for as long as it runs. The length limits reduce the
surface but do not remove it. Do not accept rule files from an untrusted source.

Error messages and the `rules` listing never include matched values. Findings
samples, including samples for custom rules, contain up to 40 characters of the
matched text and are available through `--json`. This is existing behavior.

A custom rule runs before the entropy pass. A broad rule can consume text that
the entropy pass would otherwise replace, and a narrow rule can miss a format
that entropy would catch. Review the rule against a real fixture.

## Test plan

Unit tests:

- A JSON rule replaces a match and adds a finding.
- `keepGroup` keeps the prefix and numbers placeholders per rule.
- The same value reuses one placeholder across multiple occurrences.
- `--allow` skips a custom match.
- `--disable` skips a custom rule by id.
- The `sanitrace rules` output includes the custom rule with the correct
  `source`.
- `verify()` reports text that a custom rule would match again.
- Every validation error in the table has a CLI test that asserts exit 2.

CLI tests:

- `--rule-module` loads a module from a temporary directory.
- A config-relative module path resolves when the command runs from another
  directory.
- `--json` includes custom findings and no rule descriptions.
- `--check` exits 1 when only a custom rule matched.

Fixtures:

- `test/fixtures/custom-rules/` with a config, a module, a small log, and the
  expected placeholder list. The log uses fake values only.
- One negative case: a pattern that looks like a token but is in `--allow` and
  must remain unchanged.

Cross-platform:

- Module loading uses `pathToFileURL` on every platform.
- The fixture test passes on Windows, macOS, and Linux.

## Rollout

Release 0.2.0. Add `customRules` and `ruleModules` to `KNOWN_KEYS` and the
config type checks. Update README with a short section and a warning that a
module is executable code. Add the `source` column to `sanitrace rules` and note
the change in `CHANGELOG.md`.

## Open decisions

- A regex form for `--allow` is deferred. Exact values are simpler and already
  work.
- A custom rule cannot replace a built-in rule with the same id. `--disable`
  plus a new id is explicit.
- A `replace` callback in modules is deferred until `keepGroup` is shown to be
  insufficient.
- Named rule packs are not planned. A module can export a computed list.
