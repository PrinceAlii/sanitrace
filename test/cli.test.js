import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bin = new URL('../bin/sanitrace.js', import.meta.url).pathname;
const fixture = new URL('./fixtures/codex-rollout.jsonl', import.meta.url).pathname;

function cli(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('writes a report to stdout', async () => {
  const { code, stdout, stderr } = await cli([fixture]);
  assert.equal(code, 0);
  assert.match(stdout, /# Agent session report/);
  assert.match(stdout, /\[OPENAI_KEY_1\]/);
  assert.match(stderr, /redaction\(s\)/);
});

test('--check exits 1 when something was redacted', async () => {
  const { code } = await cli([fixture, '--check']);
  assert.equal(code, 1);
});

test('--check exits 0 on a clean document', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const clean = path.join(directory, 'clean.txt');
  await writeFile(clean, 'nothing sensitive in this sentence at all');
  const { code } = await cli([clean, '--check', '--format', 'text']);
  assert.equal(code, 0);
});

test('writes to a file with --out and supports --json', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const out = path.join(directory, 'report.json');
  const { code } = await cli([fixture, '--json', '--out', out]);
  assert.equal(code, 0);
  const payload = JSON.parse(await readFile(out, 'utf8'));
  assert.ok(payload.findings.length > 0);
  assert.deepEqual(payload.residual, []);
  assert.match(payload.markdown, /# Agent session report/);
});

test('reads stdin', async () => {
  const { code, stdout } = await cli(['-'], { input: 'stdin line with sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t' });
  assert.equal(code, 0);
  assert.match(stdout, /\[OPENAI_KEY_1\]/);
});
test('lists rules', async () => {
  const { code, stdout } = await cli(['rules']);
  assert.equal(code, 0);
  assert.match(stdout, /private-key/);
});

test('rejects an invalid flag value', async () => {
  const { code, stderr } = await cli([fixture, '--max-tool-chars', '10']);
  assert.equal(code, 2);
  assert.match(stderr, /at least 100/);
});
