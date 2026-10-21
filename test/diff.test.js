import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { diffReports, formatDiffMarkdown, parseReport } from '../src/diff.js';
import { parse, render, sanitize } from '../src/index.js';
import { stampTurnIds, turnId } from '../src/render.js';

const codex = readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8');

// Builds a report with placeholder markers. Callers stamp it to add identifiers.
function reportOf(...turns) {
  const lines = ['# Agent session report', '', '## Transcript', ''];
  let index = 0;
  for (const [role, text] of turns) {
    index += 1;
    lines.push(`<!-- sanitrace:turn:${index} -->`, `### ${index}. ${role}`, '', text, '');
  }
  lines.push('<!-- sanitrace:turn:end -->', '');
  return `${lines.join('\n')}\n`;
}

function stamped(...turns) {
  return stampTurnIds(reportOf(...turns));
}

test('stampTurnIds adds an identifier to every marker and leaves the end marker', () => {
  const markdown = stamped(['user', 'First body.'], ['assistant', 'Second body.']);
  const markers = markdown.match(/<!-- sanitrace:turn:[^>]* -->/g);
  assert.deepEqual(markers, [
    `<!-- sanitrace:turn:1:${turnId('user', 'First body.')} -->`,
    `<!-- sanitrace:turn:2:${turnId('assistant', 'Second body.')} -->`,
    '<!-- sanitrace:turn:end -->',
  ]);
  assert.ok(!markdown.includes('<!-- sanitrace:turn:1 -->'));
});

test('the identifier is stable across LF and CRLF input', () => {
  const lf = stamped(['user', 'Line one.\nLine two.']);
  const crlf = stampTurnIds(reportOf(['user', 'Line one.\nLine two.']).replaceAll('\n', '\r\n'));
  assert.equal(crlf, lf);
  assert.deepEqual(parseReport(crlf, 'a.md').turns, parseReport(lf, 'b.md').turns);
});

test('the identifier changes when the role or body changes', () => {
  const base = turnId('user', 'Same body.');
  assert.notEqual(turnId('assistant', 'Same body.'), base);
  assert.notEqual(turnId('user', 'Different body.'), base);
});

test('the identifier ignores trailing whitespace and edge blank lines', () => {
  const base = turnId('user', 'Body text.');
  assert.equal(turnId('user', 'Body text.   '), base);
  assert.equal(turnId('user', '\n\nBody text.\n\n'), base);
  assert.notEqual(turnId('user', 'Body  text.'), base);
});

test('parseReport returns the role, index, body, and identifier', () => {
  const parsed = parseReport(stamped(['user', 'Ask.'], ['assistant', 'Answer.']), 'a.md');
  assert.equal(parsed.path, 'a.md');
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(parsed.turns.map((turn) => turn.index), [1, 2]);
  assert.deepEqual(parsed.turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.deepEqual(parsed.turns.map((turn) => turn.text), ['Ask.', 'Answer.']);
  assert.deepEqual(parsed.turns.map((turn) => turn.id), [
    turnId('user', 'Ask.'),
    turnId('assistant', 'Answer.'),
  ]);
});

test('parseReport ignores text before the first marker and after the end marker', () => {
  const text = stamped(['user', 'Ask.']);
  const decorated = `preamble that is not a turn\n\n${text}\ntrailing footer\n`;
  const parsed = parseReport(decorated, 'a.md');
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].text, 'Ask.');
});

test('parseReport rejects a report without markers', () => {
  assert.throws(
    () => parseReport('# Agent session report\n\n### 1. user\n\nAsk.\n', 'old.md'),
    /old\.md has no turn markers.*0\.4\.0/s,
  );
});

test('parseReport rejects a marker without a heading', () => {
  const text = '<!-- sanitrace:turn:1 -->\n\nAsk.\n<!-- sanitrace:turn:end -->\n';
  assert.throws(
    () => parseReport(text, 'broken.md'),
    /broken\.md: turn marker <!-- sanitrace:turn:1 --> is not followed by a "### <n>\. <role>" heading/,
  );
});

test('parseReport rejects a malformed heading', () => {
  const text = '<!-- sanitrace:turn:1 -->\n### user\n\nAsk.\n<!-- sanitrace:turn:end -->\n';
  assert.throws(() => parseReport(text, 'broken.md'), /broken\.md: malformed turn heading: ### user/);
});

test('parseReport rejects a report without the end marker', () => {
  const text = '<!-- sanitrace:turn:1 -->\n### 1. user\n\nAsk.\n';
  assert.throws(
    () => parseReport(text, 'truncated.md'),
    /truncated\.md is missing <!-- sanitrace:turn:end -->.*0\.4\.0/s,
  );
});

test('diffReports reports identical turns as unchanged', () => {
  const a = parseReport(stamped(['user', 'Ask.'], ['assistant', 'Answer.']), 'a.md');
  const b = parseReport(stamped(['user', 'Ask.'], ['assistant', 'Answer.']), 'b.md');
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 2, changed: 0, added: 0, removed: 0 });
  assert.deepEqual(result.turns.map((turn) => turn.status), ['unchanged', 'unchanged']);
  assert.equal(result.turns[0].a.id, result.turns[0].b.id);
  assert.equal(Object.hasOwn(result.turns[0], 'diff'), false);
});

