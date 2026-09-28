# Release Candidate Validation

One command runs the full release gate:

```bash
./scripts/rc-validate.sh
```

It is the same gate CI runs. `.github/workflows/rc-validate.yml` calls this exact
script, so a green local run and a green CI run mean the same thing — there is one
definition of "validated", not two that drift.

## Usage

```bash
./scripts/rc-validate.sh                   # full gate, all stages
./scripts/rc-validate.sh --quick           # fast subset while iterating
./scripts/rc-validate.sh --stage lint,test # only these stages
./scripts/rc-validate.sh --list            # show the stage registry
./scripts/rc-validate.sh --json            # NDJSON, for tooling
./scripts/rc-validate.sh --allow-skip      # optional stages may be skipped
```

## Stages

| Stage | Tool | Optional | What it checks | Mirrors |
|---|---|---|---|---|
| `env` | pnpm | no | Node ≥ 20, matching the CI floor | `ci.yml` |
| `install` | pnpm | no | `pnpm install --frozen-lockfile` resolves | `ci.yml`, `cd.yml` |
| `secret-scan` | detect-secrets | yes | No new secrets vs `.secrets.baseline` | `secret-scanning.yml` |
| `lint` | pnpm | no | `pnpm lint` across the workspace | `backend.yml`, `frontend-ci.yml` |
| `type-check` | pnpm | no | `pnpm type-check` across the workspace | `backend.yml` |
| `build` | pnpm | no | `pnpm build` | `backend.yml` |
| `test` | pnpm | no | Backend unit + integration suites with coverage thresholds | `backend.yml` |
| `fuzz` | pnpm | yes | Property-based suites (`fast-check`) | `jest.fuzz.config.ts` |
| `contract` | cargo | yes | `cargo fmt` + `clippy -D warnings` + `test` | `contract.yml` |
| `openapi` | pnpm | no | Committed `openapi.json` matches the code | `backend.yml` |
| `capability-map` | git | yes | Reports the diff so rows can be checked against behavior | ADR 0004 |

`--quick` runs `env`, `install`, `secret-scan`, `lint`, and `type-check` only.

## Exit codes

| Code | Meaning | Blocks a merge? |
|---|---|---|
| `0` | Accepted — every stage passed, or only `--allow-skip` skips occurred | no |
| `1` | **Rejected** — a stage failed, *or* an optional stage was skipped without `--allow-skip` | yes |
| `2` | **Refused** — bad arguments, or `STELLAR_NETWORK=mainnet`. Nothing ran. | yes |

The distinction between `1` and `2` matters: `1` means "we ran it and it is not
good enough", `2` means "we deliberately did not run it". Neither is an accept.

## Design decisions

**A skip is a failure by default.** A release candidate whose contract tests
silently did not run is not a release candidate. If a missing toolchain is
genuinely acceptable for a given change, say so explicitly with `--allow-skip` and
record it — the run then reports `ACCEPTED_WITH_SKIPS` rather than a clean pass, so
the gap stays visible in the job summary.

**The script refuses `STELLAR_NETWORK=mainnet`.** A candidate is validated against
testnet. Mainnet behavior is enabled after promotion, as a separate reviewed
rollout, per [ADR 0002](adr/0002-testnet-first-mainnet-feature-gated.md). This is a
guard, not a formality: it stops someone from treating a green mainnet run as
pre-approval to ship.

**Required vs optional is a claim about coverage, not about importance.** A
required stage is one whose absence means we cannot honestly call the candidate
validated. `contract` and `fuzz` are optional because a frontend-only change
legitimately does not need a Rust toolchain — but they must be *skipped loudly*,
never dropped.

**`openapi` runs with placeholder credentials.** `pnpm run docs:export:check`
regenerates the spec and diffs it against the committed `openapi.json`, which is
what `backend.yml` does. The export boots the Nest app, so the Joi schema must
validate, but it never reaches Supabase. The placeholders
(`https://spec-export.supabase.co` / `spec-export-key`) are deliberately not
secrets and must never be replaced with real credentials in the workflow.

**`capability-map` reports rather than asserts.** ADR 0004 requires a PR that
changes shipped behavior to update `docs/CAPABILITY-MAP.md` in the same PR. Whether
a given row *should* have changed is a review judgment, not a machine-decidable
one, so the stage prints the change count and always passes. It exists to make the
check visible in the report rather than assumed.

## Observability

Each stage emits one result line with its duration, and `--json` emits NDJSON:

```json
{"stage":"lint","result":"PASS","duration_ms":8432,"detail":"eslint clean"}
{"result":"ACCEPTED","failures":0,"skips":0}
```

In Actions, the script also writes a markdown table to `$GITHUB_STEP_SUMMARY`, and
the workflow uploads every `/tmp/rc-*.log` as a 14-day artifact, so a red run can
be diagnosed without re-running it. Details never include environment variable
values, only variable-free descriptions and log paths.

## Where it runs

| Trigger | Mode | Purpose |
|---|---|---|
| `workflow_dispatch` | full, configurable | The release-candidate gate. Input a `stage` list or accept skips. |
| `pull_request` on backend/CI paths | `--quick` | Early warning. Per-PR CI already covers the rest. |
| Nightly schedule | full, against `main` | Regression net, so a candidate is not validated only when someone remembers. |

## Promotion

Passing this gate means the candidate is *validated*, not *approved*. Promotion
still follows [RELEASE_PROMOTION_FLOW.md](../RELEASE_PROMOTION_FLOW.md), and the
cross-app checklist in [RELEASE_READINESS_CHECKLIST.md](../RELEASE_READINESS_CHECKLIST.md)
still applies — including the manual and contract-specific items this script cannot
automate.
