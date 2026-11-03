import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';

test('rejects invalid configuration values without printing them', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sanitrace-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const cases = [
    ['entropy', 'secret-value'], ['emails', 1], ['ips', null],
    ['reasoning', 'true'], ['developer', 0], ['outputs', []],
    ['allow', [1]], ['disable', ['BAD_ID']], ['keepPaths', [null]],
    ['ruleModules', [' ']], ['maxToolChars', 99], ['maxToolChars', '200'],
    ['maxTotal', 0], ['maxTotal', 1.5], ['maxTotal', Number.MAX_SAFE_INTEGER + 1],
  ];

  for (const [key, value] of cases) {
    writeFileSync(file, JSON.stringify({ [key]: value }));
    assert.throws(() => loadConfig(file), (error) => {
      assert.ok(error.message.includes(`Config key "${key}"`));
      assert.ok(!error.message.includes('secret-value'));
      return true;
    });
  }
});

test('accepts valid configuration values at their limits', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sanitrace-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const config = {
    entropy: false, emails: true, ips: false, reasoning: false,
    developer: false, outputs: true, allow: ['example'], disable: ['ipv4'],
    keepPaths: ['/tmp/example'], ruleModules: [], maxToolChars: 100, maxTotal: 1,
  };
  writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(loadConfig(file).config, config);
});

test('rejects invalid config before reading input even when a flag overrides it', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sanitrace-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  writeFileSync(file, JSON.stringify({ maxToolChars: 'invalid' }));
  const cli = fileURLToPath(new URL('../bin/sanitrace.js', import.meta.url));
  const result = spawnSync(process.execPath, [
    cli, path.join(directory, 'missing'), '--config', file, '--max-tool-chars', '200',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Config key "maxToolChars"/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
