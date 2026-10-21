#!/usr/bin/env node
// sanitrace CLI. Reads a session log and writes a redacted report.

import { chmod, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { loadConfig, loadCustomRules, resolveProfile, rules, sanitize } from '../src/index.js';
import { decryptMapping, encryptMapping, reportDigest } from '../src/mapping.js';

const DEFAULT_PASSPHRASE_ENV = 'SANITRACE_MAPPING_PASSPHRASE';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAPPING_WARNING = 'sanitrace: mapping contains original secrets; avoid logging stdout.';

const HELP = `sanitrace: turn an agent session log into a redacted Markdown report

Usage
  sanitrace <session.jsonl> [options]      write a report to stdout
  cat session.jsonl | sanitrace - [options]
  sanitrace rules                          list detectors
  sanitrace mapping show <file> [--report <report>]
                                           decrypt a mapping to stdout

Options
  -o, --out <file>        write the report to a file instead of stdout
      --format <name>     auto (default), codex, claude, text
      --profile <name>    report profile: bug (default), security, review
      --config <file>     use a specific .sanitrace.json
      --rule-module <path> load a rule module (repeatable)
      --allow <value>     never redact a value (repeatable)
      --disable <rule>    skip a detector by id (repeatable)
      --max-tool-chars    characters of tool output to keep (default 2000)
      --max-total <n>     total report budget in chars (default 120000)
      --keep-reasoning    include reasoning summaries
      --keep-developer    include developer/system boilerplate messages
      --no-outputs        drop tool output entirely
      --no-entropy        disable the high-entropy fallback pass
      --no-emails         keep email addresses
      --no-ips            keep IP addresses
      --keep-path <path>  leave an absolute path prefix untouched
      --check             exit 1 when anything was redacted (for CI)
      --no-verify         skip the post-render residual check
      --json              emit JSON with the report, findings and residuals
      --mapping <file>    write an encrypted placeholder mapping
      --mapping-passphrase-env <name>
                          environment variable for the mapping passphrase
                          (default ${DEFAULT_PASSPHRASE_ENV})
      --force             replace an existing mapping file
  -h, --help              show this help
  -v, --version           show the version

Mapping
  sanitrace mapping show <file> [--report <report>]
  mapping show decrypts with the passphrase from the environment and prints
  JSON to stdout. --report checks the Markdown report hash; with --json, pass
  the Markdown file instead of the JSON payload.
  Warning: mapping contains original secrets; avoid logging stdout.
  The passphrase is never accepted on the command line. Use 16 or more
  characters. The mapping file is written with mode 0600 where supported.
  The mapping is not included in the report or in --json output.

Exit codes
  0  report written          1  --check found redactions
  2  usage/IO error          3  residual secrets after verify

Config
  .sanitrace.json is read from the working directory upward:
  { "allow": [], "disable": [], "entropy": true, "emails": true,
    "ips": true, "reasoning": false, "outputs": true, "developer": false,
    "maxToolChars": 2000, "maxTotal": 120000, "keepPaths": [],
    "profile": "bug", "customRules": [], "ruleModules": [] }

No network access.
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      format: { type: 'string', default: 'auto' },
      profile: { type: 'string' },
      config: { type: 'string' },
      'rule-module': { type: 'string', multiple: true, default: [] },
      allow: { type: 'string', multiple: true, default: [] },
      disable: { type: 'string', multiple: true, default: [] },
      'max-tool-chars': { type: 'string' },
      'max-total': { type: 'string' },
      'keep-reasoning': { type: 'boolean', default: false },
      'keep-developer': { type: 'boolean', default: false },
      'keep-path': { type: 'string', multiple: true, default: [] },
      'no-outputs': { type: 'boolean', default: false },
      'no-entropy': { type: 'boolean', default: false },
      'no-emails': { type: 'boolean', default: false },
      'no-ips': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      mapping: { type: 'string' },
      'mapping-passphrase-env': { type: 'string', default: DEFAULT_PASSPHRASE_ENV },
      force: { type: 'boolean', default: false },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
} catch (error) {
  process.stderr.write(`sanitrace: ${error.message}\n\n${HELP}`);
  process.exit(2);
}

const { values, positionals } = args;

main().catch((error) => {
  process.stderr.write(`sanitrace: ${error.message}\n`);
  process.exit(2);
});

async function main() {
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return void process.stdout.write(`${pkg.version}\n`);
  }

  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    process.exitCode = 2;
    return;
  }

  if (command === 'mapping') return showMapping();

  const { config, file } = loadConfig(values.config);
  const customRules = await loadCustomRules({
    config,
    file,
    modules: values['rule-module'],
  });

  if (command === 'rules') return printRules(customRules);

  const settings = {
    format: values.format,
    profile: resolveProfile(values.profile ?? config.profile),
    allow: [...(config.allow ?? []), ...values.allow],
    disable: [...(config.disable ?? []), ...values.disable],
    entropy: values['no-entropy'] ? false : (config.entropy ?? true),
    emails: values['no-emails'] ? false : (config.emails ?? true),
    ips: values['no-ips'] ? false : (config.ips ?? true),
    reasoning: values['keep-reasoning'] || config.reasoning === true,
    developer: values['keep-developer'] || config.developer === true,
    outputs: values['no-outputs'] ? false : (config.outputs ?? true),
    maxToolChars: Number(values['max-tool-chars'] ?? config.maxToolChars ?? 2000),
    maxTotal: Number(values['max-total'] ?? config.maxTotal ?? 120_000),
    keepPaths: [...(config.keepPaths ?? []), ...values['keep-path']],
    rules: customRules,
  };

  if (!Number.isFinite(settings.maxToolChars) || settings.maxToolChars < 100) {
    throw new Error('--max-tool-chars must be a number of at least 100');
  }

  const mappingRequested = values.mapping !== undefined;
  let passphrase = null;
  let mappingPath = null;
  if (mappingRequested) {
    passphrase = mappingPassphrase(values['mapping-passphrase-env']);
    mappingPath = await prepareMappingPath(values.mapping, values.out, values.force);
  }

  const source = command === '-' ? await readStdin() : await readFile(command, 'utf8');
  if (!source.trim()) throw new Error('input is empty');

  const { markdown, findings, residual, mapping } = sanitize(source, {
    ...settings,
    mapping: mappingRequested,
  });

  if (residual.length > 0 && !values['no-verify']) {
    process.stderr.write(
      `sanitrace: verify found ${residual.length} possible leftover(s):\n` +
        residual
          .slice(0, 5)
          .map((hit) => `  ${hit.rule}: ${hit.sample}`)
          .join('\n') +
        '\n',
    );
  }

  let heldReport = null;
  if (values.json) {
    const payload = JSON.stringify(
      { findings, residual, markdown, profile: settings.profile },
      null,
      2,
    );
    if (values.out) await writeFile(values.out, `${payload}\n`);
    else heldReport = `${payload}\n`;
  } else if (values.out) {
    await writeFile(values.out, markdown);
    process.stderr.write(`sanitrace: wrote ${values.out}\n`);
  } else {
    heldReport = markdown;
  }

  if (mappingRequested) {
    const contents = encryptMapping({
      passphrase,
      reportDigest: reportDigest(markdown),
      entries: mapping,
    });
    try {
      await writeFile(mappingPath, contents, { mode: 0o600 });
      if (process.platform !== 'win32') await chmod(mappingPath, 0o600);
    } catch (error) {
      throw new Error(`could not write mapping ${mappingPath}: ${error.message}`);
    }
  }

  if (heldReport !== null) process.stdout.write(heldReport);

  const total = findings.reduce((sum, finding) => sum + finding.count, 0);
  process.stderr.write(
    `sanitrace: ${total} redaction(s) across ${findings.length} rule(s)\n`,
  );

  if (residual.length > 0 && !values['no-verify']) process.exitCode = 3;
  else if (values.check && total > 0) process.exitCode = 1;
}

async function showMapping() {
  const subcommand = positionals[1];
  const mappingFile = positionals[2];
  if (subcommand !== 'show' || !mappingFile) {
    throw new Error('usage: sanitrace mapping show <file> [--report <report>]');
  }
  if (positionals.length > 3) throw new Error(`unexpected argument: ${positionals[3]}`);

  const passphrase = mappingPassphrase(values['mapping-passphrase-env']);
  let contents;
  try {
    contents = await readFile(mappingFile, 'utf8');
  } catch (error) {
    throw new Error(`cannot read mapping ${mappingFile}: ${error.message}`);
  }

  const mapping = decryptMapping({ passphrase, contents });

  if (values.report !== undefined) {
    if (values.report.length === 0) throw new Error('--report requires a file path');
    let report;
    try {
      report = await readFile(values.report, 'utf8');
    } catch (error) {
      throw new Error(`cannot read report ${values.report}: ${error.message}`);
    }
    if (reportDigest(report) !== mapping.report.sha256) {
      throw new Error(`report hash does not match ${values.report}`);
    }
  }

  process.stdout.write(`${JSON.stringify(mapping, null, 2)}\n`);
  process.stderr.write(`${MAPPING_WARNING}\n`);
}

function mappingPassphrase(name) {
  if (!ENV_NAME.test(name)) {
    throw new Error(
      `--mapping-passphrase-env must be an uppercase environment variable name, received "${name}". ` +
        'Use uppercase letters, digits, and underscores, and start with a letter or underscore. ' +
        'Set the variable to a passphrase of 16 or more characters.',
    );
  }

  const passphrase = process.env[name];
  if (passphrase === undefined || passphrase.length === 0) {
    throw new Error(
      `environment variable ${name} is missing or empty. ` +
        'Set it to a passphrase of 16 or more characters.',
    );
  }
  if (passphrase.length < 12) {
    throw new Error(
      `environment variable ${name} must contain at least 12 characters. Use 16 or more.`,
    );
  }
  return passphrase;
}

async function prepareMappingPath(mappingFile, outFile, force) {
  const target = path.resolve(mappingFile);
  if (outFile !== undefined && path.resolve(outFile) === target) {
    throw new Error(`--mapping must differ from --out: ${target}`);
  }

  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`cannot inspect mapping path ${target}: ${error.message}`);
    }
    return prepareMappingDirectory(target);
  }

  if (details.isSymbolicLink()) {
    throw new Error(`mapping path is a symlink: ${target}. Choose a different path.`);
  }
  if (!details.isFile()) {
    throw new Error(`mapping path is not a regular file: ${target}`);
  }
  if (!force) {
    throw new Error(`mapping file already exists: ${target}. Use --force to replace it.`);
  }
  return target;
}

async function prepareMappingDirectory(target) {
  const parent = path.dirname(target);
  let details;
  try {
    details = await stat(parent);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`mapping directory does not exist: ${parent}`);
    }
    throw new Error(`cannot inspect mapping directory ${parent}: ${error.message}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`mapping directory is not a directory: ${parent}`);
  }
  return target;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function printRules(customRules = []) {
  const lines = ['id\tplaceholder\tdescription\tsource'];
  for (const rule of rules()) {
    lines.push(`${rule.id}\t${rule.placeholder}\t${rule.description}\tbuiltin`);
  }
  for (const rule of customRules) {
    lines.push(`${rule.id}\t[${rule.label}_N]\t${rule.description}\t${rule.source}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
