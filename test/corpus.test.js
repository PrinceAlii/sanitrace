import assert from 'node:assert/strict';
import test from 'node:test';

import { redact, rules, verify } from '../src/index.js';

// Every value here is fake and safe to commit. The corpus holds one positive
// sample and one near-miss sample per built-in rule. The coverage test fails
// when a rule is added to src/redact.js without a matching entry.
const corpus = [
  {
    id: 'private-key',
    label: 'PRIVATE_KEY',
    input:
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Q2F\n-----END RSA PRIVATE KEY-----\nafter',
    options: { entropy: false },
    allowValue:
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Q2F\n-----END RSA PRIVATE KEY-----',
    nearMiss:
      'before\n-----BEGIN RSA PUBLIC KEY-----\nMIIEowIBAAKCAQEA7Q2F\n-----END RSA PUBLIC KEY-----\nafter',
  },
  {
    id: 'url-credentials',
    label: 'URL_CREDENTIALS',
    input: 'clone https://bob:hunter2@localhost/repo.git now',
    options: { entropy: false },
    allowValue: 'https://bob:hunter2@localhost',
    nearMiss: 'clone https://localhost/repo.git now',
  },
  {
    id: 'connection-string',
    label: 'CONNECTION_STRING',
    input: 'db postgres://db.acme.example:5432/app',
    options: { entropy: false },
    allowValue: 'postgres://db.acme.example:5432/app',
    nearMiss: 'db https://db.acme.example:5432/app',
  },
  {
    id: 'anthropic-key',
    label: 'ANTHROPIC_KEY',
    input: 'key sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2',
    options: { entropy: false },
    allowValue: 'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2',
    nearMiss: 'key sk-ant-short',
  },
  {
    id: 'openai-key',
    label: 'OPENAI_KEY',
    input: 'key sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t',
    options: { entropy: false },
    allowValue: 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t',
    nearMiss: 'key sk-proj-Ab3dEf6h',
  },
  {
    id: 'github-token',
    label: 'GITHUB_TOKEN',
    input: 'token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    options: { entropy: false },
    allowValue: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    nearMiss: 'token ghp_shortvalue',
  },
  {
    id: 'cloud-key',
    label: 'CLOUD_KEY',
    input: 'aws AKIAIOSFODNN7EXAMPLE',
    options: { entropy: false },
    allowValue: 'AKIAIOSFODNN7EXAMPLE',
    nearMiss: 'aws AKIAIOSFODNN7EXAMPL',
  },
  {
    id: 'payment-key',
    label: 'PAYMENT_KEY',
    input: 'stripe sk_test_51H8xKq2eZvKYlo2Cabcdefgh',
    options: { entropy: false },
    allowValue: 'sk_test_51H8xKq2eZvKYlo2Cabcdefgh',
    nearMiss: 'stripe sk_test_short',
  },
  {
    id: 'jwt',
    label: 'JWT',
    input:
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9',
    options: { entropy: false },
    allowValue:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9',
    nearMiss: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx',
  },
  {
    id: 'bearer-token',
    label: 'BEARER_TOKEN',
    input: 'Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWx',
    options: { entropy: false },
    allowValue: 'AbCdEfGhIjKlMnOpQrStUvWx',
    nearMiss: 'Authorization: Bearer short',
  },
  {
    id: 'env-assignment',
    label: 'ENV_VALUE',
    input: 'export API_TOKEN=UnitTestSecretValue123',
    options: { entropy: false },
    allowValue: 'UnitTestSecretValue123',
    nearMiss: 'export API_TOKEN=abc',
  },
  {
    id: 'email',
    label: 'EMAIL',
    input: 'mail dev@acme-internal.example now',
    options: { entropy: false },
    allowValue: 'dev@acme-internal.example',
    nearMiss: 'mail dev@acme-internal now',
  },
  {
    id: 'ipv4',
    label: 'IPV4',
    input: 'host 10.4.22.19 responds',
    options: { entropy: false },
    allowValue: '10.4.22.19',
    nearMiss: 'host 999.4.22.19 responds',
  },
  {
    id: 'high-entropy',
    label: 'HIGH_ENTROPY',
    input: 'blob Xk9fJ2mQ7pL4vN8rT1wZ6yB3cD5eH0sA',
    options: {},
    allowValue: 'Xk9fJ2mQ7pL4vN8rT1wZ6yB3cD5eH0sA',
    nearMiss: 'blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  {
    id: 'path',
    label: 'PATH',
    input: 'edited /Users/example/project/src/app.ts',
    options: { entropy: false, paths: [{ from: '/Users/example/project', to: '<REPO>' }] },
    allowValue: '/Users/example/project',
    nearMiss: 'edited /opt/other/src/app.ts',
  },
];

