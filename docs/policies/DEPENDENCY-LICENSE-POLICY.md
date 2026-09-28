# Dependency License Policy

This policy defines which dependency licences may enter the QuickEx tree. It is
enforced by the dependency gate (`scripts/deps/check.mjs`), which runs on every
pull request; the machine-readable form is
[data/dependency-license-policy.json](./data/dependency-license-policy.json).

Related: [DEPENDENCY-PROVENANCE-POLICY.md](./DEPENDENCY-PROVENANCE-POLICY.md)
(where code may come from), [../security.md](../security.md) (secret handling),
[../GOVERNANCE.md](../GOVERNANCE.md) (policy index and review cadence).

## 1. Why a license policy exists

QuickEx is a wallet-facing product built on **self-custody**: the backend never
holds a signing key (see [ADR 0001](../adr/0001-self-custody-and-no-server-side-key-custody.md)).
That design is only trustworthy if the surrounding code is auditable and
permissively licensed. A copyleft or source-available dependency does not
compromise custody directly, but it changes who may redistribute, fork, and
audit the product, and — for strong copyleft — can reach into the applications
that embed it.

The policy therefore keeps the tree permissively licensed by default, and makes
every exception a recorded, reviewable decision rather than an accident found
during a release.

## 2. Classification

Each dependency licence is resolved to a single verdict. Legacy SPDX spellings
that predate an id rename (`AGPL-3.0`, `GPL-3.0`, `LGPL-2.1`, …) are
canonicalised before matching, so an older package is judged on its current
obligations rather than failing on a string mismatch. A dual-licensed package
(`MIT OR Apache-2.0`) is judged on its most permissive branch, which is the
choice an integrator actually has.

| Verdict | Meaning | Effect |
|---|---|---|
| **allow** | Permissive and compatible with redistribution and audit. | Passes. |
| **review** | Copyleft or attribution-with-obligations. Permitted **only** with a recorded exception. | Warning; becomes an error once acknowledged, so the exception is not forgotten. |
| **deny** | Copyleft-strong, non-commercial, field-of-use, or patent-encumbered. | Error; the build cannot merge. |
| **unknown** | No SPDX identifier, or an identifier absent from the policy. | Error by default (`unknownBehavior`). An unstated licence cannot be shown to be compatible. |

### Denied licenses

The following are **denied** and will fail CI:

- `BUSL-1.1` — source-available with a production use restriction.
- `CC-BY-NC-4.0` — non-commercial only.
- `Commons-Clause` — adds a commercial restriction to a permissive licence.
- `Elastic-2.0` — field-of-use restriction.
- `Facebook-BSD-Patents` — patent grant with an advertising clause.
- `NOSL` — non-commercial source licence.
- `PolyForm-Noncommercial-1.0.0` — non-commercial only.

`AGPL-3.0` and `SSPL-1.0` sit in the `review` bucket rather than `deny` because
neither is a commercial-use prohibition, but neither may be merged without a
recorded exception.

### Reviewed licenses

`AGPL-3.0`, `EPL-2.0`, `GPL-2.0`, `GPL-3.0`, `LGPL-2.1`, `LGPL-3.0`, `MPL-2.0`,
`SSPL-1.0`, `CC-BY-4.0`, and `CC-BY-SA-4.0` require review: they are legitimate
open-source licences, but they carry obligations (source disclosure, file-level
copyleft, attribution) that a reviewer must consciously accept for this product.

## 3. Exceptions

An exception is an entry in the `exceptions` array naming the exact `license`
and a `justification`. The gate rejects an exception that lacks either field, so
a licence can never be waved through silently.

```json
{
  "license": "MPL-2.0",
  "justification": "File-level copyleft is acceptable: <scope>. Reviewed in PR #NNN."
}
```

Adding or widening an exception is a **reviewed change** to this policy and to
the JSON. It must be called out in the PR description, because it is a
long-lived obligation, not a build setting.

## 4. Configuration


## 5. Operational procedure

**Adding a dependency**

1. Add it with an exact or caret range. `latest`, `*`, and git/URL specifiers are
   rejected by the provenance check.
2. Run `pnpm install` and commit the updated `pnpm-lock.yaml`.
3. Run `node scripts/deps/check.mjs --installed`.
4. If the licence is `review` or `unknown`, add an exception with a justification
   or remove the dependency.

**Upgrading an existing dependency**

The gate re-runs on every pull request, so an upgrade that introduces a
`review` or `deny` licence fails CI at the point of change rather than at the
next release audit. Regenerating the lockfile alone cannot clear the failure —
only an exception or removal can.

**Resolving a failure**

| Message | Action |
|---|---|
| `is denied by …` | Remove the dependency, or replace it with a permissively licensed equivalent. Do not add an exception for a `deny` verdict without maintainer sign-off. |
| `is not listed in the policy` | Add the SPDX id to `allow` (if genuinely permissive) or `review`, and document it in §2. |
| `no SPDX license declared` | Prefer a different version, or record the licence from the upstream source in an exception. |
| `requires review …` | Add an exception with a justification. |

**Scope.** The default gate classifies the workspace manifests and the direct
dependency set read from the lockfile. `--installed` extends the sweep to the
transitive closure by reading `node_modules`, which is what CI runs after
`pnpm install`. Rust dependencies for `app/contract` are governed by
`Cargo.lock` and reviewed through the same policy; the gate does not duplicate
Cargo's own `deny` support.

## 6. Machine checks

```bash
node scripts/deps/check.mjs --only license              # policy shape + workspace
node scripts/deps/check.mjs --only license --installed  # + transitive closure
node --test scripts/deps/__tests__/                    # tests for the gate itself
```

See [DEPENDENCY-PROVENANCE-POLICY.md](./DEPENDENCY-PROVENANCE-POLICY.md) for
where dependencies may come from and how the lockfile is verified.

| Setting | Values | Meaning |
|---|---|---|
| `unknownBehavior` | `allow`, `review`, `deny`, `error` | How an unlisted or unstated licence is treated. The repository ships `review`, so an unknown licence is surfaced loudly and must be resolved. |
| `exceptions` | array of `{ license, justification }` | Acknowledged licences. |
| `allow` / `review` / `deny` | arrays of SPDX ids | The classification itself. A licence listed in two buckets is rejected as ambiguous. |
