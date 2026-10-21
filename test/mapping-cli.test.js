import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));
const PASSPHRASE = 'correct horse battery staple';
const PASSPHRASE_ENV = 'SANITRACE_MAPPING_PASSPHRASE';
const WARNING = 'sanitrace: mapping contains original secrets; avoid logging stdout.\n';
const REPO = '/Users/ali/dev/acme-private';
const SECRET = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t';
const ENV_VALUE = 'UnitTestSecretValue123';
const CUSTOM_VALUE = 'acme_A1b2C3d4E5f6G7h8I9j0K1l2';

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!Object.hasOwn(extra, PASSPHRASE_ENV)) delete env[PASSPHRASE_ENV];
  return env;
}

function withPassphrase(name = PASSPHRASE_ENV, value = PASSPHRASE) {
  return childEnv({ [name]: value });
}

function cli(args, { input, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: env ?? childEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

function sessionText(text, cwd = REPO) {
  return [
    JSON.stringify({ type: 'session_meta', payload: { cwd } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    }),
    '',
  ].join('\n');
}

async function makeSession(text, cwd = REPO) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sanitrace-mapping-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, sessionText(text, cwd));
  return { directory, file };
}

function baseText() {
  return [
    `The deploy failed in ${REPO}/src/app.ts.`,
    `API_TOKEN=${ENV_VALUE}`,
    `OpenAI key ${SECRET}`,
    'A literal ~ is not a path mapping.',
  ].join(' ');
}

async function showEntries(mapping, env = withPassphrase()) {
  const shown = await cli(['mapping', 'show', mapping], { env });
  assert.equal(shown.code, 0, shown.stderr);
  return { shown, entries: JSON.parse(shown.stdout).entries };
}

test('writes a mapping, shows it, and checks the report digest', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');

  const run = await cli([file, '--mapping', mapping, '-o', report], {
    env: withPassphrase(),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /redaction\(s\)/);

  if (process.platform !== 'win32') {
    assert.equal((await stat(mapping)).mode & 0o777, 0o600);
  }

  const shown = await cli(['mapping', 'show', mapping], { env: withPassphrase() });
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stderr, WARNING);
  assert.ok(!shown.stdout.includes('# Agent session report'));
  assert.ok(!shown.stdout.includes('## Transcript'));

  const payload = JSON.parse(shown.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ['createdAt', 'entries', 'report', 'version']);
  const keys = Object.keys(payload.entries);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(payload.entries['<REPO>'], REPO);
  assert.equal(payload.entries['[OPENAI_KEY_1]'], SECRET);
  assert.equal(payload.entries['[ENV_VALUE_1]'], ENV_VALUE);
  assert.ok(!Object.hasOwn(payload.entries, '~'));

  const checked = await cli(['mapping', 'show', mapping, '--report', report], {
    env: withPassphrase(),
  });
  assert.equal(checked.code, 0, checked.stderr);

  const otherReport = path.join(directory, 'other.md');
  await writeFile(otherReport, '# Another report\n');
  const mismatch = await cli(['mapping', 'show', mapping, '--report', otherReport], {
    env: withPassphrase(),
  });
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.stderr, /report hash does not match/);
  assert.equal(mismatch.stdout, '');
});

test('--json has no mapping field and does not satisfy the report digest', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const json = path.join(directory, 'report.json');
  const stdoutMapping = path.join(directory, 'stdout.map');

  const run = await cli([file, '--mapping', mapping, '--json', '-o', json], {
    env: withPassphrase(),
  });
  assert.equal(run.code, 0, run.stderr);

  const payload = JSON.parse(await readFile(json, 'utf8'));
  assert.ok(!Object.hasOwn(payload, 'mapping'));
  assert.ok(!Object.hasOwn(payload, 'entries'));
  assert.ok(!Object.hasOwn(payload, 'pathEntries'));

  const stdoutRun = await cli([file, '--mapping', stdoutMapping, '--json'], {
    env: withPassphrase(),
  });
  assert.equal(stdoutRun.code, 0, stdoutRun.stderr);
  assert.ok(!Object.hasOwn(JSON.parse(stdoutRun.stdout), 'mapping'));

  const checked = await cli(['mapping', 'show', mapping, '--report', json], {
    env: withPassphrase(),
  });
  assert.equal(checked.code, 2);
  assert.equal(checked.stdout, '');
});

