# Dependency Provenance & Lockfile Integrity Policy

This policy defines where QuickEx dependency code may come from, and how the
resolved tree is proven to be the one that was reviewed. It is enforced by the
dependency gate (`scripts/deps/check.mjs`) on every pull request.

Related: [DEPENDENCY-LICENSE-POLICY.md](./DEPENDENCY-LICENSE-POLICY.md) (which
licences are permitted), [../security.md](../security.md) (secret scanning),
[../GOVERNANCE.md](../GOVERNANCE.md) (policy index and review cadence).

## 1. Objective

A dependency is code that runs inside a product which signs Stellar
transactions. Even though QuickEx never holds a signing key (self-custody —
[ADR 0001](../adr/0001-self-custody-and-no-server-side-key-custody.md)), a
compromised dependency can tamper with the transaction envelope the backend
assembles, serve a malicious client bundle, or exfiltrate data from the API
process. Provenance and lockfile integrity are what make the reviewed tree the
installed tree.

Two properties are therefore required of every dependency:

1. **Provenance** — it comes from the npm registry, at a pinned version, so it
   is content-addressed and reviewable.
2. **Integrity** — the lockfile records a hash for every resolved package, so a
   substituted or intercepted tarball is detected rather than installed.

## 2. Provenance rules

| Rule | Rejected | Why |
|---|---|---|
| Registry-only sourcing | `git+…`, `github:org/repo`, `gitlab:`, `bitbucket:`, `file:`, `link:`, `http(s)://…` | Fetched over a transport the lockfile does not hash. The reviewed commit can change, or the URL can be repointed, without any diff appearing in this repository. |
| Version pinning | `latest`, `next`, `beta`, `canary`, `nightly`, `alpha`, `dev` | A dist-tag resolves to whatever the registry serves *at install time*. CI and a developer's machine can install different code from the same commit. |
| No catch-all ranges | `*`, `x`, `1.x`, `1.*` | Accepts any version, including a newly published one. |
| Workspace links are permitted | `workspace:*` | Points at code already in this repository, so it is reviewed with the tree. |

`app/mobile` previously declared `@react-native-community/cli` as `latest`,
which is why the lockfile recorded `specifier: latest`. It is now pinned to the
exact version the lockfile already resolved.

**If a package must come from outside the registry**, vendor the source into
this repository under a directory that is reviewed like any other code, and
reference it with a workspace path. Do not add an exception to the gate.

## 3. Lockfile integrity rules

| Rule | Enforced behaviour |
|---|---|
| The lockfile is committed | `pnpm-lock.yaml` must exist. Without it, installs are neither reproducible nor hashed. |
| Supported format | `lockfileVersion` must be `9.0` (pnpm 10). An unknown version is an error, not a warning, so the gate cannot silently mis-parse a future format. |
| Every package is hashed | Each entry in the `packages:` block must carry a `resolution.integrity` value. Entries without one are reported so a reviewer confirms each is an in-repo link. |
| Importers match the workspace | Every lockfile importer must correspond to a `package.json`, and every `package.json` must have an importer entry. |
| Manifests match the lockfile | Each declared dependency must appear in the importer with an identical specifier. |

The manifest/lockfile agreement rule catches the most common real failure: a
`package.json` edited without running `pnpm install`. Left alone, that surfaces
much later as a `--frozen-lockfile` install failure during deployment, when the
change is hardest to attribute. This gate surfaces it in review instead.


## 4. Operational procedure

**Adding or upgrading a dependency**

```bash
# 1. add the dependency with an exact or caret range
pnpm --filter @quickex/backend add some-package@^1.2.3

# 2. regenerate and commit the lockfile (required — the gate fails otherwise)
pnpm install

# 3. verify provenance, integrity, and licence
node scripts/deps/check.mjs --installed
```

Step 2 is not optional. The agreement check fails if the manifest and lockfile
disagree, which is exactly the state that would break a frozen-lockfile deploy.

**Resolving a failure**

| Message | Action |
|---|---|
| `bypasses the registry` | Move the code into this repository, or publish and depend on a registry release. |
| `floats on the "…" dist-tag` | Replace the dist-tag with the exact version currently resolving, then re-run `pnpm install`. |
| `accepts any version` | Replace `*`/`x`/`1.x` with a caret or exact range. |
| `no content hash` | Confirm the entry is an in-repo workspace link. If it is a fetched tarball, remove the dependency. |
| `lockfileVersion … is not supported` | Upgrade pnpm, or update `SUPPORTED_LOCKFILE_VERSIONS` in the gate in the same change. |
| `is … but the lockfile pins …` | Run `pnpm install` and commit the lockfile. |
| `has no matching package.json` | Run `pnpm install`; a stale importer means a workspace package was removed or renamed. |

**Maintenance.** `@playwright/test` was declared in `app/frontend` but absent
from the lockfile; `pnpm install` added it. Regenerating the lockfile is the
only supported repair for drift — never hand-edit `pnpm-lock.yaml`.

**Scope and limits.** The gate covers the pnpm workspace. Cargo dependencies
for `app/contract` are pinned by `app/contract/Cargo.lock` and validated by
`cargo build --locked`; the gate does not duplicate Cargo's integrity model.
The `--installed` mode reads `node_modules`, so it reflects what is actually
resolved locally; CI is the authoritative run because it installs from the
lockfile first.

## 5. Machine checks

```bash
node scripts/deps/check.mjs                    # all three targets
node scripts/deps/check.mjs --only provenance  # sourcing and pinning
node scripts/deps/check.mjs --only lockfile    # hashes and manifest agreement
node scripts/deps/check.mjs --json             # machine-readable report
node --test scripts/deps/__tests__/            # tests for the gate itself
```

The gate has **no dependencies** and never installs or imports dependency code,
so it runs on a fresh clone before `pnpm install` and gives the same verdict on
an untrusted fork. Exit codes: `0` clean, `1` errors, `2` usage error.
