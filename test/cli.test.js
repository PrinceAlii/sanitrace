import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/codex-rollout.jsonl', import.meta.url));
const openCodeFixture = fileURLToPath(new URL('./fixtures/opencode-session.json', import.meta.url));
const geminiFixture = fileURLToPath(new URL('./fixtures/gemini-session.jsonl', import.meta.url));
const customDirectory = fileURLToPath(new URL('./fixtures/custom-rules/', import.meta.url));
const customConfig = path.join(customDirectory, '.sanitrace.json');
const customLog = path.join(customDirectory, 'session.txt');
const customExpected = JSON.parse(
  await readFile(new URL('./fixtures/custom-rules/expected.json', import.meta.url), 'utf8'),
);
const customModule = path.join(customDirectory, 'rules.mjs');

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

async function writeConfig(config) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-rules-'));
  const file = path.join(directory, 'config.json');
  await writeFile(file, JSON.stringify(config));
  return { directory, file };
}

function rule(overrides = {}) {
  return {
    id: 'acme-token',
    label: 'ACME_TOKEN',
    description: 'Acme service tokens',
    pattern: '\\bacme_[A-Za-z0-9]{24}\\b',
    ...overrides,
  };
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

test('detects and sanitizes OpenCode and Gemini exports', async () => {
  for (const [file, format] of [
    [openCodeFixture, 'opencode'],
    [geminiFixture, 'gemini'],
  ]) {
    const { code, stdout } = await cli([file, '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.deepEqual(payload.residual, []);
    assert.ok(payload.markdown.includes(`| Format | \`${format}\` |`));
    assert.ok(!payload.markdown.includes('/Users/example/project'));
  }
});

test('--check exits 1 for a new session format', async () => {
  for (const file of [openCodeFixture, geminiFixture]) {
    const { code } = await cli([file, '--check']);
    assert.equal(code, 1);
  }
});

test('rejects an unknown format before reading input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const missing = path.join(directory, 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--format', 'yaml']);

  assert.equal(code, 2);
  assert.match(stderr, /Unknown format "yaml"/);
  assert.match(stderr, /opencode, gemini/);
  assert.ok(!stderr.includes('ENOENT'));
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

test('reads the report profile from config and lets --profile override it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const config = path.join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ profile: 'review' }));

  const fromConfig = await cli([fixture, '--config', config]);
  assert.equal(fromConfig.code, 0);
  assert.match(fromConfig.stdout, /^# Agent session review$/m);

  const overridden = await cli([fixture, '--config', config, '--profile', 'security']);
  assert.equal(overridden.code, 0);
  assert.match(overridden.stdout, /^# Agent session security report$/m);
  assert.ok(!overridden.stdout.includes('# Agent session review'));
});

test('rejects an unknown profile before reading the input', async () => {
  const missing = path.join(await mkdtemp(path.join(tmpdir(), 'sanitrace-')), 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--profile', 'Security']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown profile "Security"/);
  for (const name of ['bug', 'security', 'review']) assert.ok(stderr.includes(name));
  assert.ok(!stderr.includes('ENOENT'));
});

test('rejects a non-string profile in config', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const config = path.join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ profile: 3 }));
  const { code, stderr } = await cli([fixture, '--config', config]);
  assert.equal(code, 2);
  assert.match(stderr, /Config key "profile" must be a string/);
  assert.ok(stderr.includes(config));
});

test('rejects an unknown profile in config', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-'));
  const config = path.join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ profile: 'Bugs' }));
  const { code, stderr } = await cli([fixture, '--config', config]);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown profile "Bugs"/);
  for (const name of ['bug', 'security', 'review']) assert.ok(stderr.includes(name));
});

test('rejects --profile without a value', async () => {
  const { code, stderr } = await cli([fixture, '--profile']);
  assert.equal(code, 2);
  assert.match(stderr, /Usage/);
});

test('--json reports the selected profile', async () => {
  const cases = [
    [[], 'bug'],
    [['--profile', 'security'], 'security'],
    [['--profile', 'review'], 'review'],
  ];

  for (const [args, profile] of cases) {
    const { code, stdout } = await cli([fixture, '--json', ...args]);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.profile, profile);
    assert.ok(Array.isArray(payload.findings));
    assert.ok(Array.isArray(payload.residual));
    assert.match(payload.markdown, /## Redactions/);
  }
});

