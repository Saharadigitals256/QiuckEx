# Contract Governance and Compatibility Guarantees

## Error-Code Compatibility

`QuickexError` numeric discriminants are part of the public client contract. Once released, an assigned code is immutable: it must not be renumbered, reused for a different meaning, or removed. Add new failures only with unused numeric values, and keep code bands documented in `contracts/quickex/src/errors.rs`.

The contract's `existing_error_codes_remain_stable` regression test pins every previously assigned value. Consumers should branch on known numeric codes and treat an unknown code as an unrecognized failure, not as success. Error names and human-readable messages are supplementary; numeric values are authoritative.

New governance and upgrade failures are additive:

| Error | Code | Meaning |
| --- | ---: | --- |
| `NotGovernanceSigner` | 203 | Caller is not an active signer |
| `InvalidGovernanceConfig` | 204 | Invalid signer set, threshold, or timelock |
| `GovernanceAlreadyInitialized` | 205 | Governance bootstrap has already completed |
| `GovernanceRequired` | 206 | A direct legacy admin call is blocked by multisig governance |
| `InvalidUpgradeWindow` | 323 | Invalid or inactive upgrade window |
| `UpgradeAlreadyInProgress` | 324 | An upgrade is already pending or executing |
| `UpgradeNotInProgress` | 325 | No approved upgrade is awaiting completion |
| `TimelockNotElapsed` | 326 | A proposal's delay has not elapsed |
| `ProposalNotFound` | 327 | Proposal id does not exist |
| `ProposalAlreadyApproved` | 328 | Signer already approved this proposal |
| `ProposalAlreadyExecuted` | 329 | Proposal was already executed |
| `ProposalCanceled` | 330 | Proposal was canceled at quorum |
| `InsufficientApprovals` | 331 | Proposal has not reached approval quorum |
| `InvalidProposal` | 332 | Conflicting or invalid vote/action |

## Multisig Governance

The existing admin bootstraps governance once through `initialize_governance`. Bootstrap requires a unique set of 2-16 signer addresses, a threshold between 2 and the signer count, and a timelock of at least 86,400 seconds. The admin authorizes bootstrap; after that transaction succeeds, direct role/admin configuration endpoints and standalone migration are blocked with `GovernanceRequired`.

For each change, an active signer calls `propose_governance_action`; that signer supplies the first approval. Other active signers approve independently. Anyone may execute after quorum and the proposal's `execute_after` time. Proposals and every vote are recorded persistently and emitted as schema-versioned governance events.

Supported proposal actions cover admin and role changes, pause controls, global and per-asset fee configuration, oracle fee configuration, platform wallet and fee collector changes, hook allowlisting, upgrade windows, signer rotation, timelock changes, and WASM upgrades. Signer rotation is itself an M-of-N delayed action. At execution, only approvals from the current signer set count; votes from rotated-out signers cannot authorize pending changes.

Cancellation requires a separate M-of-N cancellation vote before execution. A signer may switch their own vote between approval and cancellation while the proposal remains open. Once cancellation reaches quorum it is final. An executed upgrade cannot be canceled; it must be completed by an active signer against the exact approved target version.

Emergency mode is the deliberate fast-path exception: any active signer may activate the existing irreversible emergency stop immediately. It cannot move escrowed assets, and normal administration remains proposal-governed.

## Timelocked Upgrade Lifecycle

1. Governance approves an upgrade-window change before the window opens, if one is not already active.
2. A signer proposes `Upgrade(wasm_hash, target_version)`; the proposer counts as the first approval.
3. After M-of-N approval and the configured minimum delay, anyone may submit execution during the active `[start, end)` upgrade window. The contract records the target version and hash, emits lifecycle events, and swaps the current WASM.
4. After the new WASM is active, an active signer calls `complete_upgrade(caller, target_version)`. The version must exactly match the approved target. Migration and post-upgrade financial invariants run before the in-progress marker is cleared.
5. Before execution, signers may cancel by quorum. After the WASM swap, cancellation is intentionally unavailable; if migration fails, Soroban transaction rollback preserves the pending marker and the migration can be retried with corrected code.

An upgrade proposal must name a non-zero target version. The deployed implementation must migrate to exactly that version. Upgrade-window boundaries are half-open: the start is included and the end is excluded; end `0` means no upper bound.

## CI Resource Budgets

`bench_core_lifecycle_costs` in `contracts/quickex/src/bench_test.rs` asserts per-operation maxima for CPU instructions, memory bytes, and serialized storage bytes for create, fulfill, refund, and dispute flows. The contract workflow runs this test as an explicit gate and uploads JSON and Markdown measurements as the `quickex-contract-budget-report` artifact.

CPU instruction and memory figures use Soroban's test-environment budget meter. Storage figures are deterministic XDR key/value footprint estimates for the records written or updated by the measured lifecycle operation; they are regression ceilings, not a prediction of network rent or transaction fee in stroops. Threshold changes should be reviewed alongside the uploaded report and the relevant storage schema change.