test('a changed turn returns changed and a line diff', () => {
  const a = parseReport(stamped(['assistant', 'common line\nold line\ncommon line']), 'a.md');
  const b = parseReport(stamped(['assistant', 'common line\nnew line\ncommon line']), 'b.md');
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 0, changed: 1, added: 0, removed: 0 });
  const [turn] = result.turns;
  assert.equal(turn.status, 'changed');
  assert.deepEqual(turn.diff, [
    { type: 'context', text: 'common line' },
    { type: 'removed', text: 'old line' },
    { type: 'added', text: 'new line' },
    { type: 'context', text: 'common line' },
  ]);
});

test('an inserted turn returns added at the correct position', () => {
  const a = parseReport(stamped(['user', 'Ask.'], ['assistant', 'Answer.']), 'a.md');
  const b = parseReport(
    stamped(['user', 'Ask.'], ['assistant', 'Inserted.'], ['assistant', 'Answer.']),
    'b.md',
  );
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 2, changed: 0, added: 1, removed: 0 });
  assert.deepEqual(result.turns.map((turn) => turn.status), [
    'unchanged',
    'added',
    'unchanged',
  ]);
  assert.equal(result.turns[1].b.text, 'Inserted.');
  assert.equal(Object.hasOwn(result.turns[1], 'a'), false);
});

test('a removed turn returns removed at the correct position', () => {
  const a = parseReport(
    stamped(['user', 'Ask.'], ['assistant', 'Removed.'], ['assistant', 'Answer.']),
    'a.md',
  );
  const b = parseReport(stamped(['user', 'Ask.'], ['assistant', 'Answer.']), 'b.md');
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 2, changed: 0, added: 0, removed: 1 });
  assert.deepEqual(result.turns.map((turn) => turn.status), [
    'unchanged',
    'removed',
    'unchanged',
  ]);
  assert.equal(result.turns[1].a.text, 'Removed.');
  assert.equal(Object.hasOwn(result.turns[1], 'b'), false);
});

test('a replaced turn with a different role returns removed and added', () => {
  const a = parseReport(stamped(['assistant', 'Same text.']), 'a.md');
  const b = parseReport(stamped(['user', 'Same text.']), 'b.md');
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 0, changed: 0, added: 1, removed: 1 });
  assert.deepEqual(result.turns.map((turn) => turn.status), ['removed', 'added']);
  assert.equal(result.turns[0].a.role, 'assistant');
  assert.equal(result.turns[1].b.role, 'user');
});

test('reordered turns produce a stable result', () => {
  const a = parseReport(stamped(['user', 'One.'], ['assistant', 'Two.']), 'a.md');
  const b = parseReport(stamped(['assistant', 'Two.'], ['user', 'One.']), 'b.md');
  const first = diffReports(a, b);
  const second = diffReports(a, b);
  assert.deepEqual(first, second);
  // The longest common subsequence keeps one turn in place; the other is
  // reported as removed from A and added at its new position in B.
  assert.deepEqual(first.summary, { unchanged: 1, changed: 0, added: 1, removed: 1 });
  assert.deepEqual(first.turns.map((turn) => turn.status), [
    'removed',
    'unchanged',
    'added',
  ]);
  assert.equal(first.turns[0].a.text, 'One.');
  assert.equal(first.turns[1].a.text, 'Two.');
  assert.equal(first.turns[2].b.text, 'One.');
});

test('zero-turn reports return an empty turn list', () => {
  const empty = stampTurnIds('# Agent session report\n\n## Transcript\n\n<!-- sanitrace:turn:end -->\n');
  const a = parseReport(empty, 'a.md');
  const b = parseReport(empty, 'b.md');
  const result = diffReports(a, b);
  assert.deepEqual(result.summary, { unchanged: 0, changed: 0, added: 0, removed: 0 });
  assert.deepEqual(result.turns, []);
  const markdown = formatDiffMarkdown(result);
  assert.match(markdown, /No transcript differences\./);
  assert.match(markdown, /\| Unchanged \| 0 \|/);
});

