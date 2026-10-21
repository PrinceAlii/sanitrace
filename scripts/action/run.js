#!/usr/bin/env node
// Runner glue for the composite action. The functions it calls are in report.js.

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildCommentBody,
  buildCommentPayload,
  extractMarkdown,
  isTrue,
  issueNumberFromEvent,
  parseIssueNumber,
  resolveVersion,
  shouldComment,
  summarizePayload,
} from './report.js';

const actionRoot =
  process.env.GITHUB_ACTION_PATH ?? fileURLToPath(new URL('../..', import.meta.url));

const command = process.argv[2];

try {
  if (command === 'resolve-version') await resolveVersionCommand();
  else if (command === 'report') await reportCommand();
  else if (command === 'issue-number') await issueNumberCommand();
  else if (command === 'comment-payload') await commentPayloadCommand();
  else if (command === 'should-comment') shouldCommentCommand();
  else fail(`unknown command ${JSON.stringify(command)}`);
} catch (error) {
  fail(error.message);
}

async function resolveVersionCommand() {
  const packageJson = JSON.parse(
    await readFile(path.join(actionRoot, 'package.json'), 'utf8'),
  );
  const resolved = resolveVersion(process.env.SANITRACE_VERSION_INPUT ?? '', packageJson.version);
  await writeOutputs({ version: resolved.version, local: resolved.local });
}

async function reportCommand() {
  const reportJson = requiredEnv('SANITRACE_REPORT_JSON');
  const reportMarkdown = requiredEnv('SANITRACE_REPORT_MD');
  const exitCode = parseExitCode(process.env.SANITRACE_EXIT_CODE);
  const failOnRedaction = process.env.SANITRACE_FAIL_ON_REDACTION ?? 'false';
  const commentInput = process.env.SANITRACE_COMMENT_INPUT ?? 'false';
  const artifactName = process.env.SANITRACE_ARTIFACT_NAME ?? 'sanitrace-report';

  await mkdir(path.dirname(reportMarkdown), { recursive: true });

  const payload = await readJson(reportJson);
  const markdown = extractMarkdown(payload);
  const summary = summarizePayload(payload);
  if (markdown === null) await rm(reportMarkdown, { force: true });
  else await writeFile(reportMarkdown, markdown);

  const result = markdown === null ? 'error' : summary.result;
  const comment =
    markdown !== null && isTrue(commentInput) && shouldComment(exitCode, failOnRedaction);

  await writeOutputs({
    'report-path': path.resolve(reportMarkdown),
    redactions: summary.redactions,
    residual: summary.residual,
    result,
    comment,
  });

  console.log(`sanitrace: ${summary.redactions} redaction(s), ${summary.residual} residual(s)`);
  console.log(`Artifact: ${artifactName}`);

  if (result === 'error') {
    console.log('::warning::sanitrace did not write a usable JSON report; the comment was skipped');
  }
}

async function issueNumberCommand() {
  const input = process.env.SANITRACE_ISSUE_NUMBER_INPUT ?? '';
  let number = parseIssueNumber(input);

  if (number === null && input.trim() !== '') {
    throw new Error(`issue-number must be a positive integer; received ${JSON.stringify(input)}`);
  }

  if (number === null && process.env.GITHUB_EVENT_PATH) {
    const event = await readJson(process.env.GITHUB_EVENT_PATH);
    number = issueNumberFromEvent(event);
  }

  if (number === null) throw new Error('no issue or pull request number was found');
  process.stdout.write(`${number}\n`);
}

async function commentPayloadCommand() {
  const reportJson = requiredEnv('SANITRACE_REPORT_JSON');
  const payloadPath = requiredEnv('SANITRACE_COMMENT_PAYLOAD');
  const runUrl = requiredEnv('SANITRACE_RUN_URL');

  const payload = await readJson(reportJson);
  const markdown = extractMarkdown(payload);
  if (markdown === null) throw new Error('the report payload is missing');

  const summary = summarizePayload(payload);
  const body = buildCommentBody({ ...summary, markdown, runUrl });

  await mkdir(path.dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, buildCommentPayload(body));
}

function shouldCommentCommand() {
  const exitCode = Number(process.argv[3]);
  if (!Number.isInteger(exitCode)) {
    throw new Error(`exit code must be an integer; received ${JSON.stringify(process.argv[3])}`);
  }
  process.stdout.write(`${shouldComment(exitCode, process.argv[4] ?? 'false')}\n`);
}

function parseExitCode(value) {
  if (value === undefined || value === '') return 2;
  const code = Number(value);
  return Number.isInteger(code) ? code : 2;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function writeOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;

  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await appendFile(file, `${lines}\n`);
}

function fail(message) {
  const text = String(message)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  process.stdout.write(`::error::${text}\n`);
  process.exitCode = 1;
}
