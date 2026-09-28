# Pre-commit validation

Dependency-free, offline validation of secrets, generated artifacts, and
formatting for the files a commit touches (issue
[#297](https://github.com/Viky207/QiuckEx/issues/297)). It runs as a
`pre-commit` hook, in CI, and in the devcontainer, with no install step.

```bash
node scripts/precommit/check.mjs                       # staged files (what a hook sees)
node scripts/precommit/check.mjs --all                 # every tracked file
node scripts/precommit/check.mjs --files a.ts b.md     # specific paths
node scripts/precommit/check.mjs --all --no-ratchet    # report the full backlog
node scripts/precommit/check.mjs --json                # machine-readable report
node --test scripts/precommit/__tests__/precommit.test.mjs
```

Exit codes: `0` clean, `1` problems found, `2` usage error.

## What it enforces

| Check | Enforces |
|---|---|
| `artifacts` | paths that must never be committed: `.env*` (not `.env.example`), private keys and keystores, `node_modules/`, `dist/`, `.turbo/`, `coverage/`, `.next/`, Rust `target/`, logs, Stryker temp dirs |
| `secrets` | high-signal secret shapes in *any* text file: Stellar secret keys, Supabase service-role JWTs, PEM private-key blocks, GitHub PATs, AWS key ids, Slack tokens |
| `formatting` | missing final newline, trailing blank line, CRLF endings, trailing whitespace (Markdown exempt — two trailing spaces are a hard line break) |
| `largeFiles` | anything over `--maxkb` (default 500 kB), so a binary blob cannot land in history |

Secret findings **name the kind of secret, never the value**. Echoing a match
into a CI log would copy the secret somewhere it is not protected; there is a test
asserting exactly that.

## The ratchet

This repository has roughly 5,500 pre-existing formatting findings — mostly files
with no final newline. Failing on all of them would mean a 5,000-file reformat to
land any single feature: unreviewable, and it would bury a real finding.

So the check **ratchets**: it compares each file against its committed version in
`HEAD` and fails only on violations this change *introduces*. The comparison is
issue-by-issue, not file-by-file — file-level skipping would let a fresh
trailing-whitespace line ride along in a file that already missed a newline.

The remaining backlog is **counted and reported**, never hidden:

```
· 5553 file(s) skipped as pre-existing formatting debt (ratchet)
```

Use `--no-ratchet` to see the full backlog. It only shrinks as files are touched,
which is the intent.

## Allowlist

[`allowlist.txt`](./allowlist.txt) holds reviewed exceptions, one per line:

```
<glob> | <justification>
```

Same discipline as `.secrets.baseline`: an entry is a decision someone made and a
reviewer can see. A bare path with no reason parses as `"no justification given"`
and **fails the test suite**, so a suppression can never be added quietly. `*`
matches within one path segment; `**` crosses segments.

Current entries are:

- The crash-reporting redaction fixtures, which must contain a Stellar-secret-shaped
  string in order to prove redaction works.
- The committed `.npmrc` — required pnpm workspace config, containing no credentials.
- Build output that predates its ignore rule (see below).

## Finding already in the tree

Running `--all` surfaced **15 Turbo cache and daemon-log files committed under
`.turbo/`**, from before that directory was gitignored. They are allowlisted with
a note that removal is tracked separately rather than deleted here — removing
cached blobs is a mechanical follow-up, not part of this change.

## Troubleshooting

| Message | Action |
|---|---|
| `must not be committed: it is …` | Unstage it. If it is genuinely required, add an allowlist entry with a justification. |
| `appears to contain a <kind>` | **Revoke the credential first**, then remove it from the commit. Revoking after committing is too late. |
| `over the 500 kB limit` | Commit a source of truth (a script or fixture) that generates it. |
| `does not end with a newline` | Usually auto-fixed by `end-of-file-fixer` in the same pre-commit run. |
| `skipped as pre-existing formatting debt` | Informational. Fix the file if you are editing it anyway. |

## Adding a rule

1. Add the pattern to `FORBIDDEN_PATHS` or `SECRET_CONTENT_PATTERNS`, or to the
   formatting rules in `check.mjs`, with a comment explaining the risk.
2. Add a test covering the violation and at least one path that must stay allowed.
3. Update the table above and `docs/security.md`.
