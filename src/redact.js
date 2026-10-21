// Redaction engine.
//
// Every detector is a plain regex plus a placeholder label. Nothing here talks to
// the network, and there are no runtime dependencies, so the whole surface is
// auditable in one file.
//
// Order matters: specific formats run before generic ones (a PEM block before the
// entropy pass, a credential-bearing URL before bare emails, an env assignment
// before the generic token rules).

const RULES = [
  {
    id: 'private-key',
    label: 'PRIVATE_KEY',
    description: 'PEM-encoded private keys',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: 'url-credentials',
    label: 'URL_CREDENTIALS',
    description: 'credentials embedded in a URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi,
  },
  {
    id: 'connection-string',
    label: 'CONNECTION_STRING',
    description: 'database connection strings',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql|clickhouse):\/\/[^\s"'`),;]+/gi,
  },
  {
    id: 'anthropic-key',
    label: 'ANTHROPIC_KEY',
    description: 'Anthropic API keys',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'openai-key',
    label: 'OPENAI_KEY',
    description: 'OpenAI API keys',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'github-token',
    label: 'GITHUB_TOKEN',
    description: 'GitHub tokens',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'cloud-key',
    label: 'CLOUD_KEY',
    description: 'AWS, Google and Slack credentials',
    pattern:
      /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'payment-key',
    label: 'PAYMENT_KEY',
    description: 'Stripe-style live/secret keys',
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'jwt',
    label: 'JWT',
    description: 'JSON Web Tokens',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'bearer-token',
    label: 'BEARER_TOKEN',
    description: 'Bearer and Basic authorization headers',
    pattern: /(?<=\b(?:Bearer|Basic)\s)[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    id: 'env-assignment',
    label: 'ENV_VALUE',
    description: 'values assigned to secret-looking env vars',
    pattern:
      /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|SALT|DSN|WEBHOOK)(?:_[A-Z0-9_]+)?)\s*[=:]\s*["']?([^\s"'#,}]{6,})/g,
    // Keep the variable name, redact only the literal value.
    replace: (token, match, _name, value) => {
      if (isPlaceholder(value)) return match;
      const suffix = /[.,;:!?]+$/.exec(value)?.[0] ?? '';
      return `${match.slice(0, match.length - value.length)}${token}${suffix}`;
    },
  },
  {
    id: 'email',
    label: 'EMAIL',
    description: 'email addresses',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    id: 'ipv4',
    label: 'IPV4',
    description: 'IPv4 addresses',
    pattern:
      /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\d)/g,
  },
];

const ENTROPY_RULE = {
  id: 'high-entropy',
  label: 'HIGH_ENTROPY',
  description: 'long random-looking strings',
};

const PATH_RULE = {
  id: 'path',
  label: 'PATH',
  description: 'local path prefixes',
};

const PLACEHOLDER_LABELS = new Set([
  ...RULES.map((rule) => rule.label),
  ENTROPY_RULE.label,
]);

const HEX_LIKE = /^[0-9a-f-]{32,}$/i;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_LIKE = /^(?:https?|wss?|git|ssh|file):/i;
const FILE_LIKE = /\.(?:[cm]?[jt]sx?|json|jsonl|md|toml|ya?ml|lock|css|html|png|svg|rs|go|py|rb|java|kt|swift|sh|zsh|sql|txt|log)$/i;

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * @typedef {object} RedactOptions
 * @property {string[]} [allow] literal values that should never be redacted
 * @property {string[]} [disable] rule ids to skip
 * @property {boolean} [entropy] enable the high-entropy fallback pass (default true)
 * @property {boolean} [emails] redact emails (default true)
 * @property {boolean} [ips] redact IP addresses (default true)
 * @property {{from: string, to: string}[]} [paths] literal prefixes to map to placeholders
 */

/**
 * Redacts a blob of text.
 * @param {string} input
 * @param {RedactOptions} [options]
 * @returns {{text: string, findings: {rule: string, label: string, count: number, samples: string[]}[]}}
 */
