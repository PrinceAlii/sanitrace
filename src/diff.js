// Report diff. Reads two sanitrace reports and aligns their turns by the turn
// identifier that sanitize() stamped into each one.
//
// The command never runs the detectors. It recomputes each turn identifier from
// the report text, so a stale identifier in a hand-edited report does not stop
// the comparison.

import {
  TURN_END_MARKER,
  TURN_HEADING,
  TURN_MARKER,
  TURN_PREFIX,
  normalizeBody,
  turnId,
} from './render.js';

/**
 * Reads a sanitrace report and returns its transcript turns.
 *
 * The transcript starts at the first turn marker. Text before it and after the
 * end marker is ignored. Every marker must be followed by a `### <n>. <role>`
 * heading. Each turn identifier is recomputed from the heading role and the
 * normalized body.
 *
 * @param {string} text
 * @param {string} pathLabel file name used in error messages
 * @returns {{path: string, turns: {index: number, role: string, id: string, text: string}[]}}
 */
export function parseReport(text, pathLabel) {
  const file = String(pathLabel);
  // Normalize line endings and trailing whitespace first, so a marker or heading
  // matches even when a line ends with spaces or a carriage return.
  const rows = String(text)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  const turns = [];
  let current = null;
  let sawMarker = false;
  let sawEnd = false;

  const close = () => {
    if (current === null) return;
    if (current.role === null) {
      throw new Error(
        `${file}: turn marker ${current.marker} is not followed by a "### <n>. <role>" heading`,
      );
    }
    const body = normalizeBody(current.body.join('\n'));
    turns.push({
      index: current.index,
      role: current.role,
      id: turnId(current.role, body),
      text: body,
    });
    current = null;
  };

  for (const line of rows) {
    if (line === TURN_END_MARKER) {
      close();
      sawEnd = true;
      break;
    }

    const marker = line.match(TURN_MARKER);
    if (marker) {
      close();
      sawMarker = true;
      current = { index: Number(marker[1]), marker: line, role: null, body: [] };
      continue;
    }

    // Text before the first marker is ignored, so only a marker-shaped line
    // inside the transcript counts as malformed.
    if (current === null) continue;
    if (line.startsWith(TURN_PREFIX)) {
      throw new Error(`${file}: malformed turn marker: ${line}`);
    }

    if (current.role === null) {
      const heading = line.match(TURN_HEADING);
      if (heading) {
        current.role = heading[2];
        continue;
      }
      if (line.trim() === '') continue;
      if (line.startsWith('### ')) {
        throw new Error(`${file}: malformed turn heading: ${line}`);
      }
      throw new Error(
        `${file}: turn marker ${current.marker} is not followed by a "### <n>. <role>" heading`,
      );
    }

    current.body.push(line);
  }

  close();

  if (!sawMarker && !sawEnd) {
    throw new Error(
      `${file} has no turn markers; generate the report with sanitrace 0.4.0 or later`,
    );
  }
  if (!sawEnd) {
    throw new Error(
      `${file} is missing ${TURN_END_MARKER}; generate the report with sanitrace 0.4.0 or later`,
    );
  }

  return { path: file, turns };
}

/**
 * Aligns the turns of two reports and describes each turn as unchanged, changed,
 * added, or removed.
 *
 * Turns are aligned with a longest common subsequence over identifiers. Turns
 * outside the subsequence form gaps. Inside a gap, turns pair by position: the
 * same role becomes changed, different roles become removed and added, and an
 * unpaired turn becomes removed or added.
 *
 * @param {ReturnType<typeof parseReport>} a
 * @param {ReturnType<typeof parseReport>} b
 */
export function diffReports(a, b) {
  const aTurns = a.turns;
  const bTurns = b.turns;
  const pairs = lcsPairs(
    aTurns.map((turn) => turn.id),
    bTurns.map((turn) => turn.id),
  );
  const turns = [];

  const emitGap = (aStart, aEnd, bStart, bEnd) => {
    const gapA = aTurns.slice(aStart, aEnd);
    const gapB = bTurns.slice(bStart, bEnd);
    const count = Math.max(gapA.length, gapB.length);

    for (let position = 0; position < count; position += 1) {
      const left = gapA[position];
      const right = gapB[position];
      if (left && right) {
        if (left.role === right.role) {
          turns.push({ status: 'changed', a: left, b: right, diff: lineDiff(left.text, right.text) });
        } else {
          turns.push({ status: 'removed', a: left });
          turns.push({ status: 'added', b: right });
        }
      } else if (left) {
        turns.push({ status: 'removed', a: left });
      } else {
        turns.push({ status: 'added', b: right });
      }
    }
  };

  let aIndex = 0;
  let bIndex = 0;
  for (const [pairA, pairB] of pairs) {
    if (pairA > aIndex || pairB > bIndex) emitGap(aIndex, pairA, bIndex, pairB);
    turns.push({ status: 'unchanged', a: aTurns[pairA], b: bTurns[pairB] });
    aIndex = pairA + 1;
    bIndex = pairB + 1;
  }
  if (aIndex < aTurns.length || bIndex < bTurns.length) {
    emitGap(aIndex, aTurns.length, bIndex, bTurns.length);
  }

  const summary = { unchanged: 0, changed: 0, added: 0, removed: 0 };
  for (const turn of turns) summary[turn.status] += 1;

  return {
    a: { path: a.path, turns: aTurns.length },
    b: { path: b.path, turns: bTurns.length },
    summary,
    turns,
  };
}

