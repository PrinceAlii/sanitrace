// Markdown renderer.
//
// The report is ordered for review: metadata, redaction summary, then turns.
// Tool input and output are collapsed into <details> blocks so a large log fits
// in an issue body.

import { createHash } from 'node:crypto';

export const VERSION = '0.3.0';
export const REDACTIONS_MARKER = '<!-- sanitrace:redactions -->';
export const TURN_END_MARKER = '<!-- sanitrace:turn:end -->';

// A turn marker is `<!-- sanitrace:turn:<index> -->` before stamping and
// `<!-- sanitrace:turn:<index>:<id> -->` after. The optional identifier lets a
// stamped report parse without recomputing first.
export const TURN_PREFIX = '<!-- sanitrace:turn:';
export const TURN_MARKER = /^<!-- sanitrace:turn:(\d+)(?::([0-9a-f]{12}))? -->$/;
export const TURN_HEADING = /^### (\d+)\. ([^\s].*)$/;

// The identifier is the first 12 hex characters of SHA-256 over the role and the
// normalized body. Normalization removes line-ending and whitespace noise so the
// same turn hashes the same on every platform.
export function turnId(role, body) {
  return createHash('sha256')
    .update(`${role}\n${normalizeBody(body)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

export function normalizeBody(body) {
  const rows = String(body)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (rows.length > 0 && rows[0] === '') rows.shift();
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

const PROFILES = {
  bug: {
    title: 'Agent session report',
    sections: [
      {
        heading: 'What happened',
        prompt: 'One or two sentences: what did you ask for, what went wrong?',
      },
      {
        heading: 'Expected',
        prompt: 'What should the agent have done instead?',
      },
    ],
  },
  security: {
    title: 'Agent session security report',
    sections: [
      {
        heading: 'Summary',
        prompt: 'Describe what went wrong and the security impact.',
      },
      {
        heading: 'Impact',
        prompt: 'Describe what an attacker could reach and what data is exposed.',
      },
      {
        heading: 'Affected versions',
        prompt: 'List the versions or commits that contain the problem.',
      },
      {
        heading: 'Reproduction',
        prompt: 'List the commands or steps that trigger the problem.',
      },
      {
        heading: 'Expected behavior',
        prompt: 'Describe what the software should do instead.',
      },
    ],
  },
  review: {
    title: 'Agent session review',
    sections: [
      {
        heading: 'Summary',
        prompt: 'Describe the change and why it is needed.',
      },
      {
        heading: 'Changes',
        prompt: 'List the files and behavior that changed.',
      },
      {
        heading: 'Verification',
        prompt: 'Describe what you ran to check the change.',
      },
      {
        heading: 'Risks',
        prompt: 'Describe what could break and what remains untested.',
      },
    ],
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

const SHELL_TOOLS = new Set(['shell', 'exec', 'exec_command', 'bash', 'run_command', 'apply_patch']);

/**
 * Returns a valid profile name or throws.
 * @param {string} [name]
 * @returns {'bug'|'security'|'review'}
 */
export function resolveProfile(name = 'bug') {
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error(`Unknown profile "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}`);
  }
  return name;
}

/**
 * Renders the redaction summary table.
 * @param {{label: string, count: number}[]} [findings]
 */
export function redactionTable(findings = []) {
  if (findings.length === 0) return 'No redactions were needed.';
  return [
    '| Placeholder | Count |',
    '| --- | --- |',
    ...findings.map((finding) => `| ${labelFor(finding.label)} | ${finding.count} |`),
  ].join('\n');
}

/**
 * @typedef {object} RenderOptions
 * @property {'bug'|'security'|'review'} [profile] report layout (default bug)
 * @property {boolean} [reasoning] include reasoning summaries
 * @property {boolean} [outputs] include tool output
 * @property {boolean} [summary] include the redaction summary (default true)
 * @property {{label: string, count: number}[]} [findings]
 */

/**
 * @param {ReturnType<import('./parse.js').parse>} parsed
 * @param {RenderOptions} [options]
 */