// Path prefixes are replaced by the paths option and removed by keepPaths.
// The allow list and disable list apply to the detector rules only.
const controlledRules = corpus.filter((entry) => entry.id !== 'path');

function placeholderFor(entry) {
  return entry.id === 'path' ? '<REPO>' : `[${entry.label}_1]`;
}

function findingFor(result, id) {
  return result.findings.find((finding) => finding.rule === id);
}

test('corpus covers every built-in rule', () => {
  const ruleIds = rules().map((rule) => rule.id);
  const covered = new Set(corpus.map((entry) => entry.id));

  const missing = ruleIds.filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `corpus has no entry for: ${missing.join(', ')}`);

  const unknown = [...covered].filter((id) => !ruleIds.includes(id));
  assert.deepEqual(unknown, [], `corpus names unknown rules: ${unknown.join(', ')}`);

  for (const entry of corpus) {
    const rule = rules().find((item) => item.id === entry.id);
    assert.equal(rule.label, entry.label);
  }
});

for (const entry of corpus) {
  test(`${entry.id} positive sample is redacted and verifies clean`, () => {
    const result = redact(entry.input, entry.options);
    const finding = findingFor(result, entry.id);

    assert.ok(finding, `${entry.id} produced no finding`);
    assert.equal(finding.label, entry.label);
    assert.ok(result.text.includes(placeholderFor(entry)), result.text);
    assert.ok(!result.text.includes(entry.allowValue));

    const residual = verify(result.text, entry.options).filter((hit) => hit.rule === entry.id);
    assert.deepEqual(residual, []);
  });

  test(`${entry.id} near miss stays unchanged`, () => {
    const result = redact(entry.nearMiss, entry.options);

    assert.deepEqual(result.findings, []);
    assert.equal(result.text, entry.nearMiss);
  });
}

test('repeated values share one placeholder and count each occurrence', () => {
  for (const entry of corpus) {
    const input = `${entry.input} and ${entry.input}`;
    const result = redact(input, entry.options);
    const finding = findingFor(result, entry.id);

    assert.ok(finding, entry.id);
    assert.equal(finding.count, 2, entry.id);
    assert.equal(result.text.split(placeholderFor(entry)).length - 1, 2, entry.id);
  }
});

test('allow list keeps each value unchanged', () => {
  for (const entry of controlledRules) {
    const result = redact(entry.input, { ...entry.options, allow: [entry.allowValue] });

    assert.equal(result.text, entry.input, entry.id);
    assert.deepEqual(result.findings, [], entry.id);
  }
});

// Disabling a rule removes its finding and its placeholder. A value that
// another rule also matches stays redacted: the anthropic sample starts with
// sk-, so the openai-key rule catches it when anthropic-key is disabled.
test('disable list removes each rule finding', () => {
  for (const entry of controlledRules) {
    const result = redact(entry.input, { ...entry.options, disable: [entry.id] });

    assert.equal(findingFor(result, entry.id), undefined, entry.id);
    assert.ok(!result.text.includes(placeholderFor(entry)), entry.id);
  }
});

test('disable list leaves the anthropic sample to the openai rule', () => {
  const entry = corpus.find((item) => item.id === 'anthropic-key');
  const result = redact(entry.input, { ...entry.options, disable: ['anthropic-key'] });

  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ['openai-key'],
  );
  assert.equal(result.text, 'key [OPENAI_KEY_1]');
});

test('placeholders are not redacted twice', () => {
  for (const entry of corpus) {
    const first = redact(entry.input, entry.options);
    const second = redact(first.text, entry.options);

    assert.equal(second.text, first.text, entry.id);

    const residual = verify(second.text, entry.options).filter((hit) => hit.rule === entry.id);
    assert.deepEqual(residual, [], entry.id);
  }
});

test('path mapping follows the paths option', () => {
  const entry = corpus.find((item) => item.id === 'path');
  const result = redact(entry.input, { ...entry.options, paths: [] });

  assert.equal(result.text, entry.input);
  assert.deepEqual(result.findings, []);
});
