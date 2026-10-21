// Session-log parsers.
//
// Parsers are lenient: session formats are internal to each agent and change
// between releases. Unknown records are counted and skipped instead of raising,
// because a report that drops one record is better than no report.

const MAX_BLOCK_CHARS = 6000;
const MAX_TOOL_CHARS = 2000;

/** @typedef {{kind: 'text'|'tool'|'output'|'reasoning', role?: string, name?: string, text: string, originalChars: number}} Block */
/** @typedef {{role: string, blocks: Block[]}} Turn */

/**
 * @param {string} text
 * @returns {'codex'|'claude'|'text'}
 */
export function detectFormat(text) {
  const head = text.slice(0, 20000);
  if (/"type"\s*:\s*"session_meta"/.test(head) || /"model_provider"\s*:/.test(head)) {
    return 'codex';
  }
  if (/"sessionId"\s*:/.test(head) && /"message"\s*:\s*\{/.test(head)) return 'claude';
  return 'text';
}

/**
 * @param {string} text
 * @param {{format?: string, maxToolChars?: number}} [options]
 */
export function parse(text, options = {}) {
  const format = options.format && options.format !== 'auto'
    ? options.format
    : detectFormat(text);
  const limits = {
    maxBlockChars: options.maxBlockChars ?? MAX_BLOCK_CHARS,
    maxToolChars: options.maxToolChars ?? MAX_TOOL_CHARS,
  };

  if (format === 'codex') return parseCodex(text, limits);
  if (format === 'claude') return parseClaude(text, limits);
  return parseText(text, limits);
}

function emptyResult(format) {
  return {
    format,
    meta: { cwd: null, model: null, cliVersion: null, startedAt: null, endedAt: null, source: null },
    turns: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    skipped: 0,
    toolCalls: 0,
  };
}

function clip(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return { text, originalChars: text.length };
  return {
    text: `${text.slice(0, limit)}\n… truncated ${text.length - limit} of ${text.length} chars`,
    originalChars: text.length,
  };
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
        return block.text ?? '';
      }
      if (block?.type === 'tool_result') return messageText(block.content);
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function firstReasoningSummary(payload) {
  if (!Array.isArray(payload.summary)) return '';
  return payload.summary.map((item) => item?.text ?? '').filter(Boolean).join('\n\n');
}

function parseCodex(text, limits) {
  const result = emptyResult('codex');
  const turns = [];
  const outputs = new Map();
  const seen = new Set();
  let current = null;

  const push = (role) => {
    const last = turns.at(-1);
    if (last?.role === role) return last;
    current = { role, blocks: [] };
    turns.push(current);
    return current;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      result.skipped += 1;
      continue;
    }

    const payload = record.payload ?? record;

    if (record.type === 'session_meta') {
      result.meta.cwd = payload.cwd ?? null;
      result.meta.cliVersion = payload.cli_version ?? null;
      result.meta.source = payload.originator ?? payload.source ?? null;
      result.meta.startedAt = payload.timestamp ?? record.timestamp ?? null;
      result.meta.sessionId = payload.session_id ?? null;
      continue;
    }

    if (record.type === 'turn_context') {
      result.meta.model = payload.model ?? result.meta.model;
      continue;
    }

    if (record.type === 'token_count' || record.type === 'token_usage_record') {
      const usage = payload.info?.total_token_usage ?? record.usage ?? payload.usage;
      if (usage) {
        result.usage.inputTokens = Math.max(result.usage.inputTokens, usage.input_tokens ?? 0);
        result.usage.outputTokens = Math.max(result.usage.outputTokens, usage.output_tokens ?? 0);
        result.usage.cachedTokens = Math.max(result.usage.cachedTokens, usage.cached_input_tokens ?? 0);
      }
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'task_complete') result.meta.endedAt = record.timestamp ?? null;
      continue;
    }

    if (record.type !== 'response_item') continue;

    const id = payload.id ?? payload.call_id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);

    switch (payload.type) {
      case 'message': {
        const body = messageText(payload.content);
        if (!body.trim()) break;
        const turn = push(payload.role ?? 'assistant');
        turn.blocks.push({ kind: 'text', ...clip(body, limits.maxBlockChars) });
        break;
      }
      case 'reasoning': {
        const summary = firstReasoningSummary(payload);
        if (!summary.trim()) break;
        const turn = current?.role === 'assistant' ? current : push('assistant');
        turn.blocks.push({ kind: 'reasoning', ...clip(summary, limits.maxBlockChars) });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const turn = push('assistant');
        result.toolCalls += 1;
        turn.blocks.push({
          kind: 'tool',
          name: payload.name ?? 'tool',
          callId: payload.call_id ?? id,
          ...clip(payload.arguments ?? payload.input ?? '', limits.maxToolChars),
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const body = messageText(payload.output) || (typeof payload.output === 'string' ? payload.output : '');
        outputs.set(payload.call_id ?? id, body);
        break;
      }
      default:
        result.skipped += 1;
    }
  }

  // Attach outputs to the matching call in document order.
  for (const turn of turns) {
    const withOutputs = [];
    for (const block of turn.blocks) {
      withOutputs.push(block);
      const body = block.kind === 'tool' ? outputs.get(block.callId) : undefined;
      if (body) withOutputs.push({ kind: 'output', ...clip(body, limits.maxToolChars) });
    }
    turn.blocks = withOutputs;
  }

  result.turns = turns.filter((turn) => turn.blocks.length > 0);
  return result;
}