test('loads custom rules from a config in another working directory', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sanitrace-cwd-'));
  const allowArgs = customExpected.unchanged.flatMap((value) => ['--allow', value]);
  const { code, stdout, stderr } = await cli(
    [customLog, '--config', customConfig, '--format', 'text', ...allowArgs],
    { cwd },
  );

  assert.equal(code, 0);
  for (const placeholder of customExpected.placeholders) {
    assert.ok(stdout.includes(placeholder), `missing ${placeholder}`);
  }
  assert.equal(stdout.match(/\[ACME_TOKEN_1\]/g)?.length, 2);
  for (const value of customExpected.unchanged) {
    assert.ok(stdout.includes(value), `changed ${value}`);
  }
  for (const value of ['acme_A1b2C3d4E5f6G7h8I9j0K1l2', 'EMP-123456', 'EMP-654321']) {
    assert.ok(!stdout.includes(value), `leaked ${value}`);
  }
  assert.ok(!stderr.includes('possible leftover'));
});

test('--disable skips a custom rule by id', async () => {
  const { code, stdout } = await cli([
    customLog,
    '--config',
    customConfig,
    '--format',
    'text',
    '--disable',
    'acme-token',
  ]);

  assert.equal(code, 0);
  assert.match(stdout, /acme_Z9y8X7w6V5u4T3s2R1q0P9o8/);
  assert.match(stdout, /\[ACME_ASSIGNMENT_1\]/);
});

test('loads --rule-module relative to the working directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-rules-'));
  await writeFile(
    path.join(directory, 'rules.mjs'),
    [
      'export default [',
      "  { id: 'temp-token', label: 'TEMP_TOKEN', description: 'Temporary tokens', pattern: /\\btmp_[a-z0-9]{8}\\b/ },",
      '];',
      '',
    ].join('\n'),
  );
  const log = path.join(directory, 'session.txt');
  await writeFile(log, 'value tmp_abcd1234 here');

  const { code, stdout } = await cli(
    [log, '--rule-module', './rules.mjs', '--format', 'text'],
    { cwd: directory },
  );

  assert.equal(code, 0);
  assert.match(stdout, /\[TEMP_TOKEN_1\]/);
});

test('loads repeated --rule-module flags in order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-rules-'));
  await writeFile(
    path.join(directory, 'one.mjs'),
    "export default [{ id: 'one-rule', label: 'ONE_RULE', description: 'First rule', pattern: 'one' }];\n",
  );
  await writeFile(
    path.join(directory, 'two.mjs'),
    "export default [{ id: 'two-rule', label: 'TWO_RULE', description: 'Second rule', pattern: 'two' }];\n",
  );

  const { code, stdout } = await cli(
    ['rules', '--rule-module', './one.mjs', '--rule-module', './two.mjs'],
    { cwd: directory },
  );

  assert.equal(code, 0);
  const ids = stdout
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t')[0]);
  assert.ok(ids.indexOf('one-rule') < ids.indexOf('two-rule'));
});

test('rules lists custom rules with a source column', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sanitrace-cwd-'));
  const { code, stdout } = await cli(['rules', '--config', customConfig], { cwd });

  assert.equal(code, 0);
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'id\tplaceholder\tdescription\tsource');

  const builtin = lines.find((line) => line.startsWith('private-key\t'));
  assert.ok(builtin.endsWith('\tbuiltin'));

  const configRule = lines.find((line) => line.startsWith('acme-assignment\t'));
  assert.equal(
    configRule,
    `acme-assignment\t[ACME_ASSIGNMENT_N]\tAcme token assignments with the variable name kept\tconfig:${customConfig}`,
  );

  const moduleRule = lines.find((line) => line.startsWith('employee-id\t'));
  assert.equal(
    moduleRule,
    `employee-id\t[EMPLOYEE_ID_N]\tInternal employee identifiers\tmodule:${customModule}`,
  );
});

test('--json includes custom findings without descriptions', async () => {
  const { code, stdout } = await cli([customLog, '--config', customConfig, '--json']);
  assert.equal(code, 0);

  const payload = JSON.parse(stdout);
  const acme = payload.findings.find((finding) => finding.rule === 'acme-token');
  const employee = payload.findings.find((finding) => finding.rule === 'employee-id');
  assert.ok(acme);
  assert.ok(employee);
  assert.deepEqual(Object.keys(acme).sort(), ['count', 'label', 'rule', 'samples']);
  assert.deepEqual(Object.keys(employee).sort(), ['count', 'label', 'rule', 'samples']);
  assert.deepEqual(payload.residual, []);
  assert.ok(!JSON.stringify(payload.findings).includes('Acme service tokens'));
});

