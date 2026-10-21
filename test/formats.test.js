import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sanitize } from '../src/index.js';
import { detectFormat, parse } from '../src/parse.js';

const openCode = readFileSync(new URL('./fixtures/opencode-session.json', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-session.jsonl', import.meta.url), 'utf8');
const codex = readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8');
const claude = readFileSync(new URL('./fixtures/claude-transcript.jsonl', import.meta.url), 'utf8');

function blocksOf(parsed) {
  return parsed.turns.flatMap((turn) => turn.blocks);
}

test('detects and parses the OpenCode export', () => {
  assert.equal(detectFormat(openCode), 'opencode');

  const parsed = parse(openCode);
  assert.equal(parsed.format, 'opencode');
  assert.deepEqual(parsed.meta, {
    cwd: '/Users/example/project',
    model: 'example-model-1',
    cliVersion: null,
    startedAt: '2026-10-21T08:00:00.000Z',
    endedAt: '2026-10-21T08:00:32.000Z',
    source: 'OpenCode',
    sessionId: 'ses_7f3a2b1c4d5e6f708192a3b4c5',
  });
  assert.deepEqual(parsed.usage, { inputTokens: 12034, outputTokens: 842, cachedTokens: 512 });
  assert.deepEqual(parsed.turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.deepEqual(
    blocksOf(parsed).map((block) => block.kind),
    ['text', 'reasoning', 'text', 'tool', 'output'],
  );
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.skipped, 1);

  const tool = blocksOf(parsed).find((block) => block.kind === 'tool');
  assert.equal(tool.name, 'shell');
  assert.match(tool.text, /npm run preflight/);

  const output = blocksOf(parsed).find((block) => block.kind === 'output');
  assert.equal(output.originalChars, 4249);
  assert.match(output.text, /truncated 2249 of 4249 chars/);
});

test('detects and parses the Gemini CLI transcript', () => {
  assert.equal(detectFormat(gemini), 'gemini');

  const parsed = parse(gemini);
  assert.equal(parsed.format, 'gemini');
  assert.deepEqual(parsed.meta, {
    cwd: '/Users/example/project',
    model: 'gemini-3.1-pro-preview',
    cliVersion: null,
    startedAt: '2026-10-21T08:00:00.000Z',
    endedAt: '2026-10-21T08:00:09.000Z',
    source: 'Gemini CLI',
    sessionId: '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  });
  assert.deepEqual(parsed.usage, { inputTokens: 20433, outputTokens: 192, cachedTokens: 9216 });
  assert.deepEqual(parsed.turns.map((turn) => turn.role), ['user', 'assistant', 'assistant']);
  assert.deepEqual(
    blocksOf(parsed).map((block) => block.kind),
    ['text', 'reasoning', 'reasoning', 'tool', 'output', 'text'],
  );
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.skipped, 2);

  const tool = blocksOf(parsed).find((block) => block.kind === 'tool');
  assert.equal(tool.name, 'run_shell_command');
  assert.equal(tool.text, 'cat .env && npm run preflight');

  const output = blocksOf(parsed).find((block) => block.kind === 'output');
  assert.equal(output.originalChars, 3636);
  assert.match(output.text, /truncated 1636 of 3636 chars/);
});

test('empty input for an explicit format returns zero turns', () => {
  for (const format of ['opencode', 'gemini']) {
    const parsed = parse('', { format });
    assert.equal(parsed.format, format);
    assert.equal(parsed.turns.length, 0);
    assert.equal(parsed.skipped, 0);
  }
});

test('maps an OpenCode version field to cliVersion', () => {
  const document = {
    info: { id: 'ses_example', version: '2.1.1', tokens: {}, time: {} },
    messages: [],
  };

  const parsed = parse(JSON.stringify(document), { format: 'opencode' });
  assert.equal(parsed.meta.source, 'OpenCode');
  assert.equal(parsed.meta.cliVersion, '2.1.1');
});

test('malformed OpenCode documents return an empty result', () => {
  for (const input of ['{"info":', '[]', '{"messages":[]}']) {
    const parsed = parse(input, { format: 'opencode' });
    assert.equal(parsed.turns.length, 0);
    assert.equal(parsed.skipped, 1);
  }
});

test('detection rejects prose and JSON with one matching key', () => {
  assert.equal(
    detectFormat('OpenCode, Gemini CLI, and Cursor logs pasted as prose. Nothing here is JSON.'),
    'text',
  );
  assert.equal(detectFormat('{"messages":[]}'), 'text');
  assert.equal(detectFormat('{"info":{"id":"ses_example"}}'), 'text');
  assert.equal(detectFormat('{"info":{},"messages":[]}'), 'text');
  assert.equal(detectFormat('{"sessionId":"session","projectHash":"hash"}'), 'text');
  assert.equal(detectFormat(codex), 'codex');
});

test('an explicit OpenCode format parses plain text as empty', () => {
  const parsed = parse('OpenCode session pasted as plain text', { format: 'opencode' });
  assert.equal(parsed.format, 'opencode');
  assert.equal(parsed.turns.length, 0);
  assert.equal(parsed.skipped, 1);
});

test('ignores Gemini patch records', () => {
  const text = [
    '{"sessionId":"session-1","projectHash":"hash-1","startTime":"2026-10-21T08:00:00.000Z","directories":["/Users/example/project"]}',
    '{"$set":{"lastUpdated":"2026-10-21T08:00:01.000Z"}}',
    '{"type":"user","timestamp":"2026-10-21T08:00:02.000Z","content":"hello"}',
  ].join('\n');

  const parsed = parse(text);
  assert.equal(parsed.format, 'gemini');
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.meta.cwd, '/Users/example/project');
  assert.equal(parsed.meta.endedAt, '2026-10-21T08:00:02.000Z');
});

test('uses the Gemini header lastUpdated when no events follow', () => {
  const text =
    '{"sessionId":"session-1","projectHash":"hash-1","startTime":"2026-10-21T08:00:00.000Z","lastUpdated":"2026-10-21T08:00:01.000Z","directories":["/Users/example/project"]}';
  const parsed = parse(text, { format: 'gemini' });

  assert.equal(parsed.format, 'gemini');
  assert.equal(parsed.meta.startedAt, '2026-10-21T08:00:00.000Z');
  assert.equal(parsed.meta.endedAt, '2026-10-21T08:00:01.000Z');
});

test('a 3000-character tool result gets the truncation note', () => {
  const outputText = 'x'.repeat(3000);
  const document = {
    info: {
      id: 'ses_example',
      model: { id: 'example-model' },
      time: { created: 1792569600000, updated: 1792569632000 },
      tokens: { input: 1, output: 2, cache: { read: 3 } },
    },
    messages: [
      {
        type: 'assistant',
        content: [
          {
            type: 'tool',
            name: 'shell',
            state: {
              input: { command: 'cat output.log' },
              content: [{ type: 'text', text: outputText }],
            },
          },
        ],
      },
    ],
  };

  const parsed = parse(JSON.stringify(document));
  assert.equal(parsed.format, 'opencode');

  const output = blocksOf(parsed).find((block) => block.kind === 'output');
  assert.equal(output.originalChars, 3000);
  assert.match(output.text, /truncated 1000 of 3000 chars/);
});

test('keeps Codex and Claude detection and parsing', () => {
  assert.equal(detectFormat(codex), 'codex');
  assert.equal(parse(codex).format, 'codex');
  assert.equal(detectFormat(claude), 'claude');
  assert.equal(parse(claude).format, 'claude');
});

test('sanitizes the new fixtures without residuals', () => {
  for (const text of [openCode, gemini]) {
    const result = sanitize(text);
    assert.equal(result.residual.length, 0);
    assert.ok(result.findings.length > 0);
    assert.ok(result.markdown.includes('## Redactions'));
    assert.ok(result.markdown.includes('<REPO>'));
    assert.ok(!result.markdown.includes('/Users/example/project'));
  }
});

test('the transcript budget keeps new-format fences closed', () => {
  for (const text of [openCode, gemini]) {
    const { markdown } = sanitize(text, { maxTotal: 2000 });
    assert.ok(markdown.length < 5000, `report was ${markdown.length} chars`);
    assert.equal((markdown.match(/^```/gm) ?? []).length % 2, 0, 'unclosed code fence');
    const details = (markdown.match(/<details>/g) ?? []).length;
    const closes = (markdown.match(/<\/details>/g) ?? []).length;
    assert.equal(details, closes, 'unclosed details block');
  }
});
