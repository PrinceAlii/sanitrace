// Custom detector loading.
//
// Rules come from three places and run in this order: config customRules,
// config ruleModules, then --rule-module. Loading and validation finish before
// the CLI reads the session input.

import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { rules as builtinRuleList } from './redact.js';

const MAX_RULES = 50;
const MAX_PATTERN_LENGTH = 1_000;
const MAX_TOTAL_PATTERN_LENGTH = 20_000;
const ALLOWED_FLAGS = new Set(['i', 'm', 's']);
const RULE_FIELDS = new Set(['id', 'label', 'description', 'pattern', 'flags', 'keepGroup']);
const RULE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const RULE_LABEL = /^[A-Z][A-Z0-9_]{1,31}$/;
const URL_SPECIFIER = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/**
 * @typedef {object} CustomRule
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {RegExp} pattern
 * @property {number} [keepGroup]
 * @property {string} source
 */

/**
 * Loads and validates custom rules from the config and module files.
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {string|null} [options.file] config file path
 * @param {string[]} [options.modules] paths from --rule-module
 * @param {string} [options.cwd]
 * @returns {Promise<CustomRule[]>}
 */
export async function loadCustomRules({
  config = {},
  file = null,
  modules = [],
  cwd = process.cwd(),
} = {}) {
  const configSource = file ? `config:${file}` : 'config';
  const loaded = [];
  const seenIds = new Map();
  const seenLabels = new Map();
  let totalPatternLength = 0;

  for (const rule of builtinRuleList()) {
    seenIds.set(rule.id, 'builtin');
    seenLabels.set(rule.label, 'builtin');
  }

  if (config.customRules !== undefined && !Array.isArray(config.customRules)) {
    throw new Error(`Config key "customRules" must be an array in ${file ?? 'config'}`);
  }
  if (config.ruleModules !== undefined) {
    if (!Array.isArray(config.ruleModules)) {
      throw new Error(`Config key "ruleModules" must be an array in ${file ?? 'config'}`);
    }
    for (const [index, value] of config.ruleModules.entries()) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(
          `Config key "ruleModules" must contain non-empty strings in ${file ?? 'config'} ` +
            `at entry ${index + 1}`,
        );
      }
    }
  }

  function addRule(raw, source, index, patternMayBeRegExp) {
    const origin = `rule ${index + 1} of ${source}`;
    if (loaded.length >= MAX_RULES) {
      throw new Error(
        `Custom rule limit is ${MAX_RULES}; ${loaded.length + 1} custom rules at ${origin}`,
      );
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Rule ${index + 1} of ${source} must be an object`);
    }

    for (const field of Object.keys(raw)) {
      if (!RULE_FIELDS.has(field)) {
        throw new Error(`Unknown field "${field}" in ${origin}`);
      }
    }

    const { id, label, description } = raw;
    if (typeof id !== 'string' || !RULE_ID.test(id)) {
      throw new Error(
        `Invalid field "id" in ${origin}: ` +
          'expected lowercase letters, digits, and hyphens, 2 to 32 characters',
      );
    }
    if (typeof label !== 'string' || !RULE_LABEL.test(label)) {
      throw new Error(
        `Invalid field "label" for rule "${id}" in ${origin}: ` +
          'expected uppercase letters, digits, and underscores, 2 to 32 characters',
      );
    }
    if (
      typeof description !== 'string' ||
      description.length < 5 ||
      description.length > 120 ||
      /[\r\n\u2028\u2029]/.test(description)
    ) {
      throw new Error(
        `Invalid field "description" for rule "${id}" in ${origin}: expected 5 to 120 characters on one line`,
      );
    }

    const rawPattern = raw.pattern;
    if (!patternMayBeRegExp && typeof rawPattern !== 'string') {
      throw new Error(`Field "pattern" for rule "${id}" in ${origin} must be a string`);
    }
    if (patternMayBeRegExp && typeof rawPattern !== 'string' && !(rawPattern instanceof RegExp)) {
      throw new Error(
        `Field "pattern" for rule "${id}" in ${origin} must be a string or RegExp`,
      );
    }

    let objectFlags = '';
    if (raw.flags !== undefined) {
      if (typeof raw.flags !== 'string') {
        throw new Error(`Invalid field "flags" for rule "${id}" in ${origin}: expected a string`);
      }
      assertAllowedFlags(raw.flags, `Invalid field "flags" for rule "${id}" in ${origin}`);
      objectFlags = raw.flags;
    }

    let patternFlags = '';
    if (rawPattern instanceof RegExp) {
      patternFlags = [...rawPattern.flags].filter((flag) => flag !== 'g').join('');
      assertAllowedFlags(patternFlags, `Invalid field "pattern" for rule "${id}" in ${origin}`);
    }
    const flags = [...new Set(`${objectFlags}${patternFlags}`)].join('');

    const patternLength =
      typeof rawPattern === 'string' ? rawPattern.length : rawPattern.source.length;
    if (patternLength > MAX_PATTERN_LENGTH) {
      throw new Error(
        `Pattern for rule "${id}" in ${origin} is ${patternLength} characters; ` +
          `the limit is ${MAX_PATTERN_LENGTH}`,
      );
    }
    totalPatternLength += patternLength;
    if (totalPatternLength > MAX_TOTAL_PATTERN_LENGTH) {
      throw new Error(
        `Custom rule patterns total ${totalPatternLength} characters after ${origin}; ` +
          `the limit is ${MAX_TOTAL_PATTERN_LENGTH}`,
      );
    }

    let pattern;
    try {
      const body = typeof rawPattern === 'string' ? rawPattern : rawPattern.source;
      pattern = new RegExp(body, `${flags}g`);
    } catch (error) {
      throw new Error(
        `Pattern for rule "${id}" in ${origin} does not compile: ${messageOf(error)}`,
      );
    }

    if (matchesEmpty(pattern)) {
      throw new Error(`Pattern for rule "${id}" in ${origin} matches an empty string`);
    }

    if (raw.keepGroup !== undefined && (!Number.isInteger(raw.keepGroup) || raw.keepGroup < 1)) {
      throw new Error(
        `Invalid field "keepGroup" for rule "${id}" in ${origin}: expected an integer of 1 or greater`,
      );
    }

    const previousId = seenIds.get(id);
    if (previousId !== undefined) {
      throw new Error(`Duplicate rule id "${id}" in ${origin}; already defined by ${previousId}`);
    }
    const previousLabel = seenLabels.get(label);
    if (previousLabel !== undefined) {
      throw new Error(
        `Duplicate rule label "${label}" in ${origin}; already defined by ${previousLabel}`,
      );
    }

    seenIds.set(id, origin);
    seenLabels.set(label, origin);
    loaded.push({
      id,
      label,
      description,
      pattern,
      ...(raw.keepGroup === undefined ? {} : { keepGroup: raw.keepGroup }),
      source,
    });
  }

  for (const [index, raw] of (config.customRules ?? []).entries()) {
    addRule(raw, configSource, index, false);
  }

  const configDirectory = file ? path.dirname(file) : cwd;
  for (const [index, specifier] of (config.ruleModules ?? []).entries()) {
    const resolved = resolveModule(specifier, configDirectory, `${configSource} entry ${index + 1}`);
    for (const [ruleIndex, raw] of (await importRules(resolved)).entries()) {
      addRule(raw, `module:${resolved}`, ruleIndex, true);
    }
  }

  for (const [index, specifier] of modules.entries()) {
    const resolved = resolveModule(specifier, cwd, `--rule-module entry ${index + 1}`);
    for (const [ruleIndex, raw] of (await importRules(resolved)).entries()) {
      addRule(raw, `module:${resolved}`, ruleIndex, true);
    }
  }

  return loaded;
}

function resolveModule(specifier, base, source) {
  if (typeof specifier !== 'string' || specifier.trim() === '') {
    throw new Error(`Rule module path in ${source} must be a non-empty string`);
  }
  if (URL_SPECIFIER.test(specifier) && !WINDOWS_DRIVE.test(specifier)) {
    throw new Error(
      `Rule module "${specifier}" in ${source} must be a local path; ` +
        'URLs and node:, data:, and file: specifiers are not allowed',
    );
  }
  return path.resolve(base, specifier);
}

async function importRules(resolved) {
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Rule module not found: ${resolved}`);
    throw new Error(`Could not read rule module ${resolved}: ${messageOf(error)}`);
  }
  if (!stats.isFile()) throw new Error(`Rule module is not a file: ${resolved}`);

  let namespace;
  try {
    namespace = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new Error(`Rule module ${resolved} failed to import: ${messageOf(error)}`);
  }

  if (!Array.isArray(namespace.default)) {
    throw new Error(
      `Rule module ${resolved} must export an array by default, received ${describeType(namespace.default)}`,
    );
  }
  return namespace.default;
}

function assertAllowedFlags(flags, context) {
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new Error(`${context}: "${flag}" is not allowed; allowed flags are i, m, s`);
    }
  }
}

function matchesEmpty(pattern) {
  for (const sample of ['', 'a b']) {
    pattern.lastIndex = 0;
    const matches = sample.match(pattern);
    pattern.lastIndex = 0;
    if (matches?.some((match) => typeof match === 'string' && match.length === 0)) {
      return true;
    }
  }
  return false;
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
