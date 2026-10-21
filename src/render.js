// Markdown renderer.
//
// The report is ordered for review: metadata, redaction summary, then turns.
// Tool input and output are collapsed into <details> blocks so a large log fits
// in an issue body.

export const VERSION = '0.1.1';

const SHELL_TOOLS = new Set(['shell', 'exec', 'exec_command', 'bash', 'run_command', 'apply_patch']);

/**
 * @typedef {object} RenderOptions
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
  const lines = [];
  const meta = parsed.meta;

  lines.push('# Agent session report', '');
  lines.push(
    `> Generated with [sanitrace](https://github.com/PrinceAlii/sanitrace) v${VERSION}. ` +
      'Detected secrets and local paths are replaced with placeholders such as ' +
      '`[OPENAI_KEY_1]`. The report is written locally.',
    '',
  );

  lines.push('## Metadata', '');
  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Format | \`${parsed.format}\` |`);
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
    lines.push('## Redactions', '');
    const findings = options.findings ?? [];
    if (findings.length === 0) {
      lines.push('No redactions were needed.', '');
    } else {
      lines.push('| Placeholder | Count |', '| --- | --- |');
      for (const finding of findings) lines.push(`| \`[${finding.label}_*]\` | ${finding.count} |`);
      lines.push('');
    }
  }

  if (parsed.skipped > 0) {
    lines.push(`_${parsed.skipped} unrecognized record(s) were skipped._`, '');
  }

  lines.push('## What happened', '', '<!-- One or two sentences: what did you ask for, what went wrong? -->', '');
  lines.push('## Expected', '', '<!-- What should the agent have done instead? -->', '');

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
  return `### ${index + 1}. ${turn.role}\n\n${body}\n`;
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