export function redact(input, options = {}) {
  const allow = options.allow ?? [];
  const disabled = new Set(options.disable ?? []);
  const counters = new Map();
  const samples = new Map();
  const seen = new Map();
  let text = String(input);

  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    if (rule.id === 'email' && options.emails === false) continue;
    if (rule.id === 'ipv4' && options.ips === false) continue;

    text = text.replace(rule.pattern, (...args) => {
      const match = args[0];
      if (isAllowed(match, allow)) return match;

      const token = placeholderFor(rule, match, counters, samples, seen);
      return rule.replace ? rule.replace(token, ...args) : token;
    });
  }

  // Path prefixes: $HOME and the repo root are the biggest identity leaks.
  const mappings = [...(options.paths ?? [])].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of mappings) {
    if (!from || from === '/') continue;
    const occurrences = text.split(from).length - 1;
    if (occurrences > 0) {
      counters.set(PATH_RULE.id, (counters.get(PATH_RULE.id) ?? 0) + occurrences);
      const pathSamples = samples.get(PATH_RULE.id) ?? [];
      if (pathSamples.length < 3) pathSamples.push(from);
      samples.set(PATH_RULE.id, pathSamples);
    }
    text = text.split(from).join(to);
  }

  if (options.entropy !== false && !disabled.has(ENTROPY_RULE.id)) {
    text = text.replace(/[A-Za-z0-9+/_=-]{32,}/g, (match) => {
      if (isAllowed(match, allow)) return match;
      if (UUID_LIKE.test(match) || HEX_LIKE.test(match) || URL_LIKE.test(match)) return match;
      if (FILE_LIKE.test(match)) return match;
      if (match.startsWith('/')) return match;
      if (!/[A-Z]/.test(match) || !/[a-z]/.test(match) || !/\d/.test(match)) return match;
      if (shannonEntropy(match) < 3.9) return match;
      return placeholderFor(ENTROPY_RULE, match, counters, samples, seen);
    });
  }

  return { text, findings: toFindings(counters, samples) };
}

/**
 * Re-runs every detector over an already-redacted document. Used by --verify to
 * catch a placeholder bug before the report is written.
 * @param {string} input
 * @param {RedactOptions} [options]
 * @returns {{rule: string, sample: string}[]}
 */
export function verify(input, options = {}) {
  const allow = options.allow ?? [];
  const disabled = new Set(options.disable ?? []);
  const hits = [];
  const text = String(input);

  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    if (rule.id === 'email' && options.emails === false) continue;
    if (rule.id === 'ipv4' && options.ips === false) continue;
    for (const match of text.matchAll(rule.pattern)) {
      if (isAllowed(match[0], allow)) continue;
      const sample = rule.id === 'env-assignment' ? (match[2] ?? match[0]) : match[0];
      if (isPlaceholder(sample)) continue;
      hits.push({ rule: rule.id, sample: sample.slice(0, 80) });
    }
  }
  return hits;
}

export function rules() {
  return [...RULES, ENTROPY_RULE, PATH_RULE].map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

function placeholderFor(rule, match, counters, samples, seen) {
  // counters = total occurrences, seen = one placeholder per distinct value.
  counters.set(rule.id, (counters.get(rule.id) ?? 0) + 1);

  const key = `${rule.id}\u0000${match}`;
  const existing = seen.get(key);
  if (existing) return existing;

  const index =
    [...seen.keys()].filter((entry) => entry.startsWith(`${rule.id}\u0000`)).length + 1;

  const ruleSamples = samples.get(rule.id) ?? [];
  if (ruleSamples.length < 3) ruleSamples.push(match.slice(0, 40));
  samples.set(rule.id, ruleSamples);

  const token = `[${rule.label}_${index}]`;
  seen.set(key, token);
  return token;
}

function toFindings(counters, samples) {
  return [...counters.entries()].map(([rule, count]) => {
    const definition = [...RULES, ENTROPY_RULE, PATH_RULE].find((item) => item.id === rule);
    return { rule, label: definition?.label ?? rule, count, samples: samples.get(rule) ?? [] };
  });
}

function isAllowed(match, allow) {
  return allow.some((entry) => entry && (match === entry || match.includes(entry)));
}

function isPlaceholder(value) {
  const inner = value
    .replace(/[.,;:!?]+$/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/_\d+$/, '');
  return PLACEHOLDER_LABELS.has(inner);
}
