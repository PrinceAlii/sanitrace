import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));

test('writes redirected output before returning the check status', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sanitrace-pipe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.txt');
  const descriptor = openSync(output, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [bin, '-', '--raw', '--check'], {
      cwd: directory,
      input: 'OPENAI_API_KEY=sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t\n',
      encoding: 'utf8',
      stdio: ['pipe', descriptor, 'pipe'],
    });
  } finally {
    closeSync(descriptor);
  }
  assert.equal(result.status, 1);
  assert.match(readFileSync(output, 'utf8'), /\[OPENAI_KEY_1\]/);
  assert.match(result.stderr, /redaction/);
});

test('returns an error for empty piped input', () => {
  const result = spawnSync(process.execPath, [bin, '-', '--raw'], {
    input: '', encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /input is empty/);
});

test('returns an error when the stdout pipe closes', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sanitrace-pipe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, 'ordinary text\n'.repeat(100000));
  const child = spawn(process.execPath, [bin, input, '--raw', '--no-entropy'], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.once('data', () => child.stdout.destroy());
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(stderr, /could not write stdout/);
});
