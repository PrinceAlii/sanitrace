// Orchestration: parse -> render -> redact -> verify.

import os from 'node:os';
import path from 'node:path';

import { parse } from './parse.js';
import { redact, verify } from './redact.js';
import { REDACTIONS_MARKER, redactionTable, render, resolveProfile } from './render.js';

export { detectFormat, parse } from './parse.js';
export { redact, rules, verify } from './redact.js';
export { PROFILE_NAMES, render, resolveProfile } from './render.js';
export { loadConfig } from './config.js';
export { loadCustomRules } from './custom-rules.js';

/**
 * @typedef {object} SanitizeOptions
 * @property {'bug'|'security'|'review'} [profile] report layout (default bug)
 * @property {'auto'|'codex'|'claude'|'opencode'|'gemini'|'text'} [format]
 * @property {string[]} [allow] values to leave untouched
 * @property {string[]} [disable] rule ids to skip
 * @property {boolean} [entropy]
 * @property {boolean} [emails]
 * @property {boolean} [ips]
 * @property {boolean} [reasoning]
 * @property {boolean} [outputs]
 * @property {boolean} [developer]
 * @property {number} [maxToolChars]
 * @property {number} [maxTotal]
 * @property {string[]} [keepPaths] absolute prefixes to leave as-is
 * @property {{id: string, label: string, pattern: RegExp, keepGroup?: number}[]} [rules]
 *   custom rules that run after the built-ins
 * @property {{id: string, label: string, pattern: RegExp, keepGroup?: number}[]} [customRules]
 *   alias for rules
 * @property {boolean} [mapping] include placeholder-to-original entries in the result
 */

/**
 * Turns a raw session log into a redacted Markdown report.
 * @param {string} text
 * @param {SanitizeOptions} [options]
 * @returns {{
 *   markdown: string,
 *   findings: {rule: string, label: string, count: number, samples: string[]}[],
 *   residual: {rule: string, sample: string}[],
 *   parsed: ReturnType<import('./parse.js').parse>,
 *   mapping?: Record<string, string>
 * }}
 */
export function sanitize(text, options = {}) {
  const profile = resolveProfile(options.profile);
  const wantsMapping = options.mapping === true;
  const parsed = parse(text, { format: options.format, maxToolChars: options.maxToolChars });
  const draft = render(parsed, {
    findings: undefined,
    reasoning: options.reasoning,
    outputs: options.outputs,
    developer: options.developer,
    maxTotal: options.maxTotal,
    profile,
    summary: false,
  });

  const redactOptions = {
    allow: options.allow ?? [],
    disable: options.disable ?? [],
    entropy: options.entropy,
    emails: options.emails,
    ips: options.ips,
    paths: pathMappings(parsed.meta.cwd, options.keepPaths ?? []),
    rules: options.rules ?? options.customRules ?? [],
    mapping: wantsMapping,
  };

  const {
    text: body,
    findings,
    entries = [],
    pathEntries = [],
  } = redact(draft, redactOptions);

  // The summary itself contains placeholders only, so it is safe to append after
  // redaction instead of redacting twice.
  const markdown = insertSummary(body, findings);
  const residual = verify(markdown, redactOptions);

  const result = { markdown, findings, residual, parsed };
  if (wantsMapping) result.mapping = mergeMapping(entries, pathEntries, parsed.meta.cwd);
  return result;
}

function mergeMapping(entries, pathEntries, cwd) {
  const values = new Map(entries.map((entry) => [entry.placeholder, entry.value]));
  const canonical = { '<REPO>': cwd, '~': os.homedir(), '<HOST>': os.hostname() };

  for (const { placeholder } of pathEntries) {
    if (Object.hasOwn(canonical, placeholder) && canonical[placeholder]) {
      values.set(placeholder, canonical[placeholder]);
    }
  }

  return Object.fromEntries(
    [...values].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function pathMappings(cwd, keepPaths) {
  const keep = keepPaths.filter(Boolean);
  const candidates = [
    { from: cwd, to: '<REPO>' },
    { from: os.homedir(), to: '~' },
    { from: os.hostname(), to: '<HOST>' },
    { from: path.basename(os.homedir()) ? `/Users/${path.basename(os.homedir())}` : null, to: '~' },
    { from: `/home/${path.basename(os.homedir())}`, to: '~' },
  ];

  return candidates
    .filter((entry) => entry.from && entry.from.length >= 4)
    .filter((entry) => !keep.some((prefix) => entry.from === prefix))
    .sort((a, b) => b.from.length - a.from.length);
}

function insertSummary(markdown, findings) {
  const section = `## Redactions\n\n${redactionTable(findings)}`;

  if (markdown.includes(REDACTIONS_MARKER)) {
    return markdown.replace(REDACTIONS_MARKER, section);
  }

  if (markdown.includes('## Transcript')) {
    return markdown.replace('## Transcript', `${section}\n\n## Transcript`);
  }

  return `${markdown}\n${section}`;
}
