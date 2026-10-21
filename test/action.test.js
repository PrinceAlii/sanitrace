import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMENT_LIMIT,
  MARKER,
  buildCommentBody,
  buildCommentPayload,
  closeOpenFences,
  extractMarkdown,
  isTrue,
  issueNumberFromEvent,
  parseIssueNumber,
  resolveVersion,
  shouldComment,
  summarizePayload,
} from '../scripts/action/report.js';

test('summarizes redactions from the findings counts', () => {
  const summary = summarizePayload({
    findings: [
      { rule: 'openai-key', count: 3 },
      { rule: 'email', count: 2 },
    ],
    residual: [],
  });

  assert.deepEqual(summary, { redactions: 5, residual: 0, result: 'redacted' });
});

test('maps counts to clean, residual, and error results', () => {
  assert.deepEqual(summarizePayload({ findings: [], residual: [] }), {
    redactions: 0,
    residual: 0,
    result: 'clean',
  });
  assert.deepEqual(summarizePayload({ findings: [{ count: 1 }], residual: [{ rule: 'x' }] }), {
    redactions: 1,
    residual: 1,
    result: 'residual',
  });
  assert.deepEqual(summarizePayload(null), { redactions: 0, residual: 0, result: 'error' });
});

test('parses the boolean action inputs', () => {
  assert.equal(isTrue('true'), true);
  assert.equal(isTrue('TRUE'), true);
  assert.equal(isTrue('false'), false);
  assert.equal(isTrue(''), false);
});

test('comments only for exit 0 or an allowed exit 1', () => {
  assert.equal(shouldComment(0, 'false'), true);
  assert.equal(shouldComment(0, 'true'), true);
  assert.equal(shouldComment(1, 'false'), true);
  assert.equal(shouldComment(1, 'true'), false);
  assert.equal(shouldComment('1', 'false'), true);
  assert.equal(shouldComment(2, 'false'), false);
  assert.equal(shouldComment(3, 'false'), false);
});

test('resolves the packaged version and the local test value', () => {
  assert.deepEqual(resolveVersion('', '0.3.0'), { version: '0.3.0', local: false });
  assert.deepEqual(resolveVersion('local', '0.3.0'), { version: '0.3.0', local: true });
  assert.deepEqual(resolveVersion('1.2.3-beta.1', '0.3.0'), {
    version: '1.2.3-beta.1',
    local: false,
  });
});

test('rejects versions that are not exact semver', () => {
  for (const value of ['latest', 'main', 'v0.3.0', '0.3', '0.3.0+build', ' 0.3.0', '0.3.0\n']) {
    assert.throws(() => resolveVersion(value, '0.3.0'), /version must match/);
  }
});

test('extracts markdown from a payload', () => {
  assert.equal(extractMarkdown({ markdown: '# Report' }), '# Report');
  assert.equal(extractMarkdown({ markdown: '' }), null);
  assert.equal(extractMarkdown({ markdown: 3 }), null);
  assert.equal(extractMarkdown({}), null);
  assert.equal(extractMarkdown(null), null);
});

test('closes an open code fence', () => {
  assert.equal(closeOpenFences('```js\ncode'), '```js\ncode\n```');
  assert.equal(closeOpenFences('```js\ncode\n```'), '```js\ncode\n```');
  assert.equal(closeOpenFences('~~~\ncode'), '~~~\ncode\n~~~');
});

test('truncates a long comment at a line boundary and closes the fence', () => {
  const lines = ['# Report', '', '```text'];
  for (let index = 0; index < 7000; index += 1) {
    lines.push(`line ${index} has enough text to reach the comment limit`);
  }
  lines.push('```');

  const runUrl = 'https://github.com/PrinceAlii/sanitrace/actions/runs/1';
  const body = buildCommentBody({
    redactions: 12,
    residual: 0,
    markdown: lines.join('\n'),
    runUrl,
  });
  const header = `sanitrace: 12 redactions, 0 residuals.\n${MARKER}\n\n`;
  const noteIndex = body.indexOf('_Report truncated.');
  const content = body.slice(header.length, noteIndex).trimEnd();

  assert.ok(body.length <= COMMENT_LIMIT);
  assert.ok(body.startsWith(header));
  assert.ok(body.endsWith(`Workflow run: ${runUrl}\n`));
  assert.ok(body.includes('_Report truncated. The artifact contains the full report._'));
  assert.ok(content.endsWith('```'));
  assert.match(content.split('\n').at(-2), /^line [0-9]+ has enough text/);
  assert.equal((content.match(/^```/gm) ?? []).length % 2, 0);
});

test('does not truncate a short comment', () => {
  const runUrl = 'https://github.com/PrinceAlii/sanitrace/actions/runs/2';
  const body = buildCommentBody({
    redactions: 0,
    residual: 0,
    markdown: '# Report\n\nNo redactions.',
    runUrl,
  });

  assert.equal(
    body,
    `sanitrace: 0 redactions, 0 residuals.\n${MARKER}\n\n# Report\n\nNo redactions.\n\nWorkflow run: ${runUrl}\n`,
  );
});

test('wraps the comment body in a JSON payload', () => {
  const body = buildCommentBody({
    redactions: 1,
    residual: 0,
    markdown: '# Report',
    runUrl: 'https://github.com/PrinceAlii/sanitrace/actions/runs/3',
  });
  const payload = JSON.parse(buildCommentPayload(body));

  assert.deepEqual(payload, { body });
  assert.ok(buildCommentPayload(body).endsWith('\n'));
});

test('resolves an issue number from the input and the event payload', () => {
  assert.equal(parseIssueNumber('42'), 42);
  assert.equal(parseIssueNumber(' 42 '), 42);
  assert.equal(parseIssueNumber('0'), null);
  assert.equal(parseIssueNumber('42x'), null);

  assert.equal(issueNumberFromEvent({ issue: { number: 7 } }), 7);
  assert.equal(issueNumberFromEvent({ pull_request: { number: 8 } }), 8);
  assert.equal(issueNumberFromEvent({ number: 9 }), 9);
  assert.equal(issueNumberFromEvent({}), null);
});
