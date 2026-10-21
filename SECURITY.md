# Security

sanitrace reads session logs that may contain live credentials. A detector that
misses a credential, or a report that leaks one, is a security issue.

## Report a vulnerability

Use GitHub private vulnerability reporting on this repository: Security, then
Report a vulnerability. Do not open a public issue for:

- a credential format that is not redacted
- a case where `--verify` passes but the report still leaks
- a write outside the path given with `--out`

Include the shape of the secret, not the secret itself. You will receive an
acknowledgement within seven days.

## Supported versions

Only the latest published minor version receives fixes.

## Scope

The tool is local and has no dependencies. The attack surface is the parser,
which reads untrusted JSONL, and the renderer. sanitrace does not execute
session contents.

## Known limits

Detection covers the rules listed in the README. See [Limits](README.md#limits)
before publishing a report.
