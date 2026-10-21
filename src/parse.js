// Session-log parsers.
//
// Parsers are lenient: session formats are internal to each agent and change
// between releases. Unknown records are counted and skipped instead of raising,
// because a report that drops one record is better than no report.

const MAX_BLOCK_CHARS = 6000;
const MAX_TOOL_CHARS = 2000;

/** @typedef {'codex'|'claude'|'opencode'|'gemini'|'text'} Format */
/** @typedef {{kind: 'text'|'tool'|'output'|'reasoning', role?: string, name?: string, callId?: string, text: string, originalChars: number}} Block */
/** @typedef {{role: string, blocks: Block[]}} Turn */

const GEMINI_ASSISTANT_TYPES = new Set(['gemini', 'assistant', 'ai', 'model']);
const SHELL_TOOL_NAMES = new Set(['bash', 'exec', 'exec_command', 'run_command', 'run_shell_command', 'shell']);

/**
 * @param {string} text
 * @returns {Format}
 */
export function detectFormat(text) {
  const head = text.slice(0, 20000);
  if (/"type"\s*:\s*"session_meta"/.test(head) || /"model_provider"\s*:/.test(head)) {
    return 'codex';
  }
  if (/"sessionId"\s*:/.test(head) && /"message"\s*:\s*\{/.test(head)) return 'claude';
  if (isOpenCodeExport(text)) return 'opencode';
  if (isGeminiTranscript(text)) return 'gemini';
  return 'text';
}

// OpenCode detection requires the export envelope plus a typed message or part.
// One key is not enough, so unrelated JSON stays text.
function isOpenCodeExport(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;

  let document;
  try {
    document = JSON.parse(trimmed);
  } catch {
    return false;
  }

  if (!isRecord(document) || !isRecord(document.info) || !Array.isArray(document.messages)) {
    return false;
  }

  return document.messages.some((message) => {
    if (!isRecord(message)) return false;
    if (typeof message.type === 'string') return true;
    return (
      Array.isArray(message.content) &&
      message.content.some((part) => isRecord(part) && typeof part.type === 'string')
    );
  });
}

// Gemini detection requires the session header plus a known event or tool call.
function isGeminiTranscript(text) {
  let hasHeader = false;
  let hasEvent = false;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;

    if (typeof record.sessionId === 'string' && typeof record.projectHash === 'string') {
      hasHeader = true;
    }
    if (geminiRole(record.type) || Array.isArray(record.toolCalls)) {
      hasEvent = true;
    }
    if (hasHeader && hasEvent) return true;
  }

  return false;
}

