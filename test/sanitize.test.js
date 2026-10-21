import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { detectFormat, parse, sanitize } from '../src/index.js';

const codex = readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8');
const claude = readFileSync(new URL('./fixtures/claude-transcript.jsonl', import.meta.url), 'utf8');

test('detects formats', () => {
  assert.equal(detectFormat(codex), 'codex');
  assert.equal(detectFormat(claude), 'claude');
  assert.equal(detectFormat('just a pasted log'), 'text');
});

test('parses codex records and pairs tool output', () => {
  const parsed = parse(codex);
  assert.equal(parsed.format, 'codex');
  assert.equal(parsed.meta.model, 'gpt-6.1');
  assert.equal(parsed.toolCalls, 1);
  const kinds = parsed.turns.flatMap((turn) => turn.blocks.map((block) => block.kind));
  assert.deepEqual(kinds, ['text', 'reasoning', 'tool', 'output', 'text']);
});

test('parses claude records', () => {
  const parsed = parse(claude);
  assert.equal(parsed.format, 'claude');
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.turns.length, 3);
});

test('renders a redacted report with no residual secrets', () => {
  const { markdown, findings, residual } = sanitize(codex);
  assert.equal(residual.length, 0, JSON.stringify(residual));
  assert.ok(findings.length >= 5);

  for (const secret of [
    'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t',
    'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'AKIAIOSFODNN7EXAMPLE',
    'S3cretPassw0rd',
    'dev@acme-internal.example',
    '10.4.22.19',
  ]) {
    assert.ok(!markdown.includes(secret), `leaked ${secret}`);
  }

  assert.ok(!markdown.includes('/Users/ali'), 'leaked home path');
  assert.match(markdown, /\[OPENAI_KEY_1\]/);
  assert.match(markdown, /<REPO>/);
  assert.match(markdown, /## Redactions/);
});

test('text fallback keeps the transcript verbatim', () => {
  const { markdown } = sanitize('plain text with no .jsonl wrapper');
  assert.match(markdown, /plain text with no \.jsonl wrapper/);
});

test('sanitize respects disabled rules and allow lists', () => {
  const { markdown } = sanitize(codex, { emails: false, allow: ['AKIAIOSFODNN7EXAMPLE'] });
  assert.match(markdown, /dev@acme-internal\.example/);
  assert.match(markdown, /AKIAIOSFODNN7EXAMPLE/);
});

test('reasoning and outputs can be dropped', () => {
  const { markdown } = sanitize(codex, { reasoning: false, outputs: false });
  assert.ok(!markdown.includes('reasoning summary'));
  assert.ok(!markdown.includes('<summary>output'));
});

test('keeps the report under the total budget', () => {
  const { markdown } = sanitize(codex, { maxTotal: 900 });
  assert.ok(markdown.length < 2000, `report was ${markdown.length} chars`);
  assert.match(markdown, /chars cut|elided/);
});