test('--check exits 1 for a custom-only match', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-rules-'));
  const log = path.join(directory, 'session.txt');
  await writeFile(log, 'token acme_A1b2C3d4E5f6G7h8I9j0K1l2');

  const { code, stdout, stderr } = await cli([
    log,
    '--config',
    customConfig,
    '--format',
    'text',
    '--check',
  ]);

  assert.equal(code, 1);
  assert.match(stdout, /\[ACME_TOKEN_1\]/);
  assert.ok(!stderr.includes('possible leftover'));
});

async function runConfig(config, args = []) {
  const { directory, file } = await writeConfig(config);
  const missing = path.join(directory, 'missing.jsonl');
  const result = await cli([missing, '--config', file, ...args]);
  return { ...result, directory, file, missing };
}

test('rejects an unknown rule field before reading the input', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ extra: true })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Unknown field "extra"/);
  assert.ok(stderr.includes(file));
  assert.match(stderr, /rule 1/);
  assert.ok(!stderr.includes('ENOENT'));
});

test('rejects an invalid rule id', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ id: 'Acme' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Invalid field "id"/);
  assert.match(stderr, /lowercase/);
  assert.ok(stderr.includes(file));
  assert.match(stderr, /rule 1/);
});

test('rejects an invalid rule label', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ label: 'acme_token' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Invalid field "label"/);
  assert.match(stderr, /uppercase/);
  assert.ok(stderr.includes(file));
  assert.match(stderr, /rule 1/);
});

test('rejects an invalid rule description', async () => {
  for (const description of ['no', 'line one\nline two']) {
    const { code, stderr, file } = await runConfig({
      customRules: [rule({ description })],
    });

    assert.equal(code, 2);
    assert.match(stderr, /Invalid field "description"/);
    assert.match(stderr, /5 to 120 characters on one line/);
    assert.ok(stderr.includes(file));
    assert.match(stderr, /rule 1/);
  }
});

test('rejects a duplicate id against a built-in rule', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ id: 'email', label: 'CUSTOM_EMAIL' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Duplicate rule id "email"/);
  assert.match(stderr, /builtin/);
  assert.ok(stderr.includes(file));
});

test('rejects a duplicate label between custom rules', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [
      rule({ id: 'custom-one', label: 'DUP_LABEL' }),
      rule({ id: 'custom-two', label: 'DUP_LABEL' }),
    ],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Duplicate rule label "DUP_LABEL"/);
  assert.match(stderr, /rule 1/);
  assert.match(stderr, /rule 2/);
  assert.ok(stderr.includes(file));
});

test('rejects a duplicate id between custom rules', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [
      rule({ id: 'custom-one', label: 'CUSTOM_ONE' }),
      rule({ id: 'custom-one', label: 'CUSTOM_TWO' }),
    ],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Duplicate rule id "custom-one"/);
  assert.match(stderr, /rule 1/);
  assert.match(stderr, /rule 2/);
  assert.ok(stderr.includes(file));
});

test('rejects a pattern that does not compile', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ pattern: '(' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /does not compile/);
  assert.match(stderr, /acme-token/);
  assert.ok(stderr.includes(file));
});

test('rejects a pattern that matches an empty string', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ pattern: 'x*' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /matches an empty string/);
  assert.match(stderr, /acme-token/);
  assert.ok(stderr.includes(file));
});

test('rejects an unsupported flag', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ flags: 'g' })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Invalid field "flags"/);
  assert.match(stderr, /"g" is not allowed/);
  assert.match(stderr, /allowed flags are i, m, s/);
  assert.ok(stderr.includes(file));
});

test('rejects more than 50 custom rules', async () => {
  const customRules = Array.from({ length: 51 }, (_, index) => ({
    id: `rule-${index + 1}`,
    label: `RULE_${index + 1}`,
    description: `Generated rule number ${index + 1}`,
    pattern: `token${index + 1}`,
  }));
  const { code, stderr } = await runConfig({ customRules });

  assert.equal(code, 2);
  assert.match(stderr, /limit is 50/);
  assert.match(stderr, /51/);
});

test('rejects a pattern over 1000 characters', async () => {
  const { code, stderr, file } = await runConfig({
    customRules: [rule({ pattern: 'a'.repeat(1001) })],
  });

  assert.equal(code, 2);
  assert.match(stderr, /1001 characters/);
  assert.match(stderr, /limit is 1000/);
  assert.ok(stderr.includes(file));
});