test('formatDiffMarkdown emits the documented tables and sections', () => {
  const a = parseReport(stamped(['assistant', 'common\nold'], ['user', 'Kept.']), 'old.md');
  const b = parseReport(stamped(['assistant', 'common\nnew'], ['user', 'Kept.']), 'new.md');
  const markdown = formatDiffMarkdown(diffReports(a, b));
  assert.match(markdown, /^# Report diff$/m);
  assert.match(markdown, /\| `old\.md` \| 2 \|/);
  assert.match(markdown, /\| `new\.md` \| 2 \|/);
  assert.match(markdown, /\| Unchanged \| 1 \|/);
  assert.match(markdown, /\| Changed \| 1 \|/);
  assert.match(markdown, /^## Changed turn 1$/m);
  assert.match(markdown, /^-old$/m);
  assert.match(markdown, /^\+new$/m);
});

test('formatDiffMarkdown grows the fence past the longest run in the body', () => {
  const a = parseReport(stamped(['assistant', '~~~']), 'a.md');
  const b = parseReport(stamped(['assistant', '~~~~']), 'b.md');
  const markdown = formatDiffMarkdown(diffReports(a, b));
  // The longest run in the diff body is four tildes, so the fence uses five.
  assert.match(markdown, /~~~~~diff/);
  assert.match(markdown, /\n~~~~~\n/);
});

test('formatDiffMarkdown prints the full body for added and removed turns', () => {
  const a = parseReport(stamped(['user', 'Kept.']), 'a.md');
  const b = parseReport(stamped(['user', 'Kept.'], ['assistant', 'Fresh body.']), 'b.md');
  const markdown = formatDiffMarkdown(diffReports(a, b));
  assert.match(markdown, /^## Added turn 2$/m);
  assert.match(markdown, /Fresh body\./);
  assert.match(markdown, /^~~~markdown$/m);
});

test('the JSON result matches the documented shape', () => {
  const a = parseReport(stamped(['assistant', 'old body']), 'old.md');
  const b = parseReport(stamped(['assistant', 'new body']), 'new.md');
  const result = diffReports(a, b);
  const json = JSON.parse(JSON.stringify(result));
  assert.deepEqual(Object.keys(json), ['a', 'b', 'summary', 'turns']);
  assert.deepEqual(json.a, { path: 'old.md', turns: 1 });
  assert.deepEqual(json.b, { path: 'new.md', turns: 1 });
  assert.deepEqual(json.summary, { unchanged: 0, changed: 1, added: 0, removed: 0 });
  const [turn] = json.turns;
  assert.deepEqual(Object.keys(turn), ['status', 'a', 'b', 'diff']);
  assert.deepEqual(Object.keys(turn.a).sort(), ['id', 'index', 'role', 'text']);
  assert.equal(turn.a.id, turnId('assistant', 'old body'));
  assert.equal(turn.b.id, turnId('assistant', 'new body'));
});

test('sanitize stamps a marker for every kept turn and one end marker', () => {
  const { markdown, parsed } = sanitize(codex);
  const markers = markdown.match(/<!-- sanitrace:turn:[^>]* -->/g) ?? [];
  const turnMarkers = markers.filter((marker) => marker !== '<!-- sanitrace:turn:end -->');
  assert.equal(turnMarkers.length, parsed.turns.length);
  assert.equal(markers.length, parsed.turns.length + 1);
  for (const marker of turnMarkers) {
    assert.match(marker, /^<!-- sanitrace:turn:\d+:[0-9a-f]{12} -->$/);
  }
});

test('the stamped identifier matches stampTurnIds over the report body', () => {
  const { markdown } = sanitize(codex);
  const stampedAgain = stampTurnIds(markdown);
  assert.equal(stampedAgain, markdown);

  const parsed = parseReport(markdown, 'report.md');
  for (const turn of parsed.turns) {
    assert.equal(turn.id, turnId(turn.role, turn.text));
  }
});

test('render leaves placeholder markers while sanitize stamps them', () => {
  const draft = render(parse(codex), { summary: false });
  assert.match(draft, /<!-- sanitrace:turn:1 -->/);
  assert.match(draft, /<!-- sanitrace:turn:end -->/);
  assert.ok(!draft.match(/<!-- sanitrace:turn:\d+:[0-9a-f]{12} -->/));
});

test('the end marker survives the transcript budget', () => {
  const { markdown } = sanitize(codex, { maxTotal: 900 });
  assert.match(markdown, /<!-- sanitrace:turn:end -->/);
  const parsed = parseReport(markdown, 'budget.md');
  assert.ok(parsed.turns.length > 0);
});

test('zero-turn input still emits the end marker', () => {
  const { markdown } = sanitize('plain text with no .jsonl wrapper', { format: 'text' });
  assert.match(markdown, /<!-- sanitrace:turn:end -->/);
  const parsed = parseReport(markdown, 'text.md');
  assert.deepEqual(parsed.turns.map((turn) => turn.text), ['plain text with no .jsonl wrapper']);
});

