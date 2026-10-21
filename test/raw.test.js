import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sanitizeText } from '../src/index.js';

const bin = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/codex-rollout.jsonl', import.meta.url));
const customDirectory = fileURLToPath(new URL('./fixtures/custom-rules/', import.meta.url));

const KEY = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t';
const EMAIL = 'dev@acme-internal.example';

function cli(args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

async function tempFile(contents, name = 'notes.txt') {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-raw-'));
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return { directory, file };
}

test('sanitizeText redacts a credential and returns a finding', () => {
  const { text, findings, residual } = sanitizeText(`key ${KEY}`, { entropy: false });
  assert.equal(text, 'key [OPENAI_KEY_1]');
  assert.ok(findings.some((finding) => finding.rule === 'openai-key'));
  assert.deepEqual(residual, []);
});

test('sanitizeText preserves a long input except for the replacement', () => {
  const filler = 'x'.repeat(20_000);
  const { text } = sanitizeText(`${filler} ${KEY}`, { entropy: false });
  assert.equal(text.length, filler.length + ' [OPENAI_KEY_1]'.length);
  assert.ok(text.startsWith(filler));
});

test('sanitizeText leaves a no-op input unchanged', () => {
  const input = 'nothing sensitive in this sentence at all\n';
  const { text, findings } = sanitizeText(input, { entropy: false });
  assert.equal(text, input);
  assert.equal(findings.length, 0);
});

test('sanitizeText maps cwd, home, and hostname', () => {
  const cwd = '/tmp/sanitrace-raw-project';
  const { text } = sanitizeText(`at ${cwd}/src and ${process.env.HOME ?? ''}`, {
    entropy: false,
    cwd,
  });
  assert.ok(text.includes('<REPO>/src'));
});

test('sanitizeText honors allow, disable, and detector flags', () => {
  const allowed = sanitizeText(`mail ${EMAIL}`, { allow: [EMAIL], entropy: false });
  assert.ok(allowed.text.includes(EMAIL));

  const disabled = sanitizeText(`mail ${EMAIL}`, { disable: ['email'], entropy: false });
  assert.ok(disabled.text.includes(EMAIL));

  const noEmails = sanitizeText(`mail ${EMAIL}`, { emails: false, entropy: false });
  assert.ok(noEmails.text.includes(EMAIL));

  const noIps = sanitizeText('host 10.0.0.9', { ips: false, entropy: false });
  assert.ok(noIps.text.includes('10.0.0.9'));
});

test('sanitizeText applies a custom rule', () => {
  const value = 'acme_A1b2C3d4E5f6G7h8I9j0K1l2';
  const { text } = sanitizeText(`token acme=${value}`, {
    entropy: false,
    rules: [
      { id: 'acme-token', label: 'ACME_TOKEN', pattern: '\\bacme_[A-Za-z0-9]{24}\\b' },
    ],
  });
  assert.equal(text, 'token acme=[ACME_TOKEN_1]');
});

test('sanitizeText skips verify when noVerify is set', () => {
  const { residual } = sanitizeText(`key ${KEY}`, { entropy: false, noVerify: true });
  assert.deepEqual(residual, []);
});

test('--raw writes text without a report heading', async () => {
  const { code, stdout } = await cli([fixture, '--raw']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('# Agent session report'));
  assert.ok(stdout.includes('[OPENAI_KEY_1]'));
});

test('--raw works on stdin', async () => {
  const { code, stdout } = await cli(['-', '--raw'], { input: `key ${KEY}\n` });
  assert.equal(code, 0);
  assert.equal(stdout, 'key [OPENAI_KEY_1]\n');
});

test('--raw preserves text over the block limit', async () => {
  const filler = 'y'.repeat(20_000);
  const { code, stdout } = await cli(['-', '--raw'], { input: `${filler}\n` });
  assert.equal(code, 0);
  assert.equal(stdout, `${filler}\n`);
});

test('--raw preserves CRLF and a missing trailing newline', async () => {
  const withCrlf = await cli(['-', '--raw'], { input: `a\r\nkey ${KEY}\r\n` });
  assert.equal(withCrlf.stdout, 'a\r\nkey [OPENAI_KEY_1]\r\n');

  const without = await cli(['-', '--raw'], { input: `key ${KEY}` });
  assert.equal(without.stdout, 'key [OPENAI_KEY_1]');
});

test('--raw maps a path in the input to <REPO>', async () => {
  const { file, directory } = await tempFile(`file at ${process.cwd()}/src/index.js\n`);
  const { code, stdout } = await cli([file, '--raw'], { cwd: process.cwd() });
  assert.equal(code, 0);
  assert.ok(stdout.includes('<REPO>/src/index.js'));
  assert.ok(!stdout.includes(directory));
});

test('--raw -o writes the text file', async () => {
  const { file, directory } = await tempFile(`key ${KEY}\n`);
  const out = path.join(directory, 'redacted.txt');
  const { code } = await cli([file, '--raw', '-o', out]);
  assert.equal(code, 0);
  assert.equal(await readFile(out, 'utf8'), 'key [OPENAI_KEY_1]\n');
});

test('--raw --json returns text, findings, and residual', async () => {
  const { code, stdout } = await cli(['-', '--raw', '--json'], { input: `key ${KEY}\n` });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.text, 'key [OPENAI_KEY_1]\n');
  assert.ok(Array.isArray(payload.findings));
  assert.deepEqual(payload.residual, []);
  assert.ok(!Object.hasOwn(payload, 'markdown'));
});

test('--raw --check exits 1 for a credential and 0 for clean text', async () => {
  const dirty = await cli(['-', '--raw', '--check'], { input: `key ${KEY}\n` });
  assert.equal(dirty.code, 1);

  const clean = await cli(['-', '--raw', '--check'], { input: 'nothing sensitive here\n' });
  assert.equal(clean.code, 0);
});

test('--raw rejects report-only flags before reading input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-raw-'));
  const missing = path.join(directory, 'missing.txt');

  const cases = [
    [['--profile', 'review'], /--raw does not support --profile/],
    [['--mapping', 'map.json'], /--mapping requires a report/],
    [['--max-total', '900'], /--raw does not support --max-total/],
    [['--max-tool-chars', '500'], /--raw does not support --max-tool-chars/],
    [['--keep-reasoning'], /--raw does not support --keep-reasoning/],
    [['--keep-developer'], /--raw does not support --keep-developer/],
    [['--no-outputs'], /--raw does not support --no-outputs/],
  ];

  for (const [flags, expected] of cases) {
    const { code, stderr } = await cli([missing, '--raw', ...flags]);
    assert.equal(code, 2, flags.join(' '));
    assert.match(stderr, expected);
  }
});

test('--raw rejects a non-text format before reading input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-raw-'));
  const missing = path.join(directory, 'missing.txt');
  const { code, stderr } = await cli([missing, '--raw', '--format', 'codex']);
  assert.equal(code, 2);
  assert.match(stderr, /--raw supports --format text only/);
});

test('--raw accepts --format text and auto', async () => {
  for (const value of ['text', 'auto']) {
    const { code } = await cli(['-', '--raw', '--format', value], { input: `key ${KEY}\n` });
    assert.equal(code, 0, value);
  }
});

test('--raw applies config allow and custom rules', async () => {
  const { file } = await tempFile('token acme_A1b2C3d4E5f6G7h8I9j0K1l2 and nothing else\n');
  const { code, stdout } = await cli([file, '--raw'], { cwd: customDirectory });
  assert.equal(code, 0);
  assert.ok(stdout.includes('[ACME_TOKEN_1]'), stdout);
});
