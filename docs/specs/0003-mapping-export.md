# 0003: Mapping export

Status: Draft
Target: 0.2.0
Depends on: none

## Problem

Placeholders are one-way. A maintainer reading `[OPENAI_KEY_3]` cannot recover
the value that failed, and a user cannot correlate the same placeholder across
two runs. Keeping the original log is the only reliable way to recover a value
today, and it is the file the report exists to avoid sharing.

The mapping is as sensitive as the log. Writing it in plaintext next to the
report would create a second file to leak.

## Goals

- Add `--mapping <file>` to write a placeholder-to-original map.
- Encrypt the map with a passphrase using `node:crypto`.
- Add `sanitrace mapping show <file>` to decrypt and print the map.
- Bind the map to the report with a SHA-256 hash.
- Keep plaintext mappings unsupported.
- Add no dependency and no network call.

## Non-goals

- Restoring a redacted report in place. `mapping show` is the only read path in
  this spec.
- Interactive passphrase prompts.
- Key rotation.
- Sharing a map across reports.
- Storing the map in the report or in `--json` output.

## Proposal

### CLI

```console
$ export SANITRACE_MAPPING_PASSPHRASE='correct horse battery staple'
$ sanitrace session.jsonl -o report.md --mapping report.map
$ sanitrace mapping show report.map
$ sanitrace mapping show report.map --report report.md
```

Options:

- `--mapping <file>` writes an encrypted map after the report is written.
- `--mapping-passphrase-env <name>` selects the environment variable. The
  default is `SANITRACE_MAPPING_PASSPHRASE`.
- `--force` replaces an existing mapping file. Without it, an existing file is
  an error.
- `mapping show <file>` decrypts and prints the map as JSON to stdout.
- `mapping show --report <file>` recomputes the report hash and exits 2 when it
  does not match. The hash covers the Markdown report. With `--json`, `--report`
  must point to a Markdown file, not the JSON payload.

The passphrase is never accepted as a command-line value. It comes from the
environment variable only. The variable name must match
`^[A-Z_][A-Z0-9_]*$`.

### File format

The mapping file is one JSON document:

```json
{
  "version": 1,
  "kdf": {
    "name": "scrypt",
    "N": 32768,
    "r": 8,
    "p": 1,
    "salt": "<base64, 16 bytes>"
  },
  "cipher": {
    "name": "aes-256-gcm",
    "iv": "<base64, 12 bytes>",
    "tag": "<base64, 16 bytes>"
  },
  "ciphertext": "<base64>"
}
```

The plaintext is UTF-8 JSON:

```json
{
  "version": 1,
  "createdAt": "2026-10-21T12:00:00.000Z",
  "report": { "sha256": "<hex>" },
  "entries": {
    "[OPENAI_KEY_1]": "sk-...",
    "<REPO>": "/Users/me/dev/acme-private"
  }
}
```

`entries` is sorted by placeholder. It covers every placeholder that appears in
the report: detector placeholders, `<REPO>`, `<HOST>`, and `~`. The `~` key maps
to the home directory. Values are the original strings, not truncated samples.

### Cryptography

- Salt: 16 random bytes from `crypto.randomBytes`.
- IV: 12 random bytes from `crypto.randomBytes`. A new IV is generated for each
  file.
- KDF: `crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1,
  maxmem: 64 * 1024 * 1024 })`.
- Cipher: `aes-256-gcm` with a 32-byte key and a 16-byte tag.
- AAD: the UTF-8 string `sanitrace-mapping-v1` followed by the version, `N`,
  `r`, `p`, the base64 salt, and the base64 IV, separated by `\n`. The header
  parameters are authenticated.
- Passphrase rules: reject a missing or empty value, reject a value shorter than
  12 characters, and recommend 16 or more in the error text.

Header values are validated before the KDF runs: `N` must be a power of two from
16,384 to 1,048,576, `r` from 1 to 16, `p` from 1 to 4, salt exactly 16 bytes,
IV exactly 12 bytes, and tag exactly 16 bytes. A file that fails validation
exits 2 without allocating KDF memory.

### Write order

1. Parse, render, redact, and verify the report.
2. Write the report to `--out`, or hold the Markdown string for stdout.
3. Build the mapping from the redaction state and the path mappings.
4. Encrypt and write the mapping with mode `0600` where the platform supports
   it.
5. Print the report to stdout when `--out` is absent.
6. Print the usual redaction count to stderr.

If the report write fails, no mapping is written. If the mapping write fails,
a report already written to a file stays in place and the command exits 2 with
the mapping path. A report held for stdout is not printed.

The mapping is written even when `--verify` reports residuals, because the
report is also written. The residual message and exit code 3 tell the user the
report needs review.

### Redaction state

