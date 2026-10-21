# Security

`sanitrace` handles session logs that may contain live credentials. Two things
matter: the tool must not leak them, and a bug in it should be fixable fast.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability). Please do not open a public issue for:

- a credential class that is not redacted (include the shape, not the secret),
- a case where `--verify` passes but the report still leaks,
- path traversal or a write outside `--out`.

You will get an acknowledgement within seven days.

## Supported versions

Only the latest published minor version is supported.

## Scope

`sanitrace` is local and dependency-free, so the attack surface is the parser
(untrusted JSONL) and the renderer. It does not execute session contents.

## Known limits

Redaction is best-effort. See "Residual risk" in the README.
