import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, scryptSync } from 'node:crypto';
import test from 'node:test';

import { decryptMapping, encryptMapping, reportDigest } from '../src/mapping.js';

const PASSPHRASE = 'correct horse battery staple';
const CREATED_AT = '2026-10-21T12:00:00.000Z';
const REPORT = '# Report\n\nUpload failed after 30 seconds.\n';
const DIGEST = reportDigest(REPORT);
const GENERIC = 'could not decrypt mapping';
const ENTRIES = {
  '[OPENAI_KEY_1]': 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t',
  '<REPO>': '/Users/me/dev/acme-private',
  '~': '~/private-notes',
};

const BASE_OPTIONS = {
  passphrase: PASSPHRASE,
  reportDigest: DIGEST,
  entries: ENTRIES,
  createdAt: CREATED_AT,
};

const CONTENTS = encryptMapping(BASE_OPTIONS);

function failureMessage(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  assert.fail('expected the call to throw');
}

function aadFor(file) {
  return [
    'sanitrace-mapping-v1',
    file.version,
    file.kdf.N,
    file.kdf.r,
    file.kdf.p,
    file.kdf.salt,
    file.cipher.iv,
  ].join('\n');
}

function rawPlaintext(contents, passphrase = PASSPHRASE) {
  const file = JSON.parse(contents);
  const key = scryptSync(passphrase, Buffer.from(file.kdf.salt, 'base64'), 32, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
  decipher.setAAD(Buffer.from(aadFor(file), 'utf8'));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Test-only helper: seals arbitrary plaintext under an existing header so the
// plaintext checks can be exercised. Production code never reuses an IV.
function reseal(file, plaintext, passphrase = PASSPHRASE) {
  const key = scryptSync(passphrase, Buffer.from(file.kdf.salt, 'base64'), 32, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
  cipher.setAAD(Buffer.from(aadFor(file), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    ...file,
    cipher: { ...file.cipher, tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  });
}

test('reportDigest is stable, lowercase, and hashes UTF-8', () => {
  assert.equal(DIGEST, reportDigest(REPORT));
  assert.match(DIGEST, /^[0-9a-f]{64}$/);
  assert.equal(DIGEST, reportDigest(REPORT));
  assert.notEqual(DIGEST, reportDigest(`${REPORT}\nMore text.`));
  assert.equal(
    reportDigest('caf\u00e9'),
    createHash('sha256').update('caf\u00e9', 'utf8').digest('hex'),
  );
});

test('round trip preserves the report digest, createdAt, and entries', () => {
  const decrypted = decryptMapping({ passphrase: PASSPHRASE, contents: CONTENTS });
  assert.deepEqual(decrypted, {
    version: 1,
    createdAt: CREATED_AT,
    report: { sha256: DIGEST },
    entries: ENTRIES,
  });
});

test('sorts entries by placeholder in the file and in decrypted output', () => {
  const entries = {
    '~': '~/private-notes',
    '[OPENAI_KEY_1]': 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t',
    '<REPO>': '/Users/me/dev/acme-private',
  };
  const contents = encryptMapping({ ...BASE_OPTIONS, entries });
  const plaintext = rawPlaintext(contents);
  const expected = ['<REPO>', '[OPENAI_KEY_1]', '~'];
  const positions = expected.map((placeholder) => plaintext.indexOf(JSON.stringify(placeholder)));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));

  const decrypted = decryptMapping({ passphrase: PASSPHRASE, contents });
  assert.deepEqual(Object.keys(decrypted.entries), expected);
});

test('defaults createdAt to the current ISO timestamp', () => {
  const before = Date.now();
  const contents = encryptMapping({
    passphrase: PASSPHRASE,
    reportDigest: DIGEST,
    entries: {},
  });
  const after = Date.now();
  const { createdAt } = decryptMapping({ passphrase: PASSPHRASE, contents });
  const parsed = Date.parse(createdAt);

  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(parsed >= before && parsed <= after);
});

test('round trips 1000 entries', () => {
  const entries = {};
  for (let index = 1; index <= 1000; index += 1) {
    entries[`[TEST_KEY_${index}]`] = `value-${index}`;
  }

  const contents = encryptMapping({ ...BASE_OPTIONS, entries });
  const decrypted = decryptMapping({ passphrase: PASSPHRASE, contents });

  assert.equal(Object.keys(decrypted.entries).length, 1000);
  assert.equal(decrypted.entries['[TEST_KEY_1]'], 'value-1');
  assert.equal(decrypted.entries['[TEST_KEY_1000]'], 'value-1000');
});

test('uses a new salt, IV, and ciphertext for each file', () => {
  const first = JSON.parse(CONTENTS);
  const second = JSON.parse(encryptMapping(BASE_OPTIONS));

  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('wrong passphrase and tampered ciphertext or tag fail with the same message', () => {
  const file = JSON.parse(CONTENTS);
  const ciphertext = Buffer.from(file.ciphertext, 'base64');
  ciphertext[0] ^= 0x01;
  const tag = Buffer.from(file.cipher.tag, 'base64');
  tag[0] ^= 0x01;

  const messages = [
    failureMessage(() =>
      decryptMapping({ passphrase: 'this is the wrong passphrase', contents: CONTENTS }),
    ),
    failureMessage(() => decryptMapping({ passphrase: 'short', contents: CONTENTS })),
    failureMessage(() =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, ciphertext: ciphertext.toString('base64') }),
      }),
    ),
    failureMessage(() =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({
          ...file,
          cipher: { ...file.cipher, tag: tag.toString('base64') },
        }),
      }),
    ),
  ];

  assert.deepEqual(messages, Array(4).fill(GENERIC));
});

