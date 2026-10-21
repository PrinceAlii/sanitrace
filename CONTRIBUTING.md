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

## Add a session format

Add a parser to `src/parse.js`, extend `detectFormat`, and add a branch in
`parse`. Parsers are lenient: skip unknown records, count them in `skipped`,
and do not throw. Add a fixture and a test that asserts the parsed shape.

## Pull requests

- Keep one concern per pull request.
- Make sure `npm test` passes.
- If a rule can match legitimate text, name the strings it will affect.
- Describe any default that changed and why.

## Release

1. Bump `version` in `package.json` and `VERSION` in `src/render.js`.
2. Add an entry to `CHANGELOG.md`.
3. `git tag vX.Y.Z`, push the tag, then run `npm publish`.
