# Dependency gate

Dependency-free, offline validation of dependency provenance, lockfile integrity, and license policy (issue [#294](https://github.com/Viky207/QiuckEx/issues/294)).
It never installs or imports dependency code: manifests, `pnpm-lock.yaml`, and the published policy are parsed as text.

```bash
node scripts/deps/check.mjs                       # all targets
node scripts/deps/check.mjs --only provenance     # provenance | lockfile | license
node scripts/deps/check.mjs --only license --installed  # + transitive licenses
node scripts/deps/check.mjs --json                # machine-readable report for CI
node --test scripts/deps/__tests__/deps.test.mjs  # tests for the gate itself
```

Exit codes: `0` clean, `1` errors, `2` usage error.

## What each target enforces

| Target | Reads | Enforces |
|---|---|---|
| `provenance` | every workspace `package.json`, `pnpm-lock.yaml` | registry-only sourcing (no `git+`/`github:`/`file:`/URL specifiers), no dist-tags or wildcard ranges, `workspace:` links permitted |
| `lockfile` | `pnpm-lock.yaml`, every workspace `package.json` | lockfile present, supported `lockfileVersion`, a content hash per resolved package, importers ↔ manifests agree, declared specifiers match the lockfile |
| `license` | `docs/policies/DEPENDENCY-LICENSE-POLICY.md`, `data/dependency-license-policy.json`, root manifest, lockfile importers (and `node_modules` with `--installed`) | policy shape, SPDX canonicalisation, allow/review/deny classification, every denied license documented, no unjustified exceptions |

## Policies

- [../../docs/policies/DEPENDENCY-PROVENANCE-POLICY.md](../../docs/policies/DEPENDENCY-PROVENANCE-POLICY.md) — where code may come from, and lockfile integrity.
- [../../docs/policies/DEPENDENCY-LICENSE-POLICY.md](../../docs/policies/DEPENDENCY-LICENSE-POLICY.md) — which licences are permitted, and how to record an exception.

## Layout

```
scripts/deps/
├── check.mjs            # CLI entry point
├── lib/
│   ├── shared.mjs       # paths, specifier classification
│   ├── provenance.mjs   # workspace manifest discovery + sourcing rules
│   ├── lockfile.mjs     # pnpm lockfile parsing (importers, integrity hashes)
│   ├── lockfile-check.mjs  # integrity + manifest/lockfile agreement
│   ├── licenses.mjs     # SPDX normalisation + policy classification
│   └── license-check.mjs   # license target, including the --installed sweep
├── __tests__/           # node:test suites (zero dependencies)
└── README.md            # this file
```

## Degraded mode

The default gate needs no `node_modules`: it classifies the workspace manifests and the direct dependency set read from the lockfile. `--installed` extends the sweep to the transitive closure by reading `node_modules`; when that directory is absent the target **warns** rather than failing, so a fresh clone still gets a verdict. CI is the authoritative run because it installs from the lockfile first.

## Adding a rule

1. Add the classification or check to the relevant function in `lib/`.
2. Add a test under `__tests__/` covering the happy path and one violation per rule, using `makeRepo()` to build a throwaway tree.
3. Document the rule in the matching policy under `docs/policies/`, then add it to the target table above and in `docs/GOVERNANCE.md` §5.