test('rejects a missing, empty, or short passphrase before reading input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sanitrace-mapping-'));
  const missing = path.join(directory, 'missing.jsonl');
  const mapping = path.join(directory, 'report.map');
  const cases = [
    { name: 'missing', env: childEnv() },
    { name: 'empty', env: childEnv({ [PASSPHRASE_ENV]: '' }) },
    { name: 'short', env: childEnv({ [PASSPHRASE_ENV]: 'shortpass12' }) },
  ];

  for (const entry of cases) {
    const result = await cli([missing, '--mapping', mapping], { env: entry.env });
    assert.equal(result.code, 2, entry.name);
    assert.match(result.stderr, new RegExp(PASSPHRASE_ENV), entry.name);
    assert.match(result.stderr, /16 or more/, entry.name);
    assert.ok(!result.stderr.includes('ENOENT'), entry.name);
    assert.ok(!result.stderr.includes('shortpass12'), entry.name);
  }
});

test('rejects an invalid passphrase variable name before reading input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sanitrace-mapping-'));
  const missing = path.join(directory, 'missing.jsonl');
  const mapping = path.join(directory, 'report.map');

  for (const name of ['sanitrace_mapping_passphrase', 'BAD-NAME', '1BAD']) {
    const result = await cli(
      [missing, '--mapping', mapping, '--mapping-passphrase-env', name],
      { env: withPassphrase() },
    );
    assert.equal(result.code, 2, name);
    assert.match(result.stderr, /uppercase environment variable name/);
    assert.ok(!result.stderr.includes(PASSPHRASE), name);
    assert.ok(!result.stderr.includes('ENOENT'), name);
  }
});

test('reads the passphrase from the selected environment variable', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');
  const name = 'SANITRACE_TEST_MAPPING_PASSPHRASE';

  const run = await cli(
    [file, '--mapping', mapping, '--mapping-passphrase-env', name, '-o', report],
    { env: childEnv({ [name]: PASSPHRASE }) },
  );
  assert.equal(run.code, 0, run.stderr);

  const shown = await cli(
    ['mapping', 'show', mapping, '--mapping-passphrase-env', name],
    { env: childEnv({ [name]: PASSPHRASE }) },
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).entries['<REPO>'], REPO);
});

test('rejects a mapping path that equals the report path', async () => {
  const { directory, file } = await makeSession(baseText());
  const target = path.join(directory, 'report.md');

  const result = await cli([file, '--mapping', target, '-o', target], {
    env: withPassphrase(),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must differ from --out/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('refuses an existing mapping without --force and replaces it with --force', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');
  await writeFile(mapping, 'old contents\n');

  const refused = await cli([file, '--mapping', mapping, '-o', report], {
    env: withPassphrase(),
  });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /already exists/);
  assert.equal(await readFile(mapping, 'utf8'), 'old contents\n');

  const forced = await cli([file, '--mapping', mapping, '-o', report, '--force'], {
    env: withPassphrase(),
  });
  assert.equal(forced.code, 0, forced.stderr);
  const contents = await readFile(mapping, 'utf8');
  assert.notEqual(contents, 'old contents\n');
  assert.ok(!contents.includes('old contents'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(mapping)).mode & 0o777, 0o600);
  }
});

test('rejects a symlink at the mapping path even with --force', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink permissions differ on Windows');
    return;
  }

  const { directory, file } = await makeSession(baseText());
  const target = path.join(directory, 'target.txt');
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');
  await writeFile(target, 'keep me\n');
  await symlink(target, mapping);

  const result = await cli([file, '--mapping', mapping, '-o', report, '--force'], {
    env: withPassphrase(),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /symlink/);
  assert.equal(await readFile(target, 'utf8'), 'keep me\n');
  await assert.rejects(stat(report), { code: 'ENOENT' });
});

test('rejects a mapping directory and a missing parent directory', async () => {
  const { directory, file } = await makeSession(baseText());
  const asDirectory = path.join(directory, 'mapping-dir');
  await mkdir(asDirectory);

  const dirResult = await cli([file, '--mapping', asDirectory], {
    env: withPassphrase(),
  });
  assert.equal(dirResult.code, 2);
  assert.match(dirResult.stderr, /not a regular file/);
  assert.equal(dirResult.stdout, '');

  const missingParent = path.join(directory, 'absent', 'report.map');
  const missingResult = await cli([file, '--mapping', missingParent], {
    env: withPassphrase(),
  });
  assert.equal(missingResult.code, 2);
  assert.match(missingResult.stderr, /mapping directory does not exist/);
  assert.equal(missingResult.stdout, '');
  await assert.rejects(stat(path.dirname(missingParent)), { code: 'ENOENT' });
});