`redact()` gains an option, `mapping: true`, that returns an `entries` array of
`{ placeholder, value }` for the distinct values it replaced. When the option
is absent, the function does not retain the original values after the run. The
existing `seen` map already associates each value with a placeholder; the
change inverts it at the end.

Path mappings are created in `sanitize()`, not in `redact()`. `sanitize()` adds
the three path entries when the corresponding mapping occurred, which the
`path` finding count shows. A `~` that the user typed is not included.

## Behavior

- Without `--mapping`, output and exit codes are unchanged.
- During a run that writes a report, the mapping contents never appear in the
  report or on stdout. `--json` findings keep their existing `samples` field,
  which can contain up to 40 characters of a match. The mapping adds no new
  field to the report or to `--json`.
- `mapping show` prints the plaintext JSON to stdout and a one-line warning to
  stderr.
- `mapping show` on a file with the wrong passphrase exits 2 with
  `could not decrypt mapping` and no detail that distinguishes a bad key from a
  bad tag.
- `mapping show` does not write a file.
- A mapping from one report fails the `--report` hash check against another
  report, even when both use the same passphrase.
- Running the same input twice produces different salt, IV, and ciphertext.

## Failure modes

| Condition | Result |
| --- | --- |
| `--mapping` without the environment variable | Exit 2 before reading input |
| Passphrase shorter than 12 characters | Exit 2 before reading input |
| Invalid environment variable name | Exit 2 |
| Mapping path equals the report path | Exit 2 |
| Mapping path exists and `--force` is absent | Exit 2 |
| Mapping path is a symlink | Exit 2, even with `--force` |
| Mapping directory does not exist | Exit 2 with the path |
| Report write fails | Exit 2, no mapping |
| Mapping write fails | Exit 2. A report file remains; a stdout report is not printed |
| Unknown file version or algorithm | Exit 2 |
| Header value outside the limits | Exit 2 |
| Base64 or JSON is malformed | Exit 2 |
| Wrong passphrase or tampered ciphertext | Exit 2, generic decrypt message |
| `mapping show --report` hash mismatch | Exit 2 |
| `mapping show` on a missing file | Exit 2 |

## Security

The map protects against casual access, an accidental `git add`, and a shared
backup. It does not protect against a compromised machine, a keylogger, or an
attacker who knows the passphrase. The plaintext is as sensitive as the original
log.

AES-GCM authenticates the ciphertext and the AAD covers the KDF parameters and
the IV. Changing any of them makes decryption fail. scrypt raises the cost of a
guessing attack, but the passphrase quality still matters.

The passphrase is not passed in `argv`, so it does not appear in a process list.
An `export` command typed at a shell prompt can be recorded in shell history.
Load the value from a secret manager or a shell profile that is not committed.
On systems where the same user or root can read a process environment, the
variable is still visible. `sanitrace` starts no child processes.

The tool cannot prevent a user from committing the map. The error text and the
README recommend an output path outside the repository or an entry in
`.gitignore`. The file mode is `0600` on POSIX; Windows does not enforce it.

`mapping show` prints original secrets to stdout. A redirect is the user's
choice. The stderr warning is always printed. `--json` findings already include
up to 40 characters of each match in `samples`; the mapping feature does not
change that field.

## Test plan

Round trip:

- Encrypt a map, decrypt it, and compare the entries and the report hash.
- Assert that two runs with the same input use different salt and IV.
- Assert that a map with 1,000 entries round-trips.

Failures:

- Wrong passphrase, tampered ciphertext, tampered tag, tampered salt, tampered
  IV, and an out-of-range `N` each exit 2.
- A short passphrase and a missing variable exit 2 before the input file is
  opened. Use a missing input path to prove the order.
- An existing mapping without `--force` exits 2 and does not change the file.
- A symlink at the mapping path exits 2.
- A mapping path equal to the report path exits 2.

Coverage and leakage:

- Every placeholder in the report has an entry.
- No full original value appears in the report or on stdout during a normal run.
  The existing `--json` samples stay unchanged, and the mapping adds no new
  field to that output.
- `mapping show --report` accepts the matching report and rejects a different
  one.
- The emitted file parses as JSON and contains only the documented fields.
- On POSIX, the file mode is `0600`. The test is skipped on Windows.

## Rollout

Release 0.2.0. Add the `mapping` command to the CLI help and the README. Add
`--mapping`, `--mapping-passphrase-env`, and `--force` to the option list. Note
that the feature uses `node:crypto` and adds no package dependency.

`--force` is scoped to the mapping file in this release. Document that it does
not overwrite the report.

## Open decisions

- A TTY prompt is deferred. It needs no-echo terminal handling that differs by
  platform.
- `mapping show --out` is not part of this spec. Printing to stdout keeps the
  plaintext path explicit.
- A `restore` command is a separate spec because it has its own leakage risks.
- Key rotation is out of scope. A rewrite with a new passphrase is enough for
  now.
