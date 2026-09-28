# QuickEx Mainnet Deployment Checklist

This checklist ensures a safe, audited, and verifiable path to mainnet production deployment.

## Pre-Audit Phase

### Code Review & Testing
- [ ] All unit tests pass: `cargo test --lib`
- [ ] All integration tests pass: `cargo test --test '*'`
- [ ] Fuzz tests have run for ≥100,000 iterations
- [ ] Coverage report generated and reviewed (target: ≥85% line coverage)
- [ ] Static analysis tools pass: `clippy`, `cargo-audit`
- [ ] No security warnings or lints in CI/CD

### Performance Benchmarks
- [ ] Deposit operation: ≤1,500 stroops
- [ ] Withdraw operation: ≤1,200 stroops
- [ ] Dispute initiation: ≤800 stroops
- [ ] Multi-sig vote: ≤600 stroops per arbiter
- [ ] Cleanup operation: ≤2,000 stroops per escrow
- [ ] All benchmarks documented in `benchmarks/` directory

### Security Review
- [ ] No hardcoded secrets or private keys
- [ ] No debug logging in production code
- [ ] All `unwrap()` calls justified or replaced with proper error handling
- [ ] Nonce replay protection verified (see `nonce.rs`)
- [ ] Signature expiry validation in place
- [ ] Reentrancy protection verified (hook anti-pattern)

### Documentation Completeness
- [ ] README updated with production considerations
- [ ] Architecture documentation current
- [ ] API documentation complete and accurate
- [ ] State machine diagrams current
- [ ] Gas cost estimates documented
- [ ] All error codes documented with guidance

---

## Audit Phase

### Pre-Audit Coordination
- [ ] Audit firm selected and engaged
- [ ] Scope of audit clearly defined
- [ ] Timeline and deliverables agreed
- [ ] Audit report template prepared (see below)
- [ ] Contact persons and escalation path established

### Audit Execution
- [ ] Smart contract code audit completed
- [ ] Architecture review completed
- [ ] Threat model and risk assessment completed
- [ ] Invariant verification (see [INVARIANTS.md](../docs/INVARIANTS.md))
- [ ] Regression test suite provided to auditors

### Audit Report Processing
Use the **Audit Report Template** below to organize findings:

#### Audit Report Template

```markdown
# QuickEx Audit Report
**Date:** [YYYY-MM-DD]
**Auditor:** [Firm Name]
**Scope:** QuickEx Smart Contract (Soroban)
**Code Commit:** [git hash]

## Executive Summary
[Summary of findings, severity distribution, and overall recommendation]

## Critical Issues (Severity: High)
- [Issue ID]: [Description]
  - Location: [file:line]
  - Impact: [Describe impact]
  - Recommendation: [Fix or mitigation]
  - Status: [ ] Unresolved [ ] Resolved [ ] Accepted Risk
  - Remediation Commit: [git hash] (if resolved)

## Medium Issues (Severity: Medium)
[Same format as Critical]

## Low Issues (Severity: Low)
[Same format as Critical]

## Informational Findings
[Enhancement suggestions and best practice recommendations]

## Signature
[Auditor signature or attestation]
```

---

## Post-Audit Remediation

### Issue Tracking
- [ ] All audit issues tracked in GitHub Issues with `audit-finding` label
- [ ] Issue IDs cross-referenced in audit report (e.g., `AUDIT-001`)
- [ ] Remediation PRs created for each finding
- [ ] Remediation PRs reviewed and merged

### Regression Testing
- [ ] Fuzz tests re-run with ≥100,000 iterations post-remediation
- [ ] All new edge cases from audit added to regression corpus
- [ ] Integration tests re-run to verify no regressions
- [ ] Performance benchmarks re-run to verify no degradation

### Audit Sign-Off
- [ ] All Critical issues resolved (by auditor confirmation)
- [ ] All Medium issues resolved or accepted with documented risk
- [ ] Final audit sign-off letter received
- [ ] Audit findings summary published (with auditor permission)

---

## WASM Hash Pinning

The WASM binary hash provides cryptographic proof of the deployed code.

### Build & Hash Generation
1. **Deterministic Build**
   ```bash
   cd app/contract
   soroban contract build --release
   ```
   Verify build reproducibility: rebuild on different machine, compare hashes.

2. **Hash Computation**
   ```bash
   WASM_HASH=$(sha256sum contracts/quickex/target/wasm32-unknown-unknown/release/quickex.wasm | cut -d' ' -f1)
   echo "WASM Hash: $WASM_HASH"
   ```

### Hash Registration
- [ ] WASM hash recorded in contract metadata (see [`get_deployment_metadata`](contracts/quickex/src/lib.rs:797))
- [ ] WASM hash pinned in CI/CD pipeline
- [ ] WASM hash published in release notes
- [ ] WASM hash stored in secure configuration system (e.g., Vault, HashiCorp)

### Hash Verification (Mainnet)
```bash
# After deployment, verify the on-chain hash matches expected
soroban contract info --id <CONTRACT_ID> --network public | grep "wasm_hash"
```

---

## Contract ID Registration

Each deployed contract instance gets a unique immutable ID.

### ID Derivation
The contract ID is deterministic based on:
- Network (Mainnet/Testnet/Local)
- Deployer account
- Code reference (WASM hash)
- Authorization

### Registration Workflow
1. **Record Contract ID**
   ```
   Contract ID: CXXX...
   Deployment Date: YYYY-MM-DD
   Deployer: [account]
   WASM Hash: [hash]
   Network: [Mainnet]
   ```