export function render(parsed, options = {}) {
  const profileName = resolveProfile(options.profile);
  const profile = PROFILES[profileName];
  const lines = [];
  const meta = parsed.meta;

  lines.push(`# ${profile.title}`, '');
  lines.push(
    `> Generated with [sanitrace](https://github.com/PrinceAlii/sanitrace) v${VERSION}. ` +
      'Detected secrets and local paths are replaced with placeholders such as ' +
      '`[OPENAI_KEY_1]`. The report is written locally.',
    '',
  );

  lines.push('## Metadata', '');
  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Format | \`${parsed.format}\` |`);
  if (profileName !== 'bug') lines.push(`| Profile | \`${profileName}\` |`);
  if (meta.model) lines.push(`| Model | \`${meta.model}\` |`);
  if (meta.source) lines.push(`| Client | ${meta.source}${meta.cliVersion ? ` ${meta.cliVersion}` : ''} |`);
  if (meta.cwd) lines.push(`| Working directory | \`${meta.cwd}\` |`);
  if (meta.sessionId) lines.push(`| Session | \`${shortId(meta.sessionId)}\` |`);
  if (meta.startedAt) lines.push(`| Started | ${meta.startedAt} |`);
  if (meta.endedAt) lines.push(`| Ended | ${duration(meta.startedAt, meta.endedAt)} |`);
  lines.push(
    `| Turns | ${parsed.turns.length} (${parsed.toolCalls} tool calls) |`,
    `| Tokens | ${parsed.usage.inputTokens.toLocaleString('en-US')} in / ` +
      `${parsed.usage.outputTokens.toLocaleString('en-US')} out` +
      (parsed.usage.cachedTokens ? ` / ${parsed.usage.cachedTokens.toLocaleString('en-US')} cached` : ''),
    '',
  );

  if (options.summary !== false) {
    lines.push('## Redactions', '', redactionTable(options.findings), '');
  } else {
    lines.push(REDACTIONS_MARKER, '');
  }

  if (parsed.skipped > 0) {
    lines.push(`_${parsed.skipped} unrecognized record(s) were skipped._`, '');
  }

  for (const section of profile.sections) {
    lines.push(`## ${section.heading}`, '', `<!-- ${section.prompt} -->`, '');
  }

  lines.push('---', '', '## Transcript', '');

  const boilerplateTurns = parsed.turns.filter((turn) => isBoilerplate(turn.role));

  // Render each turn first so the report can be budgeted without cutting a code
  // fence in half.
  const rendered = [];
  const sources = [];
  parsed.turns.forEach((turn, index) => {
    if (isBoilerplate(turn.role) && options.developer !== true) return;
    sources.push({ turn, index });
    rendered.push(renderTurn(turn, index, options, 1));
  });

  const budget = options.maxTotal ?? 120_000;
  let total = rendered.reduce((sum, chunk) => sum + chunk.length, 0);

  // Scale block text before eliding turns so the report keeps its structure.
  if (total > budget * 1.1) {
    const scale = Math.max(0.02, budget / total);
    for (let position = 0; position < rendered.length; position += 1) {
      const { turn, index } = sources[position];
      rendered[position] = renderTurn(turn, index, options, scale);
    }
    total = rendered.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  let kept = rendered;
  let elided = 0;

  if (total > budget) {
    const head = [];
    const tail = [];
    let used = 0;
    let low = 0;
    let high = rendered.length - 1;
    let turn = 0;

    // Alternate from both ends so the opening request and the final result
    // survive; the middle is what gets dropped.
    while (low <= high && used < budget) {
      const index = turn % 2 === 0 ? low++ : high--;
      let chunk = rendered[index];
      const remaining = budget - used;
      if (chunk.length > remaining) {
        if (remaining < 500) break;
        chunk = closeFences(`${chunk.slice(0, remaining).trimEnd()}\n`);
      }
      if (turn % 2 === 0) head.push(chunk);
      else tail.unshift(chunk);
      used += chunk.length;
      turn += 1;
    }

    elided = rendered.length - head.length - tail.length;
    kept = [...head, ...tail];
  }

  if (kept.length > 0) lines.push(kept.join('\n'));
  lines.push(TURN_END_MARKER, '');
  if (elided > 0) {
    lines.push(`_${elided} turn(s) elided to keep the report under ${budget} chars; raise \`--max-total\` to keep more._`, '');
  }

  if (boilerplateTurns.length > 0) {
    lines.push(`_${boilerplateTurns.length} developer/system message(s) omitted; use \`--keep-developer\` to include them._`, '');
  }

  lines.push('---', '');
  lines.push(
    `_${kept.length} turns, ${parsed.toolCalls} tool calls, ` +
      `redacted with sanitrace v${VERSION}._`,
    '',
  );

  return lines.join('\n');
}

