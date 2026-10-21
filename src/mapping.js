// Encrypted placeholder mapping.
//
// The header stays readable so KDF parameters can be checked before key
// derivation. AES-GCM authenticates the ciphertext and binds the header
// parameters through the AAD.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const FILE_VERSION = 1;
const PLAINTEXT_VERSION = 1;
const AAD_LABEL = 'sanitrace-mapping-v1';
const KDF_NAME = 'scrypt';
const CIPHER_NAME = 'aes-256-gcm';

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const N = 32768;
const R = 8;
const P = 1;
const MIN_N = 16384;
const MAX_N = 1048576;
const MIN_R = 1;
const MAX_R = 16;
const MIN_P = 1;
const MAX_P = 4;
// scrypt enforces this budget after the header checks. Large but valid N or r
// values can exceed it, and decryption then reports the generic error.
const MAXMEM = 64 * 1024 * 1024;

const MIN_PASSPHRASE = 12;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const GENERIC_DECRYPT_ERROR = 'could not decrypt mapping';

/**
 * Returns the lowercase SHA-256 hex digest of a Markdown report.
 * @param {string} markdown
 * @returns {string}
 */
export function reportDigest(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Markdown must be a string');
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

/**
 * Encrypts a placeholder mapping.
 * @param {object} options
 * @param {string} options.passphrase
 * @param {string} options.reportDigest lowercase SHA-256 hex digest of the report
 * @param {Record<string, string>} options.entries placeholder to original value
 * @param {string} [options.createdAt] ISO 8601 timestamp
 * @returns {string} JSON file contents ending in a newline
 */
export function encryptMapping({
  passphrase,
  reportDigest: digest,
  entries,
  createdAt = new Date().toISOString(),
} = {}) {
  assertPassphrase(passphrase);
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new Error('Report digest must be 64 lowercase hexadecimal characters');
  }
  if (!isIsoTimestamp(createdAt)) {
    throw new Error('createdAt must be an ISO 8601 timestamp');
  }

  const sorted = normalizeEntries(entries, (detail) => new Error(`Mapping ${detail}`));

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const saltBase64 = salt.toString('base64');
  const ivBase64 = iv.toString('base64');
  const aad = buildAad({
    version: FILE_VERSION,
    n: N,
    r: R,
    p: P,
    salt: saltBase64,
    iv: ivBase64,
  });

  const plaintext = JSON.stringify(
    {
      version: PLAINTEXT_VERSION,
      createdAt,
      report: { sha256: digest },
      entries: sorted,
    },
    null,
    2,
  );

  const key = scryptSync(passphrase, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM });
  const cipher = createCipheriv(CIPHER_NAME, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const document = {
    version: FILE_VERSION,
    kdf: { name: KDF_NAME, N, r: R, p: P, salt: saltBase64 },
    cipher: { name: CIPHER_NAME, iv: ivBase64, tag: tag.toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Decrypts a placeholder mapping.
 * @param {object} options
 * @param {string} options.passphrase
 * @param {string|Buffer} options.contents JSON file contents
 * @returns {{version: number, createdAt: string, report: {sha256: string}, entries: Record<string, string>}}
 */
export function decryptMapping({ passphrase, contents } = {}) {
  // A short value cannot decrypt a valid file. Report it as a failed decryption
  // so callers cannot use the message to probe the passphrase policy.
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(GENERIC_DECRYPT_ERROR);
  }

  const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : contents;
  if (typeof text !== 'string') throw invalidFile('contents must be a string or Buffer');

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalidFile('malformed JSON');
  }
  if (!isPlainObject(document)) throw invalidFile('expected a JSON object');

  if (document.version !== FILE_VERSION) throw invalidFile('unsupported version');

  const kdf = document.kdf;
  if (!isPlainObject(kdf)) throw invalidFile('missing KDF parameters');
  if (kdf.name !== KDF_NAME) throw invalidFile('unsupported KDF');

  const cipher = document.cipher;
  if (!isPlainObject(cipher)) throw invalidFile('missing cipher parameters');
  if (cipher.name !== CIPHER_NAME) throw invalidFile('unsupported cipher');

  assertKdfParameters(kdf);
  const salt = decodeBase64(kdf.salt, 'salt');
  const iv = decodeBase64(cipher.iv, 'IV');
  const tag = decodeBase64(cipher.tag, 'tag');
  const ciphertext = decodeBase64(document.ciphertext, 'ciphertext');

  if (salt.length !== SALT_BYTES) throw invalidFile('salt must be 16 bytes');
  if (iv.length !== IV_BYTES) throw invalidFile('IV must be 12 bytes');
  if (tag.length !== TAG_BYTES) throw invalidFile('tag must be 16 bytes');

  const aad = buildAad({
    version: FILE_VERSION,
    n: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: kdf.salt,
    iv: cipher.iv,
  });

  let plaintext;
  try {
    const key = scryptSync(passphrase, salt, KEY_BYTES, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem: MAXMEM,
    });
    const decipher = createDecipheriv(CIPHER_NAME, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    plaintext = opened.toString('utf8');
  } catch {
    // A wrong key, a bad tag, and a failed KDF all look the same to the caller.
    throw new Error(GENERIC_DECRYPT_ERROR);
  }

  let payload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw invalidFile('invalid plaintext');
  }

  return validatePayload(payload);
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error('Passphrase must be a string of at least 12 characters. Use 16 or more.');
  }
}

function assertKdfParameters(kdf) {
  const { N: n, r, p } = kdf;
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0) {
    throw invalidFile('invalid KDF parameter N');
  }
  if (!Number.isInteger(r) || r < MIN_R || r > MAX_R) {
    throw invalidFile('invalid KDF parameter r');
  }
  if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
    throw invalidFile('invalid KDF parameter p');
  }
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw invalidFile(`invalid base64 for ${label}`);
  }
  const decoded = Buffer.from(value, 'base64');
  // Buffer.from accepts non-canonical padding bits. Re-encoding rejects them.
  if (decoded.toString('base64') !== value) {
    throw invalidFile(`invalid base64 for ${label}`);
  }
  return decoded;
}

function normalizeEntries(entries, fail) {
  if (!isPlainObject(entries)) throw fail('entries must be an object');

  const pairs = Object.entries(entries);
  for (const [placeholder, value] of pairs) {
    if (typeof value !== 'string') {
      throw fail(`value for ${placeholder} must be a string`);
    }
  }
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(pairs);
}

function validatePayload(payload) {
  if (!isPlainObject(payload)) throw invalidFile('invalid plaintext');
  if (payload.version !== PLAINTEXT_VERSION) throw invalidFile('invalid plaintext version');
  if (!isIsoTimestamp(payload.createdAt)) throw invalidFile('invalid plaintext createdAt');
  if (
    !isPlainObject(payload.report) ||
    typeof payload.report.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(payload.report.sha256)
  ) {
    throw invalidFile('invalid plaintext report digest');
  }

  return {
    version: PLAINTEXT_VERSION,
    createdAt: payload.createdAt,
    report: { sha256: payload.report.sha256 },
    entries: normalizeEntries(payload.entries, invalidFile),
  };
}

function buildAad({ version, n, r, p, salt, iv }) {
  return [AAD_LABEL, version, n, r, p, salt, iv].join('\n');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoTimestamp(value) {
  return (
    typeof value === 'string' &&
    ISO_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function invalidFile(detail) {
  return new Error(`Invalid mapping file: ${detail}`);
}
