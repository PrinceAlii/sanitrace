# 0005: GitHub Action

Status: Draft
Target: 0.3.0
Depends on: 0002 for the `profile` input

## Problem

A repository that wants a report on an issue or pull request repeats the same
workflow steps: install Node, install sanitrace, run it, extract the Markdown,
upload the report, and post a comment. Each copy can print the raw log, upload
the input file as an artifact, or comment a report that failed verification.

A packaged action gives one implementation of those steps and one place to
document the permissions and the failure behavior.

## Goals

- Add a composite action at the repository root.
- Accept a log path, a profile, and a comment target.
- Upload the report and the findings JSON as artifacts. Never upload the input
  log.
- Comment on an issue or pull request when asked, and update the previous
  comment from the same action.
- Fail on residual matches. Fail on redactions only when the caller asks.
- Run on `ubuntu-latest` with Node 22, the version the package job uses in CI.

## Non-goals

- Downloading a log from an issue attachment.
- Creating issues.
- Posting without an explicit `comment: true` and a target number.
- Supporting Windows or macOS runners in the first release.
- Commenting on a repository other than the one that runs the workflow.
- Hosting reports outside GitHub.

The action does not read issue attachments. The workflow must provide the log in
the runner workspace, for example through a checked-out branch in a private
repository or a file produced by an earlier job.

## Proposal

### Action file

`action.yml` at the repository root:

```yaml
name: sanitrace
description: Render a redacted agent session report
inputs:
  path:
    description: Path to the session log in the workspace
    required: true
  profile:
    description: Report profile
    default: bug
  comment:
    description: Post or update a comment
    default: "false"
  issue-number:
    description: Issue or pull request number
    required: false
  artifact-name:
    description: Artifact name
    default: sanitrace-report
  retention-days:
    description: Artifact retention in days
    default: "7"
  fail-on-redaction:
    description: Fail when at least one redaction occurred
    default: "false"
  version:
    description: sanitrace version to install
    required: false
outputs:
  report-path:
    description: Path to the Markdown report
  redactions:
    description: Number of redactions
  residual:
    description: Number of residual matches
  result:
    description: clean, redacted, residual, or error
runs:
  using: composite
  steps:
    # implementation steps described below
```

### Inputs

| Input | Default | Behavior |
| --- | --- | --- |
| `path` | none | Required. Relative to `GITHUB_WORKSPACE` or absolute. |
| `profile` | `bug` | Passed to `--profile`. Validated by the CLI. |
| `comment` | `false` | `true` posts or updates one comment. |
| `issue-number` | event number | Falls back to the issue or pull request number in the event. |
| `artifact-name` | `sanitrace-report` | Name for `actions/upload-artifact`. |
| `retention-days` | `7` | Passed to the upload action. |
| `fail-on-redaction` | `false` | `true` maps to `--check`. |
| `version` | package version | Exact semver. The action reads `package.json` at `github.action_path` when the input is empty. |

The action rejects a `version` that does not match
`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`. It does not accept `latest` or a
git ref.

### Steps

1. Validate that `path` exists and is a file. Fail with the resolved path when
   it does not.
2. Set up Node 22 with `actions/setup-node@v4`.
3. Install sanitrace:
   `npm install --global --no-fund --no-audit sanitrace@<version>`.
4. Run `sanitrace --version` and compare it with `<version>`. Fail on a
   mismatch.
5. Run sanitrace with the profile and `--json -o "$RUNNER_TEMP/sanitrace/report.json"`.
   Capture the exit code without failing the step:
   `0` clean or redacted without `--check`, `1` redacted with
   `fail-on-redaction`, `2` usage or I/O error, `3` residual.
6. Extract `markdown` from the JSON payload to `report.md` with `node -e`. The
   extraction reads the JSON file, not the input log.
7. Upload `report.md` and `report.json` as one artifact. The upload step uses
   `if: always()` and `if-no-files-found: ignore` so a failed run still uploads
   whatever was written and a usage error does not add a second failure.
8. Set the outputs from the JSON payload: the total of `findings[].count`, the
   length of `residual`, and the result. When the JSON file is missing, set both
   counts to `0`, set `result` to `error`, and skip the comment.
9. If `comment` is true and the exit code is 0, post or update the comment.
   When the exit code is 1 and `fail-on-redaction` is false, also comment.
   An exit code of 2 or 3 never comments.
10. Exit with the original sanitrace code, or 1 when `fail-on-redaction` is true
    and the code was 1.

The action does not print the input log, the report body, or the findings
samples. It prints the redaction count, the residual count, and the artifact
name.

### Comment behavior

- Body marker: `<!-- sanitrace-report -->`.
- The action lists the comments on the issue or pull request and finds one whose
  body contains the marker and whose author is the user authenticated by
  `GH_TOKEN`. It updates that comment with `gh api` instead of adding a new one.
  If none exists, it creates one.
- The comment starts with a status line:
  `sanitrace: 12 redactions, 0 residuals.`