function renderTurn(turn, index, options, scale) {
  const body = turn.blocks
    .filter((block) => !(block.kind === 'reasoning' && options.reasoning === false))
    .filter((block) => !(block.kind === 'output' && options.outputs === false))
    .map((block) => renderBlock(block, scale))
    .join('\n');
  return `<!-- sanitrace:turn:${index + 1} -->\n### ${index + 1}. ${turn.role}\n\n${body}\n`;
}

// stampTurnIds replaces each `<!-- sanitrace:turn:N -->` marker with
// `<!-- sanitrace:turn:N:<id> -->`. The id hashes the role and the normalized
// body, so it stays stable after redaction and across platforms. A marker with
// no role stays a placeholder, and the end marker passes through unchanged.
export function stampTurnIds(markdown) {
  const rows = String(markdown).replaceAll('\r\n', '\n').split('\n');
  const out = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.role !== null) {
      const id = turnId(current.role, current.body.join('\n'));
      out[current.at] = `<!-- sanitrace:turn:${current.index}:${id} -->`;
    }
    current = null;
  };

  for (const line of rows) {
    const marker = line.match(TURN_MARKER);
    if (marker) {
      flush();
      out.push(line);
      current = { index: marker[1], at: out.length - 1, role: null, body: [] };
      continue;
    }
    if (line === TURN_END_MARKER) {
      flush();
      out.push(line);
      continue;
    }
    if (current === null) {
      out.push(line);
      continue;
    }
    const heading = current.role === null ? line.match(TURN_HEADING) : null;
    if (heading) {
      current.role = heading[2];
      out.push(line);
      continue;
    }
    current.body.push(line);
    out.push(line);
  }
  flush();
  return out.join('\n');
}

function renderBlock(block, scale) {
  const text = scale < 1 ? clipText(block.text, scale) : block.text;
  if (block.kind === 'text') return `${text.trim()}\n`;
  if (block.kind === 'reasoning') return `${collapse('reasoning summary', text, '')}\n`;
  if (block.kind === 'tool') {
    const language = SHELL_TOOLS.has(block.name) ? 'sh' : 'text';
    return `${collapse(`tool: ${block.name}`, text, language)}\n`;
  }
  return `${collapse('output', text, 'text')}\n`;
}

function clipText(text, scale) {
  const limit = Math.max(180, Math.floor(text.length * scale));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n… ${text.length - limit} chars cut`;
}

function isBoilerplate(role) {
  return role === 'developer' || role === 'system';
}

// A hard clip can land inside a code fence or a <details> block. Close whichever
// is still open so the trailing Markdown renders.
function closeFences(chunk) {
  const fences = (chunk.match(/^```/gm) ?? []).length;
  const details = (chunk.match(/<details>/g) ?? []).length;
  const closed = (chunk.match(/<\/details>/g) ?? []).length;
  let suffix = '';
  if (fences % 2 === 1) suffix += '```\n\n';
  if (details > closed) suffix += '</details>\n';
  return `${chunk}${suffix}`;
}

function collapse(label, body, language) {
  const fence = body.includes('```') ? '````' : '```';
  return [
    `<details><summary>${escapeHtml(label)} · ${body.length.toLocaleString('en-US')} chars</summary>`,
    '',
    `${fence}${language}`,
    body.trim(),
    fence,
    '',
    '</details>',
  ].join('\n');
}

function escapeHtml(value) {
  return value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

function labelFor(label) {
  if (label === 'PATH') return '`<REPO>`, `~`, `<HOST>`';
  return `\`[${label}_*]\``;
}

function shortId(value) {
  return String(value).length > 13 ? `${String(value).slice(0, 8)}…` : String(value);
}

function duration(start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 'unknown';
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