test('does not write a mapping when the report write fails', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const out = path.join(directory, 'missing', 'report.md');

  const result = await cli([file, '--mapping', mapping, '-o', out], {
    env: withPassphrase(),
  });
  assert.equal(result.code, 2);
  await assert.rejects(stat(mapping), { code: 'ENOENT' });
});

test('--check still writes the mapping and exits 1', async () => {
  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');

  const result = await cli([file, '--mapping', mapping, '-o', report, '--check'], {
    env: withPassphrase(),
  });
  assert.equal(result.code, 1);
  assert.ok((await stat(mapping)).isFile());
  assert.match(await readFile(report, 'utf8'), /## Redactions/);
});

test('writes the mapping when verify reports a residual and exits 3', async () => {
  const { directory, file } = await makeSession(`${REPO}/src/app.ts`);
  const config = path.join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      customRules: [
        {
          id: 'repo-marker',
          label: 'REPO_MARKER',
          description: 'Path placeholder marker',
          pattern: '<REPO>',
        },
      ],
    }),
  );
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');

  const result = await cli(
    [file, '--config', config, '--mapping', mapping, '-o', report],
    { env: withPassphrase() },
  );
  assert.equal(result.code, 3);
  assert.match(result.stderr, /verify found \d+ possible leftover/);
  assert.ok((await stat(mapping)).isFile());
});


test('two runs produce different mapping ciphertext', async () => {
  const { directory, file } = await makeSession(baseText());
  const report = path.join(directory, 'report.md');
  const mappings = [path.join(directory, 'first.map'), path.join(directory, 'second.map')];

  for (const mapping of mappings) {
    const result = await cli([file, '--mapping', mapping, '-o', report], {
      env: withPassphrase(),
    });
    assert.equal(result.code, 0, result.stderr);
  }

  const first = JSON.parse(await readFile(mappings[0], 'utf8'));
  const second = JSON.parse(await readFile(mappings[1], 'utf8'));
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('records a custom keepGroup suffix only', async () => {
  const { directory, file } = await makeSession(`token acme=${CUSTOM_VALUE}`);
  const config = path.join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      customRules: [
        {
          id: 'acme-assignment',
          label: 'ACME_ASSIGNMENT',
          description: 'Acme assignment values',
          pattern: '(acme=)acme_[A-Za-z0-9]{24}',
          keepGroup: 1,
        },
      ],
    }),
  );
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');

  const result = await cli(
    [file, '--config', config, '--mapping', mapping, '-o', report],
    { env: withPassphrase() },
  );
  assert.equal(result.code, 0, result.stderr);

  const { entries } = await showEntries(mapping);
  assert.equal(entries['[ACME_ASSIGNMENT_1]'], CUSTOM_VALUE);
  assert.ok(!entries['[ACME_ASSIGNMENT_1]'].includes('acme='));
});

test('maps ~ to the home directory and keeps a literal ~ unchanged', async () => {
  const home = os.homedir();
  const { directory, file } = await makeSession(
    `Home ${home}/notes/private.txt, a literal ~, and ${REPO}/src/app.ts`,
  );
  const mapping = path.join(directory, 'report.map');
  const report = path.join(directory, 'report.md');

  const result = await cli([file, '--mapping', mapping, '-o', report], {
    env: withPassphrase(),
  });
  assert.equal(result.code, 0, result.stderr);

  const { entries } = await showEntries(mapping);
  assert.equal(entries['~'], home);
  assert.equal(entries['<REPO>'], REPO);
  assert.match(await readFile(report, 'utf8'), /a literal ~/);
});

test('mapping show exits 2 on a missing file, a bad passphrase, and malformed input', async () => {
  const missing = await cli(['mapping', 'show', '/nonexistent/report.map'], {
    env: withPassphrase(),
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read mapping/);
  assert.equal(missing.stdout, '');

  const { directory, file } = await makeSession(baseText());
  const mapping = path.join(directory, 'report.map');
  const run = await cli([file, '--mapping', mapping, '-o', path.join(directory, 'report.md')], {
    env: withPassphrase(),
  });
  assert.equal(run.code, 0, run.stderr);

  const wrong = await cli(['mapping', 'show', mapping], {
    env: withPassphrase(PASSPHRASE_ENV, 'this is the wrong passphrase'),
  });
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /could not decrypt mapping/);
  assert.equal(wrong.stdout, '');

  const malformed = path.join(directory, 'bad.map');
  await writeFile(malformed, 'not json\n');
  const bad = await cli(['mapping', 'show', malformed], { env: withPassphrase() });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /malformed JSON/);
  assert.equal(bad.stdout, '');
});
