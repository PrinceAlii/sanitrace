# AGENTS.md

## Project

sanitrace reads an agent session log, replaces credentials and local identity,
and writes a Markdown report. Node 20+, ESM, no runtime dependencies, no network
access.

- Test: `npm test`
- Lint: `npm run lint`
- Render the fixture: `npm run demo`

`src/parse.js` reads session formats, `src/redact.js` holds the detectors,
`src/render.js` writes Markdown, `src/index.js` runs the pipeline, and
`bin/sanitrace.js` is the CLI. Tests and fixtures are in `test/`.

## Technical English and writing standards

These rules cover every text a change touches: documentation, comments, test
names, error messages, logs, commit messages, pull request bodies, and reviews.
They are repository policy, not style advice.

### Sentences

- Write direct, neutral technical English in the active voice and present tense.
- Keep one idea per sentence, aim for 25 words or fewer, and use imperative
  verbs for instructions with one action per step.
- Keep established technical terms and use one term for one concept. Do not
  rotate synonyms for variety.
- State behaviour: inputs, outputs, defaults, limits, failure conditions, and
  consequences. Delete any sentence the reader does not need.
- Follow the spelling already in the repository (en-US).

### Prohibited

Never use:

- em dashes (U+2014) in original prose; use a full stop, comma, colon, or
  parentheses
- contrast formulas ("not X but Y", "not just X but also Y"), three-part lists
  and adjective triplets unless the content has exactly three items, rhetorical
  questions, or metaphors
- openings and narration such as "In today's landscape", "When it comes to",
  "Let's explore", "In this section, we will", and "As mentioned earlier"
- closings such as "In conclusion", "Overall", and "Ultimately", or a summary
  that repeats the text above it
- promotional or vague vocabulary: "robust", "seamless", "powerful",
  "cutting-edge", "revolutionary", "best-in-class", "delve", "leverage",
  "utilize", "foster", "enhance", "empower", "streamline", "crucial", "pivotal",
  "comprehensive"
- filler ("It is important to note", "This ensures that", "In order to") and
  unsupported intensifiers ("significantly", "extremely", "highly", "easily",
  "simply")
- emojis, decorative headings, anthropomorphism, and bold text used for emphasis
  instead of structure

These rules constrain meaning. Do not swap a banned word for a synonym and keep
the sentence.

### Documentation

- Describe the software that exists. Verify every command, flag, default,
  config key, and example against the code before you write it.
- Do not invent features, guarantees, performance numbers, or operational
  details. Remove claims you cannot verify.
- Document the result, not the task. Do not paste prompts, plans, acceptance
  criteria, or conversation text into a repository file.
- Link to the authoritative source instead of restating it, and do not duplicate
  content that lives elsewhere.
- Write procedures as steps, reference material as tables or lists, and
  explanations as explanations. Keep warnings, security constraints, and
  caveats; brevity never removes information the reader needs.

### Code and comments

- Comment intent, invariants, constraints, or trade-offs that the code cannot
  show. Do not restate what the next line does.
- Use existing patterns and plain control flow. Do not add abstractions,
  placeholders, TODOs, or scaffolding for imagined future work.
- Apply the same standard to identifiers, test names, error messages, and logs.
  Do not carry reasoning or task text into code as commentary.
- Do not edit protocol literals, fixture values, external quotations, or
  required identifiers to satisfy a prose rule.

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
