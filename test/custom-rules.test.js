import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { loadCustomRules } from '../src/custom-rules.js';
import { redact, rules, verify } from '../src/redact.js';
import { sanitize } from '../src/index.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/custom-rules/', import.meta.url));
const fixtureConfig = path.join(fixtureDirectory, '.sanitrace.json');
const fixtureModule = path.join(fixtureDirectory, 'rules.mjs');

const acmeRule = {
  id: 'acme-token',
  label: 'ACME_TOKEN',
  description: 'Acme service tokens',
  pattern: /\bacme_[A-Za-z0-9]{24}\b/g,
};

test('loads config rules first and config modules second', async () => {
  const { config, file } = loadConfig(fixtureConfig);
  const loaded = await loadCustomRules({ config, file });

  assert.deepEqual(
    loaded.map((rule) => rule.id),
    ['acme-assignment', 'acme-token', 'employee-id'],
  );
  assert.equal(loaded[0].source, `config:${fixtureConfig}`);
  assert.equal(loaded[2].source, `module:${fixtureModule}`);
  assert.equal(loaded[0].keepGroup, 1);
  for (const rule of loaded) assert.ok(rule.pattern.global);
});

test('accepts string and RegExp patterns from a module', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sanitrace-rules-'));
  const modulePath = path.join(directory, 'rules.mjs');
  await writeFile(
    modulePath,
    [
      'export default [',
      "  { id: 'string-rule', label: 'STRING_RULE', description: 'String pattern rule', pattern: 'tmp_[a-z]+', flags: 'i' },",
      "  { id: 'regexp-rule', label: 'REGEXP_RULE', description: 'RegExp pattern rule', pattern: /code-\\d+/i },",
      '];',
      '',
    ].join('\n'),
  );

  const loaded = await loadCustomRules({ modules: [modulePath] });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].pattern.flags, 'gi');
  assert.match('TMP_ABC', loaded[0].pattern);
  assert.equal(loaded[1].pattern.flags, 'gi');
  assert.match('CODE-42', loaded[1].pattern);
});

test('custom rules replace matches and keep the prefix', () => {
  const rule = {
    id: 'prefix-value',
    label: 'PREFIX_VALUE',
    description: 'Values with a kept prefix',
    pattern: /\b(VALUE=)val-\d+\b/g,
    keepGroup: 1,
  };
  const { text, findings } = redact('VALUE=val-1 VALUE=val-2', {
    rules: [rule],
    entropy: false,
  });

  assert.equal(text, 'VALUE=[PREFIX_VALUE_1] VALUE=[PREFIX_VALUE_2]');
  assert.equal(findings[0].count, 2);
});

test('keepGroup inserts the placeholder alone when the group does not participate', () => {
  const rule = {
    id: 'optional-value',
    label: 'OPTIONAL_VALUE',
    description: 'Values with an optional prefix',
    pattern: /\b(?:(PREFIX=))?val-\d+\b/g,
    keepGroup: 1,
  };
  const { text } = redact('val-1 PREFIX=val-2', { rules: [rule], entropy: false });
  assert.equal(text, '[OPTIONAL_VALUE_1] PREFIX=[OPTIONAL_VALUE_2]');
});

test('repeated custom values share one placeholder and count every occurrence', () => {
  const value = 'acme_A1b2C3d4E5f6G7h8I9j0K1l2';
  const { text, findings } = redact(`${value} and ${value}`, {
    rules: [acmeRule],
    entropy: false,
  });

  assert.equal(text, '[ACME_TOKEN_1] and [ACME_TOKEN_1]');
  assert.equal(findings[0].count, 2);
  assert.equal(findings[0].label, 'ACME_TOKEN');
  assert.deepEqual(Object.keys(findings[0]).sort(), ['count', 'label', 'rule', 'samples']);
});

test('allow and disable apply to custom rules', () => {
  const value = 'acme_A1b2C3d4E5f6G7h8I9j0K1l2';
  const allowed = redact(value, { allow: [value], rules: [acmeRule], entropy: false });
  assert.equal(allowed.text, value);
  assert.equal(allowed.findings.length, 0);

  const disabled = redact(value, { disable: ['acme-token'], rules: [acmeRule], entropy: false });
  assert.equal(disabled.text, value);
  assert.equal(disabled.findings.length, 0);
});

test('accepts custom rules through the customRules option alias', () => {
  const value = 'acme_A1b2C3d4E5f6G7h8I9j0K1l2';
  const { text } = redact(value, { customRules: [acmeRule], entropy: false });
  assert.equal(text, '[ACME_TOKEN_1]');
  assert.equal(verify(value, { customRules: [acmeRule] }).length, 1);
});

test('verify reports custom matches and recognizes custom labels', () => {
  const labelRule = {
    id: 'acme-label',
    label: 'ACME',
    description: 'Acme labels',
    pattern: /\b[A-Z]{4,}_\d+\b/g,
  };

  const hits = verify('leftover acme_A1b2C3d4E5f6G7h8I9j0K1l2', {
    rules: [acmeRule],
    entropy: false,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'acme-token');

  assert.deepEqual(verify('[ACME_1]', { rules: [labelRule] }), []);
  assert.equal(verify('[OTHER_1]', { rules: [labelRule] }).length, 1);
});

test('sanitize passes custom rules to redact and verify', () => {
  const result = sanitize('token acme_A1b2C3d4E5f6G7h8I9j0K1l2', {
    format: 'text',
    rules: [acmeRule],
    entropy: false,
  });

  assert.match(result.markdown, /\[ACME_TOKEN_1\]/);
  assert.equal(result.residual.length, 0);
  const finding = result.findings.find((entry) => entry.rule === 'acme-token');
  assert.equal(finding.label, 'ACME_TOKEN');
  assert.equal(finding.count, 1);
  assert.ok(!('description' in finding));
  assert.ok(!result.markdown.includes(acmeRule.description));
});

test('rules() returns only the built-in list', () => {
  assert.ok(!rules().some((rule) => rule.id === 'acme-token'));
});
