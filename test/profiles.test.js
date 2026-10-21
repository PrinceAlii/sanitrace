import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse, render, sanitize } from '../src/index.js';
import { VERSION } from '../src/render.js';

const codex = readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8');

// The renderer emits LF on every platform. Git may check out fixtures with
// CRLF on Windows, so normalize the expected snapshots before comparison.
function readSnapshot(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');
}

const snapshots = {
  bug: readSnapshot('report-bug.md'),
  security: readSnapshot('report-security.md'),
  review: readSnapshot('report-review.md'),
};

const expectations = {
  security: {
    title: 'Agent session security report',
    sections: [
      ['Summary', 'Describe what went wrong and the security impact.'],
      ['Impact', 'Describe what an attacker could reach and what data is exposed.'],
      ['Affected versions', 'List the versions or commits that contain the problem.'],
      ['Reproduction', 'List the commands or steps that trigger the problem.'],
      ['Expected behavior', 'Describe what the software should do instead.'],
    ],
  },
  review: {
    title: 'Agent session review',
    sections: [
      ['Summary', 'Describe the change and why it is needed.'],
      ['Changes', 'List the files and behavior that changed.'],
      ['Verification', 'Describe what you ran to check the change.'],
      ['Risks', 'Describe what could break and what remains untested.'],
    ],
  },
};

function headings(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3));
}

test('bug profile keeps the 0.1.1 report layout', () => {
  const expected = snapshots.bug.replaceAll('{{VERSION}}', VERSION);
  assert.equal(sanitize(codex).markdown, expected);
  assert.equal(sanitize(codex, { profile: 'bug' }).markdown, expected);
  assert.ok(!expected.includes('| Profile |'));
});

for (const [profile, expected] of Object.entries(expectations)) {
  test(`${profile} profile uses the documented sections and prompts`, () => {
    const { markdown } = sanitize(codex, { profile });
    assert.equal(markdown, snapshots[profile].replaceAll('{{VERSION}}', VERSION));
    assert.match(markdown, new RegExp(`^# ${expected.title}$`, 'm'));
    assert.deepEqual(headings(markdown), [
      'Metadata',
      'Redactions',
      ...expected.sections.map(([heading]) => heading),
      'Transcript',
    ]);

    for (const [heading, prompt] of expected.sections) {
      assert.ok(
        markdown.includes(`## ${heading}\n\n<!-- ${prompt} -->`),
        `missing prompt for ${heading}`,
      );
    }

    assert.ok(
      markdown.includes(`| Format | \`codex\` |\n| Profile | \`${profile}\` |\n| Model |`),
      'profile row is not after Format',
    );
  });
}

test('every profile keeps the redaction table', () => {
  for (const profile of ['bug', 'security', 'review']) {
    const { markdown } = sanitize(codex, { profile });
    assert.match(markdown, /## Redactions/);
    assert.match(markdown, /\| Placeholder \| Count \|/);
    assert.match(markdown, /\| `\[PRIVATE_KEY_\*\]` \| 1 \|/);

    const clean = sanitize('plain note without credentials', { profile }).markdown;
    assert.match(clean, /No redactions were needed\./);
  }
});

test('render emits the redactions marker when the summary is disabled', () => {
  const draft = render(parse(codex), { profile: 'review', summary: false });
  assert.ok(draft.includes('<!-- sanitrace:redactions -->'));
  assert.ok(!draft.includes('## Redactions'));

  const { markdown } = sanitize(codex, { profile: 'review' });
  assert.ok(!markdown.includes('<!-- sanitrace:redactions -->'));
  assert.ok(markdown.indexOf('## Redactions') < markdown.indexOf('## Summary'));
});

test('profile headings survive the transcript budget', () => {
  const { markdown } = sanitize(codex, { profile: 'security', maxTotal: 900 });
  assert.ok(markdown.length < 2400, `report was ${markdown.length} chars`);
  assert.match(markdown, /chars cut|elided/);
  assert.deepEqual(headings(markdown), [
    'Metadata',
    'Redactions',
    'Summary',
    'Impact',
    'Affected versions',
    'Reproduction',
    'Expected behavior',
    'Transcript',
  ]);
  assert.equal((markdown.match(/^```/gm) ?? []).length % 2, 0, 'unclosed code fence');
});
