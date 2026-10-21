import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { detectFormat, parse, sanitize } from '../src/index.js';

const FORMATS = ['codex', 'claude', 'opencode', 'gemini', 'text'];
const FORMAT_SET = new Set(FORMATS);

const fixtures = {
  codex: readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8'),
  claude: readFileSync(new URL('./fixtures/claude-transcript.jsonl', import.meta.url), 'utf8'),
  opencode: readFileSync(new URL('./fixtures/opencode-session.json', import.meta.url), 'utf8'),
  gemini: readFileSync(new URL('./fixtures/gemini-session.jsonl', import.meta.url), 'utf8'),
  text: 'plain pasted transcript\nwith a fake key sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t\n',
};

// mulberry32: small deterministic PRNG so a failure reproduces from the seed.
function createRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = '{}[]":,.\n\t xyzABC019-_\\/*&%$#@!';
const FRAGMENTS = [
  '{',
  '}',
  '[',
  ']',
  'null',
  'true',
  'false',
  '"type":"session_meta"',
  '"model_provider":',
  '"messages":',
  '"info":',
  '"sessionId":',
  '"projectHash":',
  '{"a":1}',
];

function noise(random, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += NOISE[Math.floor(random() * NOISE.length)];
  }
  return out;
}

// Each case applies one mutation to a fixture. The mutation kinds cover
// truncation, byte insertion, byte replacement, line joining, line
// duplication, JSON fragments, and random short strings.
function mutate(text, random) {
  const kind = Math.floor(random() * 7);
  const position = Math.floor(random() * Math.max(1, text.length));

  if (kind === 0) return text.slice(0, position);
  if (kind === 1) return text.slice(0, position) + noise(random, 1 + Math.floor(random() * 12)) + text.slice(position);
  if (kind === 2) {
    const length = 1 + Math.floor(random() * 16);
    return text.slice(0, position) + noise(random, length) + text.slice(position + length);
  }
  if (kind === 3) return text.split('\n').join(' ');
  if (kind === 4) {
    const lines = text.split('\n');
    const at = Math.floor(random() * Math.max(1, lines.length));
    const copy = lines.slice();
    copy.splice(at, 0, lines[at] ?? '');
    return copy.join('\n');
  }
  if (kind === 5) return text.slice(0, position) + FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] + text.slice(position);
  return noise(random, 1 + Math.floor(random() * 40));
}

function assertParseShape(parsed, format) {
  assert.equal(typeof parsed.format, 'string');
  if (format) assert.equal(parsed.format, format);
  assert.ok(FORMAT_SET.has(parsed.format), parsed.format);

  assert.deepEqual(Object.keys(parsed.meta).sort(), [
    'cliVersion',
    'cwd',
    'endedAt',
    'model',
    'sessionId',
    'source',
    'startedAt',
  ]);

  assert.ok(Array.isArray(parsed.turns));
  for (const turn of parsed.turns) {
    assert.equal(typeof turn.role, 'string');
    assert.ok(Array.isArray(turn.blocks));
    for (const block of turn.blocks) {
      assert.equal(typeof block.kind, 'string');
      assert.equal(typeof block.text, 'string');
      assert.equal(typeof block.originalChars, 'number');
      assert.ok(block.originalChars >= block.text.length - 80, 'originalChars covers the clipped text');
    }
  }

  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) {
    assert.equal(typeof parsed.usage[key], 'number');
  }
  assert.equal(typeof parsed.skipped, 'number');
  assert.equal(typeof parsed.toolCalls, 'number');
}

test('detectFormat returns a known format for mutated fixtures', () => {
  for (const [index, format] of FORMATS.entries()) {
    const random = createRandom(0x5eed0000 + index);
    for (let run = 0; run < 60; run += 1) {
      const input = mutate(fixtures[format], random);
      const detected = detectFormat(input);
      assert.ok(FORMAT_SET.has(detected), `detectFormat returned ${detected}`);
    }
  }
});

test('parse never throws and returns the documented shape', () => {
  for (const [index, format] of FORMATS.entries()) {
    const random = createRandom(0x5eed0100 + index);
    for (let run = 0; run < 60; run += 1) {
      const input = mutate(fixtures[format], random);
      assertParseShape(parse(input), null);

      for (const explicit of FORMATS) {
        assertParseShape(parse(input, { format: explicit }), explicit);
      }
    }
  }
});

// Empty input keeps the requested format. The JSON formats produce no turns.
// The text fallback keeps one transcript block with empty text.
test('parse keeps the requested format when the input is empty', () => {
  for (const format of FORMATS) {
    const parsed = parse('', { format });
    assert.equal(parsed.format, format);

    if (format === 'text') {
      assert.deepEqual(parsed.turns, [
        { role: 'transcript', blocks: [{ kind: 'text', text: '', originalChars: 0 }] },
      ]);
    } else {
      assert.deepEqual(parsed.turns, []);
    }
  }
});

test('sanitize returns a report string and a residual array for fuzz cases', () => {
  for (const [index, format] of FORMATS.entries()) {
    const random = createRandom(0x5eed0200 + index);
    for (let run = 0; run < 8; run += 1) {
      const input = mutate(fixtures[format], random);
      const result = sanitize(input);

      assert.equal(typeof result.markdown, 'string');
      assert.ok(Array.isArray(result.residual));
      assert.ok(Array.isArray(result.findings));
      for (const residual of result.residual) {
        assert.equal(typeof residual.rule, 'string');
        assert.equal(typeof residual.sample, 'string');
      }
    }
  }
});
