# Contributing

Thanks for helping. The most valuable contributions are new detectors with a
fixture attached.

## Ground rules

- Keep the runtime dependency count at zero. A new dependency needs a strong
  reason; a dev dependency needs a reason.
- Redaction happens on the render's output string, never on a per-field basis.
  New code paths must still pass `--verify`.
- No network calls. If a feature needs a server, it goes behind a flag.

## Adding a detector

1. Add one object to `RULES` in `src/redact.js`: `id`, `label`, `description`,
   and a global `pattern`. If the match includes a prefix worth keeping (an env
   var name, `Bearer`), add a `replace` function that keeps it.
2. Place it before generic rules. Order is detection order: specific formats
   first, `HIGH_ENTROPY` last.
3. Add the pattern to `test/redact.test.js` with a **fake but realistic** value,
   and one case to the "no residual" fixture in `test/fixtures/`.
4. Run `npm test`. `--verify` must stay empty for every fixture.

Rules must be anchored with `\b` or lookarounds, avoid catastrophic
backtracking, and never match a placeholder like `[OPENAI_KEY_1]` twice.

## Adding a session format

Add a parser to `src/parse.js`, extend `detectFormat`, and add an entry to
`parse`. Parsers are lenient: skip unknown records, count them in `skipped`,
never throw. Add a fixture and a test that asserts the parsed shape.

## Pull requests

- One concern per PR.
- `npm test` green; describe the trade-off if you changed defaults.
- If a rule can over-match, say which legitimate strings it will touch.

## Releasing

1. Bump `version` in `package.json` and `src/render.js` (`VERSION`).
2. Update `CHANGELOG.md`.
3. `git tag vX.Y.Z && git push --tags`, then `npm publish`.
