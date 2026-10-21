import assert from 'node:assert/strict';
import test from 'node:test';

import { redact, rules, verify } from '../src/redact.js';

const cases = [
  ['openai-key', 'key is sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t here', 'OPENAI_KEY'],
  ['anthropic-key', 'key sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2', 'ANTHROPIC_KEY'],
  ['github-token', 'token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'GITHUB_TOKEN'],
  ['cloud-key', 'aws AKIAIOSFODNN7EXAMPLE', 'CLOUD_KEY'],
  ['cloud-key', 'slack xoxb-1234567890-abcdefghijkl', 'CLOUD_KEY'],
  ['payment-key', 'stripe sk_test_51H8xKq2eZvKYlo2Cabcdefgh', 'PAYMENT_KEY'],
  [
    'jwt',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9',
    'JWT',
  ],
  ['email', 'mail dev@acme-internal.example now', 'EMAIL'],
  ['ipv4', 'host 10.4.22.19 responds', 'IPV4'],
  ['connection-string', 'db postgres://db.acme.example:5432/app', 'CONNECTION_STRING'],
  ['url-credentials', 'see https://bob:hunter2@git.example.com/repo.git', 'URL_CREDENTIALS'],
];

for (const [rule, input, label] of cases) {
  test(`redacts ${rule}`, () => {
    const { text, findings } = redact(input, { entropy: false });
    assert.match(text, new RegExp(`\\[${label}_1\\]`));
    assert.ok(findings.some((finding) => finding.rule === rule));
    assert.equal(verify(text, { entropy: false }).length, 0);
  });
}

test('keeps the env var name and redacts only the value', () => {
  const { text } = redact('export API_TOKEN=abcdef123456', { entropy: false });
  assert.equal(text, 'export API_TOKEN=[ENV_VALUE_1]');
});

test('does not double-redact an existing placeholder', () => {
  const { text } = redact('API_TOKEN=[ENV_VALUE_1]', { entropy: false });
  assert.equal(text, 'API_TOKEN=[ENV_VALUE_1]');
  assert.equal(verify(text, { entropy: false }).length, 0);
});

test('redacts PEM private keys as a single block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  const { text } = redact(`before\n${pem}\nafter`, { entropy: false });
  assert.equal(text, 'before\n[PRIVATE_KEY_1]\nafter');
});

test('allow list wins over detectors', () => {
  const { text, findings } = redact('owner dev@acme-internal.example', {
    allow: ['dev@acme-internal.example'],
    entropy: false,
  });
  assert.match(text, /dev@acme-internal\.example/);
  assert.equal(findings.length, 0);
});

test('disable skips a detector', () => {
  const { text } = redact('owner dev@acme-internal.example', { disable: ['email'], entropy: false });
  assert.match(text, /dev@acme-internal\.example/);
});

test('maps path prefixes to placeholders', () => {
  const { text } = redact('edited /Users/ali/dev/acme/src/app.ts', {
    paths: [{ from: '/Users/ali', to: '~' }, { from: '/Users/ali/dev/acme', to: '<REPO>' }],
    entropy: false,
  });
  assert.equal(text, 'edited <REPO>/src/app.ts');
});

test('entropy pass catches random blobs but keeps UUIDs and hashes', () => {
  const blob = 'Xk9fJ2mQ7pL4vN8rT1wZ6yB3cD5eH0sA';
  const uuid = '01a0c5aa-1111-7abc-9def-0123456789ab';
  const sha = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const { text } = redact(`${blob} ${uuid} ${sha}`);
  assert.match(text, /\[HIGH_ENTROPY_1\]/);
  assert.match(text, new RegExp(uuid));
  assert.match(text, new RegExp(sha));
});

test('repeated values share a placeholder and count occurrences', () => {
  const { text, findings } = redact('a sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t b sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t', {
    entropy: false,
  });
  assert.equal(text, 'a [OPENAI_KEY_1] b [OPENAI_KEY_1]');
  assert.equal(findings[0].count, 2);
});

test('rule list is stable and documented', () => {
  const ids = rules().map((rule) => rule.id);
  assert.ok(ids.includes('private-key'));
  assert.ok(ids.includes('high-entropy'));
  for (const rule of rules()) {
    assert.ok(rule.description.length > 5);
    assert.match(rule.placeholder, /^\[|^</);
  }
});