test('rejects patterns over 20000 characters in total', async () => {
  const customRules = Array.from({ length: 21 }, (_, index) => ({
    id: `rule-${index + 1}`,
    label: `RULE_${index + 1}`,
    description: `Generated rule number ${index + 1}`,
    pattern: 'a'.repeat(1000),
  }));
  const { code, stderr } = await runConfig({ customRules });

  assert.equal(code, 2);
  assert.match(stderr, /21000 characters/);
  assert.match(stderr, /limit is 20000/);
});

test('rejects a missing rule module with the resolved path', async () => {
  const { code, stderr, directory } = await runConfig({
    ruleModules: ['./missing.mjs'],
  });

  assert.equal(code, 2);
  assert.match(stderr, /Rule module not found/);
  assert.ok(stderr.includes(path.join(directory, 'missing.mjs')));
});

test('rejects a rule module that throws on import', async () => {
  const { directory, file } = await writeConfig({ ruleModules: ['./rules.mjs'] });
  await writeFile(path.join(directory, 'rules.mjs'), "throw new Error('boom');\n");
  const missing = path.join(directory, 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--config', file]);

  assert.equal(code, 2);
  assert.match(stderr, /failed to import/);
  assert.match(stderr, /boom/);
  assert.ok(stderr.includes(path.join(directory, 'rules.mjs')));
});

test('rejects a default export that is not an array', async () => {
  const { directory, file } = await writeConfig({ ruleModules: ['./rules.mjs'] });
  const modulePath = path.join(directory, 'rules.mjs');
  await writeFile(modulePath, 'export default { id: "not-an-array" };\n');
  const missing = path.join(directory, 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--config', file]);

  assert.equal(code, 2);
  assert.match(stderr, /must export an array by default/);
  assert.match(stderr, /received object/);
  assert.ok(stderr.includes(modulePath));
});

test('rejects an invalid rule from a module with the path and index', async () => {
  const { directory, file } = await writeConfig({ ruleModules: ['./rules.mjs'] });
  const modulePath = path.join(directory, 'rules.mjs');
  await writeFile(
    modulePath,
    [
      'export default [',
      "  { id: 'Bad', label: 'BAD', description: 'Invalid rule id', pattern: 'x' },",
      '];',
      '',
    ].join('\n'),
  );
  const missing = path.join(directory, 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--config', file]);

  assert.equal(code, 2);
  assert.match(stderr, /Invalid field "id"/);
  assert.match(stderr, /rule 1/);
  assert.ok(stderr.includes(`module:${modulePath}`));
});

test('rejects a RegExp flag outside i, m, and s in a module', async () => {
  const { directory, file } = await writeConfig({ ruleModules: ['./rules.mjs'] });
  const modulePath = path.join(directory, 'rules.mjs');
  await writeFile(
    modulePath,
    [
      'export default [',
      "  { id: 'unicode-rule', label: 'UNICODE_RULE', description: 'Unicode pattern', pattern: /\\p{L}+/u },",
      '];',
      '',
    ].join('\n'),
  );
  const missing = path.join(directory, 'missing.jsonl');
  const { code, stderr } = await cli([missing, '--config', file]);

  assert.equal(code, 2);
  assert.match(stderr, /Invalid field "pattern"/);
  assert.match(stderr, /"u" is not allowed/);
  assert.ok(stderr.includes(modulePath));
});

test('rejects remote rule module specifiers', async () => {
  const specifiers = [
    'https://example.com/rules.mjs',
    'node:fs',
    'data:text/javascript,export default []',
    'file:///tmp/rules.mjs',
  ];

  for (const specifier of specifiers) {
    const { code, stderr } = await runConfig({}, ['--rule-module', specifier]);
    assert.equal(code, 2);
    assert.match(stderr, /must be a local path/);
    assert.match(stderr, /node:, data:, and file:/);
  }
});

test('rejects a non-array customRules config value', async () => {
  const { code, stderr, file } = await runConfig({ customRules: {} });
  assert.equal(code, 2);
  assert.match(stderr, /Config key "customRules" must be an array/);
  assert.ok(stderr.includes(file));
});

test('rejects non-string ruleModules config values', async () => {
  const { code, stderr, file } = await runConfig({ ruleModules: [3] });
  assert.equal(code, 2);
  assert.match(stderr, /Config key "ruleModules" must be an array of strings/);
  assert.ok(stderr.includes(file));
});