/**
 * @param {string} text
 * @param {{format?: Format|'auto', maxBlockChars?: number, maxToolChars?: number}} [options]
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
  if (format === 'opencode') return parseOpenCode(text, limits);
  if (format === 'gemini') return parseGemini(text, limits);
  return parseText(text, limits);
}

function emptyResult(format) {
  return {
    format,
    meta: {
      cwd: null,
      model: null,
      cliVersion: null,
      startedAt: null,
      endedAt: null,
      source: null,
      sessionId: null,
    },
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIso(current, candidate) {
  const next = toIsoTimestamp(candidate);
  if (!next) return current;
  if (!current) return next;
  return Date.parse(next) >= Date.parse(current) ? next : current;
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function openCodeToolInput(name, input) {
  if (typeof input === 'string') return input;
  if (input === undefined || input === null) return '';
  if (
    isRecord(input) &&
    typeof input.command === 'string' &&
    SHELL_TOOL_NAMES.has(String(name).toLowerCase())
  ) {
    return input.command;
  }
  return JSON.stringify(input);
}

function geminiRole(type) {
  if (typeof type !== 'string') return null;
  const role = type.toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  if (GEMINI_ASSISTANT_TYPES.has(role)) return 'assistant';
  if (role === 'tool' || role === 'function' || role === 'tool_result') return 'tool';
  if (role === 'developer' || role === 'system') return role;
  return null;
}

function openCodeRole(type) {
  if (typeof type !== 'string') return null;
  const role = type.toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'ai' || role === 'model') return 'assistant';
  if (role === 'tool' || role === 'function' || role === 'tool_result') return 'tool';
  if (role === 'developer' || role === 'system') return role;
  return null;
}

function geminiContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part) || typeof part.text !== 'string') return '';
      if (
        part.type !== undefined &&
        part.type !== 'text' &&
        part.type !== 'input_text' &&
        part.type !== 'output_text'
      ) {
        return '';
      }
      return part.text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function geminiToolInput(name, args) {
  if (typeof args === 'string') return args;
  if (
    isRecord(args) &&
    typeof args.command === 'string' &&
    SHELL_TOOL_NAMES.has(String(name).toLowerCase())
  ) {
    return args.command;
  }
  return JSON.stringify(args ?? {});
}

function geminiToolOutput(call) {
  if (!Array.isArray(call.result)) return '';
  return call.result
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!isRecord(entry)) return '';
      const response = entry.functionResponse?.response;
      if (typeof response?.output === 'string') return response.output;
      if (typeof entry.output === 'string') return entry.output;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
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

function parseOpenCode(text, limits) {
  const result = emptyResult('opencode');
  if (!text.trim()) return result;

  let document;
  try {
    document = JSON.parse(text.trim());
  } catch {
    result.skipped = 1;
    return result;
  }

  if (!isRecord(document) || !isRecord(document.info) || !Array.isArray(document.messages)) {
    result.skipped = 1;
    return result;
  }

  const info = document.info;
  const time = isRecord(info.time) ? info.time : {};
  const tokens = isRecord(info.tokens) ? info.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};

  result.meta.cwd = stringOrNull(info.location?.directory);
  result.meta.model = stringOrNull(info.model?.id);
  result.meta.sessionId = stringOrNull(info.id);
  result.meta.startedAt = toIsoTimestamp(time.created);
  result.meta.endedAt = toIsoTimestamp(time.updated);
  result.meta.source = 'OpenCode';
  result.meta.cliVersion = stringOrNull(info.version ?? info.cliVersion ?? document.version);
  result.usage = {
    inputTokens: numberOrZero(tokens.input),
    outputTokens: numberOrZero(tokens.output),
    cachedTokens: numberOrZero(cache.read),
  };

  for (const message of document.messages) {
    if (!isRecord(message)) {
      result.skipped += 1;
      continue;
    }

    const role = openCodeRole(message.type);
    if (!role) {
      result.skipped += 1;
      continue;
    }

    if (role === 'tool') {
      const body = messageText(message.text) || messageText(message.content);
      if (!body.trim()) continue;
      result.turns.push({
        role,
        blocks: [{ kind: 'output', ...clip(body, limits.maxToolChars) }],
      });
      continue;
    }

    if (role === 'user' || role === 'system' || role === 'developer') {
      const body = messageText(message.text) || messageText(message.content);
      if (!body.trim()) continue;
      result.turns.push({
        role,
        blocks: [{ kind: 'text', ...clip(body, limits.maxBlockChars) }],
      });
      continue;
    }

    const blocks = [];
    const parts = Array.isArray(message.content) ? message.content : [];

    for (const part of parts) {
      if (!isRecord(part)) continue;

      if (part.type === 'text') {
        const body = messageText(part.text);
        if (body.trim()) blocks.push({ kind: 'text', ...clip(body, limits.maxBlockChars) });
      } else if (part.type === 'reasoning') {
        const body = messageText(part.text);
        if (body.trim()) blocks.push({ kind: 'reasoning', ...clip(body, limits.maxBlockChars) });
      } else if (part.type === 'tool') {
        result.toolCalls += 1;
        blocks.push({
          kind: 'tool',
          name: typeof part.name === 'string' ? part.name : 'tool',
          callId: part.id,
          ...clip(openCodeToolInput(part.name, part.state?.input), limits.maxToolChars),
        });

        const output =
          messageText(part.state?.content) ||
          (typeof part.state?.error === 'string' ? part.state.error : '');
        if (output.trim()) {
          blocks.push({ kind: 'output', ...clip(output, limits.maxToolChars) });
        }
      }
    }

    if (blocks.length > 0) result.turns.push({ role: 'assistant', blocks });
  }

  return result;
}

function parseGemini(text, limits) {
  const result = emptyResult('gemini');
  result.meta.source = 'Gemini CLI';

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      result.skipped += 1;
      continue;
    }

    if (!isRecord(record)) {
      result.skipped += 1;
      continue;
    }

    // Patch records update client metadata and carry no transcript content.
    if (Object.hasOwn(record, '$set')) continue;

    if (!record.type && typeof record.sessionId === 'string') {
      result.meta.sessionId = record.sessionId;
      result.meta.cwd =
        Array.isArray(record.directories) && typeof record.directories[0] === 'string'
          ? record.directories[0]
          : result.meta.cwd;
      result.meta.startedAt = toIsoTimestamp(record.startTime) ?? result.meta.startedAt;
      result.meta.endedAt =
        toIsoTimestamp(record.lastUpdated) ?? result.meta.endedAt;
      result.meta.cliVersion =
        stringOrNull(record.version ?? record.cliVersion) ?? result.meta.cliVersion;
      continue;
    }

    const role = geminiRole(record.type);
    if (!role) {
      result.skipped += 1;
      continue;
    }

    if (!result.meta.startedAt) result.meta.startedAt = toIsoTimestamp(record.timestamp);
    result.meta.endedAt = latestIso(result.meta.endedAt, record.timestamp);
    if (typeof record.model === 'string' && record.model) result.meta.model = record.model;

    if (isRecord(record.tokens)) {
      result.usage.inputTokens += numberOrZero(record.tokens.input);
      result.usage.outputTokens += numberOrZero(record.tokens.output);
      result.usage.cachedTokens += numberOrZero(record.tokens.cached);
    }

    const blocks = [];

    for (const thought of Array.isArray(record.thoughts) ? record.thoughts : []) {
      let body = '';
      if (typeof thought === 'string') {
        body = thought;
      } else if (isRecord(thought) && typeof thought.description === 'string') {
        body = thought.description;
      }
      if (body.trim()) blocks.push({ kind: 'reasoning', ...clip(body, limits.maxBlockChars) });
    }

    const body = geminiContentText(record.content);
    if (body.trim()) {
      const isTool = role === 'tool';
      blocks.push({
        kind: isTool ? 'output' : 'text',
        ...clip(body, isTool ? limits.maxToolChars : limits.maxBlockChars),
      });
    }

    for (const call of Array.isArray(record.toolCalls) ? record.toolCalls : []) {
      if (!isRecord(call)) continue;
      result.toolCalls += 1;
      blocks.push({
        kind: 'tool',
        name: typeof call.name === 'string' ? call.name : 'tool',
        callId: call.id,
        ...clip(geminiToolInput(call.name, call.args), limits.maxToolChars),
      });

      const output = geminiToolOutput(call);
      if (output.trim()) blocks.push({ kind: 'output', ...clip(output, limits.maxToolChars) });
    }

    if (blocks.length > 0) result.turns.push({ role, blocks });
  }

  return result;
}

function parseText(text, limits) {
  const result = emptyResult('text');
  result.turns = [{ role: 'transcript', blocks: [{ kind: 'text', ...clip(text, limits.maxBlockChars) }] }];
  return result;
}