function parseClaude(text, limits) {
  const result = emptyResult('claude');
  const turns = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      result.skipped += 1;
      continue;
    }

    result.meta.cwd = result.meta.cwd ?? record.cwd ?? null;
    result.meta.model = result.meta.model ?? record.message?.model ?? null;
    result.meta.cliVersion = result.meta.cliVersion ?? record.version ?? null;
    result.meta.startedAt = result.meta.startedAt ?? record.timestamp ?? null;
    result.meta.sessionId = result.meta.sessionId ?? record.sessionId ?? null;

    const role = record.type === 'assistant' ? 'assistant' : record.type === 'user' ? 'user' : null;
    if (!role) continue;

    const content = record.message?.content;
    const blocks = [];
    if (typeof content === 'string') {
      blocks.push({ kind: 'text', ...clip(content, limits.maxBlockChars) });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') {
          blocks.push({ kind: 'text', ...clip(block.text, limits.maxBlockChars) });
        } else if (block?.type === 'thinking') {
          blocks.push({ kind: 'reasoning', ...clip(block.thinking, limits.maxBlockChars) });
        } else if (block?.type === 'tool_use') {
          result.toolCalls += 1;
          blocks.push({
            kind: 'tool',
            name: block.name,
            ...clip(JSON.stringify(block.input ?? {}), limits.maxToolChars),
          });
        } else if (block?.type === 'tool_result') {
          blocks.push({ kind: 'output', ...clip(messageText(block.content), limits.maxToolChars) });
        }
      }
    }

    if (blocks.length > 0) turns.push({ role, blocks });
  }

  const usageOf = (record) => record.message?.usage;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  for (const line of text.split('\n')) {
    try {
      const parsed = JSON.parse(line);
      const usageRecord = usageOf(parsed);
      if (!usageRecord) continue;
      usage = {
        input_tokens: Math.max(usage.input_tokens, usageRecord.input_tokens ?? 0),
        output_tokens: Math.max(usage.output_tokens, usageRecord.output_tokens ?? 0),
        cache_read_input_tokens: Math.max(
          usage.cache_read_input_tokens,
          usageRecord.cache_read_input_tokens ?? 0,
        ),
      };
    } catch {
      /* already counted above */
    }
  }
  result.usage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cache_read_input_tokens,
  };

  result.turns = turns;
  return result;
}

function parseText(text, limits) {
  const result = emptyResult('text');
  result.turns = [{ role: 'transcript', blocks: [{ kind: 'text', ...clip(text, limits.maxBlockChars) }] }];
  return result;
}