test('a modified report digest fails authentication', () => {
  const file = JSON.parse(CONTENTS);
  const plaintext = rawPlaintext(CONTENTS);
  const offset = plaintext.indexOf(DIGEST);
  assert.ok(offset >= 0);

  const ciphertext = Buffer.from(file.ciphertext, 'base64');
  // The plaintext prefix is ASCII, so the string index is a byte offset.
  ciphertext[offset] ^= 0x01;
  const tampered = JSON.stringify({ ...file, ciphertext: ciphertext.toString('base64') });

  assert.equal(
    failureMessage(() => decryptMapping({ passphrase: PASSPHRASE, contents: tampered })),
    GENERIC,
  );
});

test('a modified N, r, p, salt, or IV fails authentication', () => {
  const file = JSON.parse(CONTENTS);
  const salt = Buffer.from(file.kdf.salt, 'base64');
  salt[0] ^= 0x01;
  const iv = Buffer.from(file.cipher.iv, 'base64');
  iv[0] ^= 0x01;

  const variants = [
    ['N', { ...file, kdf: { ...file.kdf, N: 16384 } }],
    ['r', { ...file, kdf: { ...file.kdf, r: 9 } }],
    ['p', { ...file, kdf: { ...file.kdf, p: 2 } }],
    ['salt', { ...file, kdf: { ...file.kdf, salt: salt.toString('base64') } }],
    ['IV', { ...file, cipher: { ...file.cipher, iv: iv.toString('base64') } }],
  ];

  for (const [name, variant] of variants) {
    assert.equal(
      failureMessage(() =>
        decryptMapping({ passphrase: PASSPHRASE, contents: JSON.stringify(variant) }),
      ),
      GENERIC,
      `expected a modified ${name} to fail`,
    );
  }
});

test('rejects an unknown version, KDF, or cipher', () => {
  const file = JSON.parse(CONTENTS);

  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, version: 2 }),
      }),
    /unsupported version/,
  );
  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, kdf: { ...file.kdf, name: 'pbkdf2' } }),
      }),
    /unsupported KDF/,
  );
  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, cipher: { ...file.cipher, name: 'aes-256-cbc' } }),
      }),
    /unsupported cipher/,
  );
});

test('rejects invalid KDF parameters before key derivation', () => {
  const file = JSON.parse(CONTENTS);
  const variants = [
    ['N is not a power of two', { N: 20000 }, /parameter N/],
    ['N is too small', { N: 8192 }, /parameter N/],
    ['N is too large', { N: 2097152 }, /parameter N/],
    ['r is too small', { r: 0 }, /parameter r/],
    ['r is too large', { r: 17 }, /parameter r/],
    ['p is too small', { p: 0 }, /parameter p/],
    ['p is too large', { p: 5 }, /parameter p/],
  ];

  for (const [name, changes, pattern] of variants) {
    assert.throws(
      () =>
        decryptMapping({
          passphrase: PASSPHRASE,
          contents: JSON.stringify({ ...file, kdf: { ...file.kdf, ...changes } }),
        }),
      pattern,
      name,
    );
  }
});

test('rejects salt, IV, and tag values with the wrong length', () => {
  const file = JSON.parse(CONTENTS);
  const variants = [
    ['salt is short', { kdf: { ...file.kdf, salt: Buffer.alloc(15).toString('base64') } }, /salt must be 16 bytes/],
    ['salt is long', { kdf: { ...file.kdf, salt: Buffer.alloc(17).toString('base64') } }, /salt must be 16 bytes/],
    ['IV is short', { cipher: { ...file.cipher, iv: Buffer.alloc(11).toString('base64') } }, /IV must be 12 bytes/],
    ['IV is long', { cipher: { ...file.cipher, iv: Buffer.alloc(13).toString('base64') } }, /IV must be 12 bytes/],
    ['tag is short', { cipher: { ...file.cipher, tag: Buffer.alloc(15).toString('base64') } }, /tag must be 16 bytes/],
    ['tag is long', { cipher: { ...file.cipher, tag: Buffer.alloc(17).toString('base64') } }, /tag must be 16 bytes/],
  ];

  for (const [name, changes, pattern] of variants) {
    assert.throws(
      () =>
        decryptMapping({
          passphrase: PASSPHRASE,
          contents: JSON.stringify({ ...file, ...changes }),
        }),
      pattern,
      name,
    );
  }
});