/**
 * Emits the diff as Markdown.
 * @param {ReturnType<typeof diffReports>} result
 */
export function formatDiffMarkdown(result) {
  const lines = [];
  lines.push('# Report diff', '');
  lines.push('| Report | Turns |', '| --- | --- |');
  lines.push(`| ${codeSpan(result.a.path)} | ${result.a.turns} |`);
  lines.push(`| ${codeSpan(result.b.path)} | ${result.b.turns} |`, '');
  lines.push('| Result | Count |', '| --- | --- |');
  lines.push(`| Unchanged | ${result.summary.unchanged} |`);
  lines.push(`| Changed | ${result.summary.changed} |`);
  lines.push(`| Added | ${result.summary.added} |`);
  lines.push(`| Removed | ${result.summary.removed} |`, '');

  for (const turn of result.turns) {
    if (turn.status === 'unchanged') continue;
    if (turn.status === 'changed') {
      lines.push(`## Changed turn ${turn.b.index}`, '');
      lines.push(`${codeSpan(turn.a.id)} → ${codeSpan(turn.b.id)}`, '');
      lines.push(`${fenceFor(turn.diff.map((entry) => entry.text).join('\n'))}diff`);
      for (const entry of turn.diff) {
        const sign = entry.type === 'removed' ? '-' : entry.type === 'added' ? '+' : ' ';
        lines.push(`${sign}${entry.text}`);
      }
      lines.push(fenceFor(turn.diff.map((entry) => entry.text).join('\n')), '');
      continue;
    }
    if (turn.status === 'added') {
      lines.push(`## Added turn ${turn.b.index}`, '');
      lines.push(`${codeSpan(turn.b.id)} ${turn.b.role}`, '');
      lines.push(`${fenceFor(turn.b.text)}markdown`, turn.b.text, fenceFor(turn.b.text), '');
      continue;
    }
    lines.push(`## Removed turn ${turn.a.index}`, '');
    lines.push(`${codeSpan(turn.a.id)} ${turn.a.role}`, '');
    lines.push(`${fenceFor(turn.a.text)}markdown`, turn.a.text, fenceFor(turn.a.text), '');
  }

  if (result.summary.changed + result.summary.added + result.summary.removed === 0) {
    lines.push('No transcript differences.', '');
  }

  return `${lines.join('\n')}\n`;
}

// Longest common subsequence over two identifier sequences. Returns index pairs
// in increasing order. Ties advance the left sequence first so the result is
// deterministic.
function lcsPairs(left, right) {
  const rows = left.length;
  const columns = right.length;
  const lengths = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

// Compares two bodies by their common prefix and suffix. The remaining lines
// are the removed and added lines. It does not compute a minimal edit script.
function lineDiff(left, right) {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  let prefix = 0;
  while (prefix < leftLines.length && prefix < rightLines.length) {
    if (leftLines[prefix] !== rightLines[prefix]) break;
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = Math.min(leftLines.length, rightLines.length) - prefix;
  while (suffix < maxSuffix) {
    const leftLine = leftLines[leftLines.length - 1 - suffix];
    const rightLine = rightLines[rightLines.length - 1 - suffix];
    if (leftLine !== rightLine) break;
    suffix += 1;
  }

  const diff = [];
  for (let i = 0; i < prefix; i += 1) diff.push({ type: 'context', text: leftLines[i] });
  for (let i = prefix; i < leftLines.length - suffix; i += 1) {
    diff.push({ type: 'removed', text: leftLines[i] });
  }
  for (let i = prefix; i < rightLines.length - suffix; i += 1) {
    diff.push({ type: 'added', text: rightLines[i] });
  }
  for (let i = leftLines.length - suffix; i < leftLines.length; i += 1) {
    diff.push({ type: 'context', text: leftLines[i] });
  }
  return diff;
}

function splitLines(text) {
  return text === '' ? [] : String(text).split('\n');
}

// A fence grows past the longest run of its own character in the body so the
// block cannot be closed early.
function fenceFor(text) {
  let longest = 0;
  for (const run of String(text).match(/~+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '~'.repeat(Math.max(3, longest + 1));
}

function codeSpan(text) {
  const value = String(text);
  let longest = 0;
  for (const run of value.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const ticks = '`'.repeat(Math.max(1, longest + 1));
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${value}${pad}${ticks}`;
}
