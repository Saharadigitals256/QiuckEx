# Security Policy – QuickEx

This document describes the secret-management and secret-scanning practices for the QuickEx repository.

---

## 1. Secret Storage

All sensitive credentials **must** be stored outside of version control:

| Secret type                           | Where to store                                                  |
| ------------------------------------- | --------------------------------------------------------------- |
| CI/CD tokens, API keys, database URLs | **GitHub Secrets** (Settings → Secrets and variables → Actions) |
| Local development keys                | Local `.env` file (already gitignored)                          |
| Cloud provider credentials            | Vault / managed secret store                                    |
| Stellar wallet secrets                | GitHub Secrets (`E2E_WALLET_SECRET`, etc.)                      |

**Never** commit real secrets to the repository — not even in example files, test fixtures, or documentation.

---

## 2. Pre-commit Hooks

The repository uses [pre-commit](https://pre-commit.com/) to run secret scanning before every commit.

### Setup

```bash
# Install pre-commit (Python tool)
pip install pre-commit

# Install the git hooks
pre-commit install

# (Optional) Run against all files to verify
pre-commit run --all-files
```

### Hooks installed

| Hook                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `detect-secrets`      | Yelp's pattern-based scanner; uses `.secrets.baseline`   |
| `gitleaks`            | Broad regex-based scanner covering 130+ secret providers |
| `detect-private-key`  | Blocks PEM-encoded private keys                          |
| `no-commit-to-branch` | Prevents direct commits to `main`                        |
| `quickex-precommit`   | Local rules: forbidden paths, secret shapes, formatting  |

---

## 3. CI Secret Scanning

The [`.github/workflows/secret-scanning.yml`](../.github/workflows/secret-scanning.yml) workflow runs automatically on every push and pull request.

It consists of three jobs:

1. **detect-secrets** – Scans the full repo against the baseline file. Fails if new, un-audited secrets are found.
2. **gitleaks** – Runs the gitleaks scanner for broader pattern coverage.
3. **env-guard** – Blocks any `.env` file (except `.env.example`) from being committed.

---

## 4. Baseline File

The `.secrets.baseline` file is a JSON file that records known false-positive matches (e.g., test tokens in `.env.example`). It is committed to the repo so that CI can verify no _new_ secrets are introduced.

### Updating the baseline

```bash
# Re-scan the repo
./scripts/secret-scan.sh

# Interactively mark findings as true/false positives
./scripts/secret-scan.sh --audit

# Commit the updated baseline
git add .secrets.baseline
git commit -m "chore: update secret scanning baseline"
```

---

## 5. `.env.example` Guidelines

The `.env.example` file serves as a template for developers. It must contain **only placeholder values**:

```env
# ✅ Good
SUPABASE_ANON_KEY=test-anon-key
STELLAR_SECRET_KEY=your-secret-key-here

# ❌ Bad – real secret
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
STELLAR_SECRET_KEY=SBFG...
```

---

## 6. Incident Response

If a secret is accidentally committed:

1. **Rotate the secret immediately** — assume it is compromised.
2. **Remove it from git history** using `git filter-repo` or BFG Repo-Cleaner.
3. **Audit access logs** for the affected service.
4. **Open a security incident** in the project tracker.

---

## 7. Quick Reference

```bash
# Run local secret scan
./scripts/secret-scan.sh

# Verify no new secrets
./scripts/secret-scan.sh --verify

# Run pre-commit on all files
pre-commit run --all-files
```

### Local hook: `quickex-precommit`

The QuickEx hook (`scripts/precommit/check.mjs`) covers what the generic scanners cannot express.
It is dependency-free, so it runs from the checkout with no install step, and the same check runs in
CI, so a rule that exists only on one developer's machine cannot merge.

It blocks:

- **Paths that must never be committed** — `.env` files (`.env.example` excepted), private keys and
  keystores, `node_modules/`, `dist/`, `.turbo/`, `coverage/`, Rust `target/`, and log files.
- **High-signal secret shapes in any text file** — Stellar secret keys, Supabase service-role JWTs,
  PEM private-key blocks, GitHub PATs, AWS key ids, and Slack tokens. A finding names the *kind* of
  secret, never the value: printing a match into a log would copy the secret somewhere it is not
  protected.
- **Whitespace problems** in files you are editing: missing final newline, trailing blank line, CRLF
  endings, and trailing whitespace.

Formatting is enforced as a **ratchet**: a violation that already exists in the committed file is
reported as pre-existing debt rather than blocking you, but any violation your change introduces
fails. Run `node scripts/precommit/check.mjs --all --no-ratchet` to see the full backlog.

Reviewed exceptions live in
[`scripts/precommit/allowlist.txt`](../scripts/precommit/allowlist.txt), one `<glob> | <justification>`
per line. An entry without a justification fails the test suite, so a suppression cannot be added
quietly. Full documentation: [`scripts/precommit/README.md`](../scripts/precommit/README.md).
