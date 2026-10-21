# AGENTS.md

## Project

sanitrace reads an agent session log, replaces credentials and local identity,
and writes a Markdown report. Node 20+, ESM, no runtime dependencies, no network
access.

- Test: `npm test`
- Lint: `npm run lint`
- Render the fixture: `npm run demo`

`src/parse.js` reads session formats, `src/redact.js` holds the detectors,
`src/render.js` writes Markdown, and `bin/sanitrace.js` is the CLI. Tests and
fixtures are in `test/`.

## Technical English and writing standards

These rules cover every text a change touches: documentation, comments, test
names, error messages, logs, commit messages, pull request bodies, and reviews.
They are repository policy, not style advice.

### Sentences

- Write direct, neutral technical English in the active voice and present tense.
- Keep one idea per sentence, aim for 25 words or fewer, and use imperative verbs
  for instructions with one action per step.
- Keep established technical terms and use one term for one concept. Do not
  rotate synonyms for variety.
- State behaviour: inputs, outputs, defaults, limits, failure conditions, and
  consequences. Delete any sentence the reader does not need.
- Follow the spelling already in the repository (en-US).

### Prohibited

Never use:

- em dashes (U+2014) in original prose; use a full stop, comma, colon, or
  parentheses
- contrast formulas ("not X but Y", "not just X but also Y", "more than just X"),
  rhetorical questions, and metaphors
- three-part lists and adjective triplets unless the content has exactly three
  items
- openings such as "In today's landscape", "When it comes to", and "In the world
  of"; narration such as "Let's explore" and "In this section, we will"; closings
  such as "In conclusion", "Overall", and "Ultimately"
- promotional or vague vocabulary: "robust", "seamless", "powerful",
  "cutting-edge", "revolutionary", "best-in-class", "delve", "leverage",
  "utilize", "foster", "enhance", "empower", "streamline", "crucial", "pivotal",
  "comprehensive"
- filler ("It is important to note", "This ensures that", "In order to"),
  unsupported intensifiers ("significantly", "extremely", "highly", "easily",
  "simply"), and vague significance claims ("This highlights the importance of",
  "This reflects a commitment to", "This plays a vital role in")
- formulaic sentence structures, repeated transitions, excessive bold,
  decorative headings, emojis, meaningless Markdown sections, contrived
  enthusiasm, and simulated human imperfection

These rules constrain meaning. Do not swap a banned word for a synonym and keep
the sentence.

### Documentation

- Describe the software that exists. Verify every command, flag, default, config
  key, and example against the code before you write it.
- Do not invent features, guarantees, performance numbers, or operational
  details. Remove claims you cannot verify.
- Document the result, not the task. Do not paste prompts, plans, acceptance
  criteria, or conversation text into a repository file.
- Link to the authoritative source instead of restating it. Write procedures as
  steps and reference material as tables or lists. Keep warnings, security
  constraints, and caveats; brevity never removes information the reader needs.

### Code and comments

- Comment intent, invariants, constraints, or trade-offs that the code cannot
  show. Do not restate what the next line does.
- Use existing patterns and plain control flow. Do not add speculative
  abstractions, placeholder TODOs, or ornamental section separators.
- Apply the same standard to identifiers, test names, error messages, and logs.
  Do not carry reasoning or task text into code as commentary.
- Do not edit protocol literals, fixture values, external quotations, or required
  identifiers to satisfy a prose rule.

### Agent communication

- Commit messages, pull request bodies, changelogs, reviews, and task summaries
  follow the same rules.
- Report what changed, why it changed when the reason is not obvious, and what
  was verified. Do not claim tests that did not run.
- Do not add self-congratulatory summaries or ceremonial introductions.

### Examples

Bad: "This robust pipeline seamlessly handles your logs, ensuring your secrets
stay safe."

Good: "The pipeline replaces detected credentials with placeholders before it
writes the report."

Bad: "It is not just a linter, it is a safety net."

Good: "The verify pass runs every detector again over the rendered report."

## Review before you finish

Read every line you wrote or changed. Revise it until all of these hold:

1. Every sentence states a fact, instruction, reason, or constraint.
2. Deleting a sentence would lose information the reader needs.
3. No prohibited phrasing, symmetry, inflated word, or em dash remains.
4. The text describes the result, not the request.
5. Commands, names, defaults, and examples match the code.
6. Terminology matches the rest of the repository.
7. Another engineer would find the text precise and useful.

Do not use AI-detection scores. Editorial judgment and technical accuracy come
first.
