# Contributing

Detectors with a fixture are the easiest change to review. Read
[AGENTS.md](AGENTS.md) before writing documentation, comments, commit messages,
or a pull request body.

## Ground rules

- Keep the runtime dependency count at zero. A dev dependency needs a stated
  reason.
- Redact the rendered report as a whole. Do not redact field by field.
- Do not add network calls. A feature that needs a server goes behind a flag.

## Add a detector

1. Add one object to `RULES` in `src/redact.js` with `id`, `label`,
   `description`, and a global `pattern`. If the match has a prefix worth
   keeping, such as an environment variable name or `Bearer`, add a `replace`
   function that keeps it.
2. Place the rule before generic rules. Order is detection order: specific
   formats first, `HIGH_ENTROPY` last.
3. Add the pattern to `test/redact.test.js` with a fake but realistic value, and
   one case to the fixture in `test/fixtures/`.
4. Run `npm test`. The verify pass must report no matches for every fixture.

Anchor rules with `\b` or a lookaround. Avoid patterns that backtrack
catastrophically, and never match a placeholder such as `[OPENAI_KEY_1]` twice.

For a new or changed detector, use synthetic values in tests and fixtures. Add
positive and near-miss cases to `test/corpus.test.js`. Include examples of
legitimate text that the rule could match. Check overlap with existing rules
and record changes to placeholders or report output in the changelog.

Report a missed credential format through the private process in
[SECURITY.md](SECURITY.md). Do not include real credentials in an issue or
pull request.

## Add a session format

Add a parser to `src/parse.js`, extend `detectFormat`, and add a branch in
`parse`. Detection needs at least two structural signals, and a single common
key such as `messages` is not enough. Parsers are lenient: skip unknown records,
count them in `skipped`, and do not throw.

Add a synthetic fixture under 50 KB in `test/fixtures/`. It needs fake
credentials that match several detectors, a tool result longer than 2,000
characters, an unknown record, and a malformed record when the format is JSONL.
Record the client name, version, capture date, export command or directory, and
the fields you replaced in `test/fixtures/README.md`. Do not commit a real
session. Add tests for detection, the parsed shape, and a clean `sanitize` run.

## Pull requests

- Keep one concern per pull request.
- Make sure `npm test` passes.
- Open a spec in `docs/specs/` before a change that adds a flag, a config key, or
  a session format.
- If a rule can match legitimate text, name the strings it will affect.
- Describe any default that changed and why.

## Release

1. Bump `version` in `package.json` and `VERSION` in `src/render.js`.
2. Add an entry to `CHANGELOG.md`.
3. Check that implemented specs and the index in `docs/specs/README.md` agree.
4. Check that the changelog and `ROADMAP.md` describe the release.
5. Run `npm test`.
6. Run `npm run lint`.
7. Check the CI matrix before release.
8. Create the `vX.Y.Z` tag.
9. Push the tag.
10. Run `npm publish`.
