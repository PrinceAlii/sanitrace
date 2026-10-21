import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CONFIG_NAME = '.sanitrace.json';

const KNOWN_KEYS = new Set([
  'allow',
  'disable',
  'entropy',
  'emails',
  'ips',
  'reasoning',
  'developer',
  'outputs',
  'maxToolChars',
  'maxTotal',
  'keepPaths',
]);

/**
 * Reads `.sanitrace.json` from an explicit path or by walking up from `from`.
 * @param {string|undefined} explicit
 * @param {string} [from]
 */
export function loadConfig(explicit, from = process.cwd()) {
  const file = explicit ? path.resolve(explicit) : findUp(from);
  if (!file) return { config: {}, file: null };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read config at ${file}: ${error.message}`);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config at ${file} must be a JSON object`);
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`Unknown config key "${key}" in ${file}`);
    if (key === 'allow' || key === 'disable' || key === 'keepPaths') {
      if (!Array.isArray(raw[key])) throw new Error(`Config key "${key}" must be an array in ${file}`);
    }
  }

  return { config: raw, file };
}

function findUp(start) {
  let directory = path.resolve(start);
  while (true) {
    const candidate = path.join(directory, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
