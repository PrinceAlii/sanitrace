#!/usr/bin/env node
// sanitrace CLI. Reads a session log and writes a redacted report.

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { loadConfig, loadCustomRules, resolveProfile, rules, sanitize } from '../src/index.js';

const HELP = `sanitrace: turn an agent session log into a redacted Markdown report

Usage
  sanitrace <session.jsonl> [options]      write a report to stdout
  cat session.jsonl | sanitrace - [options]
  sanitrace rules                          list detectors

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
  -h, --help              show this help
  -v, --version           show the version

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

  const source = command === '-' ? await readStdin() : await readFile(command, 'utf8');
  if (!source.trim()) throw new Error('input is empty');

  const { markdown, findings, residual } = sanitize(source, settings);

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

  if (values.json) {
    const payload = JSON.stringify(
      { findings, residual, markdown, profile: settings.profile },
      null,
      2,
    );
    if (values.out) await writeFile(values.out, `${payload}\n`);
    else process.stdout.write(`${payload}\n`);
  } else if (values.out) {
    await writeFile(values.out, markdown);
    process.stderr.write(`sanitrace: wrote ${values.out}\n`);
  } else {
    process.stdout.write(markdown);
  }

  const total = findings.reduce((sum, finding) => sum + finding.count, 0);
  process.stderr.write(
    `sanitrace: ${total} redaction(s) across ${findings.length} rule(s)\n`,
  );

  if (residual.length > 0 && !values['no-verify']) process.exitCode = 3;
  else if (values.check && total > 0) process.exitCode = 1;
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