test('rejects invalid base64 and malformed JSON', () => {
  const file = JSON.parse(CONTENTS);

  assert.throws(
    () => decryptMapping({ passphrase: PASSPHRASE, contents: 'not json' }),
    /malformed JSON/,
  );
  assert.throws(
    () => decryptMapping({ passphrase: PASSPHRASE, contents: '[]' }),
    /expected a JSON object/,
  );
  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, kdf: { ...file.kdf, salt: 'not base64!' } }),
      }),
    /invalid base64 for salt/,
  );
  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, ciphertext: 'not base64!' }),
      }),
    /invalid base64 for ciphertext/,
  );
  assert.throws(
    () =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({
          ...file,
          kdf: { ...file.kdf, salt: 'AAAAAAAAAAAAAAAAAAAAAB==' },
        }),
      }),
    /invalid base64 for salt/,
  );

  assert.equal(
    failureMessage(() =>
      decryptMapping({
        passphrase: PASSPHRASE,
        contents: JSON.stringify({ ...file, ciphertext: '' }),
      }),
    ),
    GENERIC,
  );
});

test('rejects valid ciphertext that contains invalid plaintext', () => {
  const file = JSON.parse(CONTENTS);

  const malformed = reseal(file, 'not json');
  assert.throws(
    () => decryptMapping({ passphrase: PASSPHRASE, contents: malformed }),
    /invalid plaintext/,
  );

  const badEntries = reseal(
    file,
    JSON.stringify({
      version: 1,
      createdAt: CREATED_AT,
      report: { sha256: DIGEST },
      entries: { '[OPENAI_KEY_1]': 42 },
    }),
  );
  assert.throws(
    () => decryptMapping({ passphrase: PASSPHRASE, contents: badEntries }),
    /value for \[OPENAI_KEY_1\] must be a string/,
  );
});

test('rejects a short or non-string passphrase on write', () => {
  for (const passphrase of ['', 'short', 123456789012, null, undefined]) {
    assert.throws(
      () => encryptMapping({ ...BASE_OPTIONS, passphrase }),
      /Passphrase must be a string of at least 12 characters/,
    );
  }
});

test('rejects a report digest that is not 64 lowercase hex characters', () => {
  const digests = [
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    42,
    null,
  ];

  for (const digest of digests) {
    assert.throws(
      () => encryptMapping({ ...BASE_OPTIONS, reportDigest: digest }),
      /Report digest/,
    );
  }
});

test('rejects entries that are not strings', () => {
  const variants = [
    ['array', []],
    ['null', null],
    ['string', 'entries'],
    ['number value', { '[OPENAI_KEY_1]': 42 }],
    ['null value', { '[OPENAI_KEY_1]': null }],
  ];

  for (const [name, entries] of variants) {
    assert.throws(
      () => encryptMapping({ ...BASE_OPTIONS, entries }),
      /Mapping (entries must be an object|value for .* must be a string)/,
      name,
    );
  }
});

test('rejects an invalid createdAt', () => {
  const values = [
    'not-a-date',
    '2026-10-21',
    '2026-10-21T12:00:00',
    42,
    null,
    new Date(),
  ];

  for (const createdAt of values) {
    assert.throws(
      () => encryptMapping({ ...BASE_OPTIONS, createdAt }),
      /createdAt must be an ISO 8601 timestamp/,
    );
  }
});

test('emits only documented fields and no plaintext secrets', () => {
  const file = JSON.parse(CONTENTS);

  assert.deepEqual(Object.keys(file).sort(), ['cipher', 'ciphertext', 'kdf', 'version']);
  assert.deepEqual(Object.keys(file.kdf).sort(), ['N', 'name', 'p', 'r', 'salt']);
  assert.deepEqual(Object.keys(file.cipher).sort(), ['iv', 'name', 'tag']);
  assert.equal(file.version, 1);
  assert.equal(file.kdf.name, 'scrypt');
  assert.equal(file.cipher.name, 'aes-256-gcm');
  assert.equal(Buffer.from(file.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(file.cipher.iv, 'base64').length, 12);
  assert.equal(Buffer.from(file.cipher.tag, 'base64').length, 16);
  assert.ok(Buffer.from(file.ciphertext, 'base64').length > 0);
  assert.ok(CONTENTS.endsWith('\n'));

  for (const value of Object.values(ENTRIES)) assert.ok(!CONTENTS.includes(value));
  for (const placeholder of Object.keys(ENTRIES)) {
    assert.ok(!CONTENTS.includes(placeholder));
  }
  assert.ok(!CONTENTS.includes(DIGEST));
  assert.ok(!CONTENTS.includes(CREATED_AT));
});
