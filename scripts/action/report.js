// Pure helpers for the composite action. Runner state is read in run.js.

export const MARKER = '<!-- sanitrace-report -->';
export const COMMENT_LIMIT = 60_000;

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const TRUNCATION_NOTE = '_Report truncated. The artifact contains the full report._';

export function isTrue(value) {
  return typeof value === 'string' ? value.toLowerCase() === 'true' : value === true;
}

export function isValidVersion(value) {
  return typeof value === 'string' && !value.includes('\n') && VERSION_PATTERN.test(value);
}

export function resolveVersion(input, packageVersion) {
  if (!isValidVersion(packageVersion)) {
    throw new Error(`package.json has an invalid version: ${JSON.stringify(packageVersion)}`);
  }

  if (!input) return { version: packageVersion, local: false };
  if (input === 'local') return { version: packageVersion, local: true };

  if (!isValidVersion(input)) {
    throw new Error(
      `version must match ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$; received ${JSON.stringify(input)}`,
    );
  }

  return { version: input, local: false };
}

export function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { redactions: 0, residual: 0, result: 'error' };
  }

  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const residual = Array.isArray(payload.residual) ? payload.residual : [];
  const redactions = findings.reduce((total, finding) => {
    const count = finding?.count;
    return total + (Number.isInteger(count) && count > 0 ? count : 0);
  }, 0);

  let result = 'clean';
  if (residual.length > 0) result = 'residual';
  else if (redactions > 0) result = 'redacted';

  return { redactions, residual: residual.length, result };
}

export function extractMarkdown(payload) {
  if (!payload || typeof payload.markdown !== 'string' || payload.markdown.length === 0) {
    return null;
  }
  return payload.markdown;
}

export function shouldComment(exitCode, failOnRedaction) {
  const code = Number(exitCode);
  if (code === 0) return true;
  return code === 1 && !isTrue(failOnRedaction);
}

export function parseIssueNumber(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) return null;

  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function issueNumberFromEvent(event) {
  if (!event || typeof event !== 'object') return null;

  for (const value of [event.issue?.number, event.pull_request?.number, event.number]) {
    const number = parseIssueNumber(value);
    if (number !== null) return number;
  }

  return null;
}

export function closeOpenFences(text) {
  let open = null;

  for (const line of text.split('\n')) {
    const match = FENCE_PATTERN.exec(line);
    if (!match) continue;

    const marker = match[1];
    if (open === null) {
      open = { char: marker[0], length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length) {
      open = null;
    }
  }

  if (open === null) return text;

  const separator = text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${open.char.repeat(open.length)}`;
}

function trimToLine(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;

  const candidate = text.slice(0, limit);
  const newline = candidate.lastIndexOf('\n');
  return newline === -1 ? candidate : candidate.slice(0, newline + 1);
}

export function buildCommentBody({
  redactions,
  residual,
  markdown,
  runUrl,
  limit = COMMENT_LIMIT,
}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');

  const header = `sanitrace: ${redactions} redactions, ${residual} residuals.\n${MARKER}\n\n`;
  const footer = `\n\nWorkflow run: ${runUrl}\n`;
  const full = `${header}${markdown}${footer}`;
  if (full.length <= limit) return full;

  let available = limit - header.length - footer.length - TRUNCATION_NOTE.length - 8;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cut = trimToLine(markdown, Math.max(0, available));
    const closed = closeOpenFences(cut);
    const separator = closed.endsWith('\n') ? '\n' : '\n\n';
    const body = `${header}${closed}${separator}${TRUNCATION_NOTE}${footer}`;
    if (body.length <= limit) return body;
    available -= body.length - limit;
  }

  return `${header}${TRUNCATION_NOTE}${footer}`;
}

export function buildCommentPayload(body) {
  return `${JSON.stringify({ body })}\n`;
}