- The action sets `GH_TOKEN` from `github.token` for the `gh` calls. The token
  needs `issues: write` for an issue or `pull-requests: write` for a pull
  request.
- When the report is longer than 60,000 characters, the action truncates the
  comment at a line boundary, closes any open code fence, and appends a line with
  the workflow run URL. The artifact keeps the full report. The report header and
  the redaction table come first, so the important information survives the cut.
- The action never comments when the exit code is 2 or 3. A report with
  residual matches stays in the artifact for a maintainer to inspect.
- A comment that the token cannot write, for example on a pull request from a
  fork, produces a warning annotation and does not fail the job. The artifact
  is still uploaded.

### Outputs

| Output | Source |
| --- | --- |
| `report-path` | Absolute path to `report.md` in `RUNNER_TEMP` |
| `redactions` | Sum of `findings[].count` |
| `residual` | `residual.length` |
| `result` | `clean` when both counts are zero, `redacted` when only redactions exist, `residual` when residual is non-zero, `error` when no payload was written |

### Workflow examples

Pull request with a fixture in the repository:

```yaml
name: session report
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: PrinceAlii/sanitrace@v0.3.0
        with:
          path: test/fixtures/codex-rollout.jsonl
          profile: review
          comment: true
```

Manual run with a log that a maintainer placed in a private repository:

```yaml
name: session report
on: workflow_dispatch
permissions:
  contents: read
  issues: write
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: session-log
      - uses: PrinceAlii/sanitrace@v0.3.0
        with:
          path: logs/session.jsonl
          issue-number: "42"
          comment: true
```

## Behavior

- A workflow that does not use the action is unaffected.
- `comment` defaults to `false`. A true value needs a target number from the
  input or the event.
- The report profile defaults to `bug` and is passed through unchanged.
- The action updates its own marker comment. It does not edit comments written
  by other users.
- The action runs only on `ubuntu-latest` in this release.
- The action tag and the npm version are independent pins. A caller can override
  the npm version with the `version` input.

## Failure modes

| Condition | Result |
| --- | --- |
| `path` is missing | Step fails before install |
| `path` is a directory | Step fails with the path |
| Invalid `profile` | sanitrace exits 2, job fails |
| Invalid `version` | Step fails with the expected format |
| Installed version mismatch | Step fails |
| Input empty | sanitrace exits 2, job fails |
| Residual matches | Report uploads, no comment, job fails with exit 3 |
| Redactions with `fail-on-redaction: true` | Report uploads, no comment, job fails with exit 1 |
| Redactions with `fail-on-redaction: false` | Report uploads, comment, job succeeds |
| Comment token lacks write permission | Warning annotation, job keeps the sanitrace result |
| Comment API error other than permission | Warning annotation, job keeps the sanitrace result |
| Artifact upload fails | Job fails |

## Security

The session log is the most sensitive file in the job. The action must never
`cat` it, pass it to a logging command, or include it in an artifact. Shell
steps run without `set -x`.

Artifacts are visible to users who can read the repository. A public repository
makes the report public to the same audience as the workflow run. The report is
redacted, but the Limits section still applies. Do not enable the action on a
public repository for a log you have not reviewed.

The default `GITHUB_TOKEN` is read-only for pull requests from forks. The
documentation does not use `pull_request_target` and does not check out untrusted
code with a write token. The workflow examples use `pull_request` and list the
minimum permissions.

The action installs an exact published version from npm. npm verifies the
package integrity against the registry metadata. A compromised npm account is
outside the action's control; pin the action tag as well.

## Test plan

Workflow tests in this repository:

- A `workflow_dispatch` job runs the action on `test/fixtures/codex-rollout.jsonl`
  with `comment: false` and asserts `redactions > 0`, `residual == 0`, and
  `result == redacted`.
- A second job runs on `test/fixtures/claude-transcript.jsonl` and asserts the
  artifact contains `report.md` and `report.json`.
- A job with a missing path asserts a failed step with the resolved path.
- A job with `profile: unknown` asserts exit 2.
- A shell test runs the exit-code mapping helper with 0, 1, 2, and 3 and checks
  the resulting outputs.

Manual checks in a sandbox repository:

- Create a comment, run again, and confirm the marker comment is updated rather
  than duplicated.
- Run from a fork pull request and confirm the warning and the artifact.
- Confirm that no job log line contains a value from the fixture.

## Rollout

Release 0.3.0. Add `action.yml` at the repository root, a README section with
the two examples, and `examples/github-action.yml`. Pin the release tag in the
examples as `v0.3.0`; do not point `uses:` at a branch.

Marketplace listing is optional. The action works from a tag without it.

## Open decisions

- The action does not read a log from an issue attachment. The workflow must
  place the file in the runner workspace.
- The comment links to the workflow run, not the artifact. Artifact download
  URLs need authentication.
- Windows runners are deferred. The shell steps assume bash.
- Pull request review comments are a later addition.
