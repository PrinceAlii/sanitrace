import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));
const bugReport = fileURLToPath(new URL('./fixtures/report-bug.md', import.meta.url));

// The same helper the rest of the CLI tests use, so the diff command runs as a
// separate process.
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

async function reportFixture(name, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-diff-'));
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return { directory, file };
}

// A changed report keeps the same structure and changes one body line.
async function changedReport() {
  const text = await readFile(bugReport, 'utf8');
  return reportFixture(
    'changed.md',
    text.replace('OPENAI_API_KEY=[OPENAI_KEY_1]', 'OPENAI_API_KEY=[OPENAI_KEY_9]'),
  );
}

test('diff on identical reports exits 0 and prints the summary', async () => {
  const { code, stdout } = await cli(['diff', bugReport, bugReport]);
  assert.equal(code, 0);
  assert.match(stdout, /^# Report diff$/m);
  assert.match(stdout, /\| Unchanged \| 2 \|/);
  assert.match(stdout, /No transcript differences\./);
});

test('diff on changed reports exits 1 and prints the changed line', async () => {
  const { file } = await changedReport();
  const { code, stdout } = await cli(['diff', bugReport, file]);
  assert.equal(code, 1);
  assert.match(stdout, /^## Changed turn 1$/m);
  assert.match(stdout, /^-.*OPENAI_KEY_1/m);
  assert.match(stdout, /^\+.*OPENAI_KEY_9/m);
});

test('diff --json returns the documented shape and exits 1', async () => {
  const { file } = await changedReport();
  const { code, stdout } = await cli(['diff', bugReport, file, '--json']);
  assert.equal(code, 1);
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload), ['a', 'b', 'summary', 'turns']);
  assert.deepEqual(payload.summary, { unchanged: 1, changed: 1, added: 0, removed: 0 });
  const [turn] = payload.turns;
  assert.equal(turn.status, 'changed');
  assert.deepEqual(turn.diff.map((entry) => entry.type), ['removed', 'added']);
});

test('diff -o writes the output file', async () => {
  const { directory } = await changedReport();
  const out = path.join(directory, 'diff.md');
  const { code, stdout } = await cli(['diff', bugReport, bugReport, '-o', out]);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  const written = await readFile(out, 'utf8');
  assert.match(written, /No transcript differences\./);
});

test('diff with a missing file exits 2', async () => {
  const { directory } = await reportFixture('a.md', '');
  const missing = path.join(directory, 'missing.md');
  const { code, stderr } = await cli(['diff', bugReport, missing]);
  assert.equal(code, 2);
  assert.match(stderr, /cannot read report/);
  assert.ok(stderr.includes(missing));
});

test('diff with a report without markers exits 2 and names the file', async () => {
  const { file } = await reportFixture(
    'old.md',
    '# Agent session report\n\n### 1. user\n\nAsk.\n',
  );
  const { code, stderr } = await cli(['diff', file, bugReport]);
  assert.equal(code, 2);
  assert.ok(stderr.includes(file));
  assert.match(stderr, /0\.4\.0/);
});

test('diff with one argument exits 2 with the usage line', async () => {
  const { code, stderr } = await cli(['diff', bugReport]);
  assert.equal(code, 2);
  assert.match(stderr, /usage: sanitrace diff <a\.md> <b\.md> \[--json\] \[-o <file>\]/);
});

test('diff with three reports exits 2 as an unexpected argument', async () => {
  const { code, stderr } = await cli(['diff', bugReport, bugReport, bugReport]);
  assert.equal(code, 2);
  assert.match(stderr, /unexpected argument/);
  assert.match(stderr, /usage: sanitrace diff/);
});

test('diff works with a path that contains spaces', async () => {
  const text = await readFile(bugReport, 'utf8');
  const { file } = await reportFixture('report with spaces.md', text);
  const { code, stdout } = await cli(['diff', file, file]);
  assert.equal(code, 0);
  assert.match(stdout, /No transcript differences\./);
  assert.ok(stdout.includes('report with spaces.md'));
});

test('diff ignores a malformed .sanitrace.json in the working directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-diff-config-'));
  await writeFile(path.join(directory, '.sanitrace.json'), '{ not valid json');
  const { code, stdout } = await cli(['diff', bugReport, bugReport], { cwd: directory });
  assert.equal(code, 0);
  assert.match(stdout, /No transcript differences\./);
});