2. **Update Configuration**
   - [ ] Contract ID added to `.env.mainnet`
   - [ ] Contract ID added to configuration management system
   - [ ] Contract ID documented in deployment playbook
   - [ ] Contract ID verified in `get_deployment_metadata` call

3. **Multi-Sig Authorization** (if applicable)
   - [ ] Contract ID registered in multisig timelock contract (if used)
   - [ ] Authorized signers list finalized
   - [ ] Emergency pause multisig configured

### Verification
```bash
soroban contract info --id <CONTRACT_ID> --network public
# Verify: code_hash, wasm_hash, created_at match expectations
```

---

## Rollback Plan

### Pre-Deployment Rollback Strategy
- [ ] Previous stable contract ID documented (if applicable)
- [ ] Upgrade authority clearly assigned (admin account)
- [ ] Rollback decision criteria defined (see below)
- [ ] Rollback communication template prepared

### Rollback Criteria
Initiate rollback if any of these occur within 24 hours of deployment:

1. **Functional Failures**
   - Core operations (deposit, withdraw, dispute) fail unexpectedly
   - State machine invariants violated
   - Funds at risk or locked unexpectedly

2. **Performance Degradation**
   - Transaction latency exceeds 5 seconds
   - Gas costs exceed budgeted amounts by >20%
   - Ledger backlog or congestion

3. **Security Incidents**
   - Unexpected access control bypass
   - Nonce replay or signature forgery detected
   - Reentrancy or state corruption observed

### Rollback Execution
1. **Pause Contract** (if possible)
   ```bash
   soroban contract invoke --id <CONTRACT_ID> \
     --network public \
     -- pause_global --reason SecurityEmergency
   ```

2. **Communicate Status**
   - Notify users via all channels (Discord, Twitter, email)
   - Provide ETA for resolution
   - DO NOT admit fault or speculate on cause

3. **Deploy Previous Version**
   ```bash
   soroban contract deploy --wasm /path/to/previous.wasm \
     --id <PREVIOUS_CONTRACT_ID> \
     --network public
   ```

4. **Coordinate Migration**
   - If state must migrate: publish migration plan
   - If escrows affected: notify users and arbiters
   - Provide recovery instructions

5. **Post-Incident Review**
   - Root cause analysis
   - Fix validation with auditor
   - Updated deployment checklist
   - Timelock delay for re-deployment

---

## Deployment Day Checklist

### Final Verification (24 hours before)
- [ ] Contract ID announced
- [ ] WASM hash published and verified
- [ ] All stakeholders briefed
- [ ] 24/7 monitoring configured
- [ ] Escalation contacts confirmed

### Deployment Execution
1. **Pre-Deployment**
   - [ ] Cancel any pending txns on contract account
   - [ ] Verify sufficient XLM balance (≥10 XLM buffer)
   - [ ] Confirm time window (low network load preferred)

2. **Deploy**
   ```bash
   soroban contract deploy --wasm contracts/quickex/target/wasm32-unknown-unknown/release/quickex.wasm \
     --network public
   ```

3. **Immediate Post-Deployment**
   - [ ] Contract ID confirmed in explorer
   - [ ] `health_check()` returns true
   - [ ] `get_deployment_metadata()` returns expected data
   - [ ] Monitor chain for any anomalies

### First 24 Hours
- [ ] Monitor gas prices and latency
- [ ] Monitor error rate from indexer
- [ ] Monitor escrow creation rate (expected vs. baseline)
- [ ] Monitor arbiter and admin operations
- [ ] NO major operations permitted (maintenance window)

---

## Testing Checklist for Mainnet

### Testnet Validation (Final Stage Before Mainnet)
- [ ] Complete deposit → withdraw cycle works
- [ ] Complete deposit → refund cycle works
- [ ] Dispute → resolve cycle works
- [ ] Multi-sig arbitration (M-of-N voting) works
- [ ] Cleanup operations succeed on terminal escrows
- [ ] Privacy operations work as expected
- [ ] Partial payment workflows complete successfully
- [ ] Concurrent operations (high load) stable
- [ ] No memory leaks or excessive storage growth

### Mainnet Smoke Tests (First Week)
- [ ] Create test escrow with small amount ($1-10 USD equivalent)
- [ ] Withdraw successfully
- [ ] Verify event emission and indexing
- [ ] Verify fee collection mechanism
- [ ] Create disputed escrow, resolve, verify arbiter logic

---

## Documentation Updates

### Release Notes
- [ ] Version number finalized
- [ ] Breaking changes listed
- [ ] New features described
- [ ] Bug fixes listed
- [ ] Known limitations documented
- [ ] Upgrade instructions provided

### Migration Guide
- [ ] Data migration paths documented (if applicable)
- [ ] API endpoint changes documented
- [ ] Deprecated endpoints listed with alternatives
- [ ] Timeline for deprecation provided

### Monitoring & Alerting
- [ ] Grafana dashboards configured
- [ ] Alert thresholds set (latency, errors, fees)
- [ ] Oncall rotation scheduled
- [ ] Runbook for common issues prepared

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Lead Developer | | | |
| Security Lead | | | |
| Product Lead | | | |
| Audit Firm | | | |

---

## Related Documents

- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — Contract design
- [INVARIANTS.md](../docs/INVARIANTS.md) — Critical safety properties
- [security.md](../docs/security.md) — Security model
- [RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md) — Overall platform readiness
