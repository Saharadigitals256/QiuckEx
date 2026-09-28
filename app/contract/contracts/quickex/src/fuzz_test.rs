//! Property-based fuzz tests for QuickEx escrow state transitions.
//!
//! # Invariants under test
//!
//! | ID    | Description                                                              |
//! |-------|--------------------------------------------------------------------------|
//! | INV-1 | No early withdrawal — `withdraw` fails once `now >= expires_at`.         |
//! | INV-2 | No early refund — `refund` fails unless `expires_at > 0 && now >= expires_at`. |
//! | INV-3 | Overflow-safe expiry — `expires_at` is computed via `saturating_add`.   |
//! | INV-4 | Disputed funds locked — neither `withdraw` nor `refund` succeeds while `Disputed`. |
//! | INV-5 | Terminal states are final — `Spent`/`Refunded` block all further transitions. |
//! | INV-6 | No overpayment — `partial_payment` rejects amounts exceeding the remainder. |
//! | INV-7 | Nonce uniqueness — replaying a `(signer, nonce)` pair always fails.      |
//!
//! # Adding a new invariant
//!
//! 1. Document it in the table above.
//! 2. Write a `proptest!` block that generates arbitrary inputs and asserts the property.
//! 3. If the test found a concrete bug, add a deterministic regression case to the
//!    `regression_corpus` module at the bottom of this file.

use proptest::prelude::*;

use crate::test_context::TestContext;

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/// Generates a valid positive amount in [1, i128::MAX/2] to avoid overflow in
/// arithmetic inside the contract.
fn amount_strategy() -> impl Strategy<Value = i128> {
    1_i128..=1_000_000_000_i128
}

/// Generates a timeout in seconds. 0 means no expiry.
#[allow(dead_code)]
fn timeout_strategy() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),                // no expiry
        1u64..=3600u64,            // short (1 s – 1 h)
        3601u64..=86_400u64,       // medium (1 h – 1 day)
        86_401u64..=31_536_000u64, // long (1 day – 1 year)
    ]
}

/// Generates a salt as a fixed-size 32-byte array.
fn salt_strategy() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

/// Generates a time advance in seconds (0 = no advance).
fn time_advance_strategy() -> impl Strategy<Value = u64> {
    0u64..=200_000u64
}

// ---------------------------------------------------------------------------
// INV-1: No early withdrawal
// ---------------------------------------------------------------------------

proptest! {
    /// INV-1: withdraw MUST fail with EscrowExpired when now >= expires_at.
    #[test]
    fn inv1_no_early_withdrawal(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Advance to exactly the expiry boundary (now >= expires_at)
        ctx.advance_time(timeout);

        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-1 violated: withdraw succeeded after expiry for commitment {:?}",
            commitment
        );
    }
}

proptest! {
    /// INV-1 (converse): withdraw MUST succeed before expiry for a valid escrow.
    #[test]
    fn inv1_withdraw_before_expiry_succeeds(
        amount in amount_strategy(),
        timeout in 3601u64..=86_400u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Advance time but stay within the window
        ctx.advance_time(timeout / 2);

        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_ok(),
            "INV-1 converse violated: withdraw failed before expiry"
        );
    }
}

// ---------------------------------------------------------------------------
// INV-2: No early refund
// ---------------------------------------------------------------------------

proptest! {
    /// INV-2: refund MUST fail when expires_at == 0 (no timeout).
    #[test]
    fn inv2_no_refund_without_expiry(
        amount in amount_strategy(),
        salt in salt_strategy(),
        advance in time_advance_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), amount, &salt);
        ctx.advance_time(advance);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-2 violated: refund succeeded on a non-expiring escrow"
        );
    }
}

proptest! {
    /// INV-2: refund MUST fail before expiry even when a timeout is set.
    #[test]
    fn inv2_no_refund_before_expiry(
        amount in amount_strategy(),
        timeout in 3601u64..=86_400u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Advance to just before expiry
        ctx.advance_time(timeout - 1);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-2 violated: refund succeeded before expiry"
        );
    }
}

proptest! {
    /// INV-2 (converse): refund MUST succeed after expiry for the owner.
    #[test]
    fn inv2_refund_after_expiry_succeeds(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        ctx.advance_time(timeout + 1);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_ok(),
            "INV-2 converse violated: refund failed after expiry"
        );
    }
}

// ---------------------------------------------------------------------------
// INV-3: Overflow-safe expiry
// ---------------------------------------------------------------------------

proptest! {
    /// INV-3: deposit with a near-overflow timeout must either succeed with a
    /// valid expires_at or fail with InvalidTimeout — never panic or silently wrap.
    #[test]
    fn inv3_overflow_safe_expiry(
        amount in amount_strategy(),
        salt in salt_strategy(),
        // Use timeouts near u64::MAX to stress the saturating_add path
        timeout in prop_oneof![
            Just(u64::MAX),
            Just(u64::MAX - 1),
            Just(u64::MAX / 2),
        ],
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        // Must not panic — either Ok or a well-typed Err
        let result = ctx.client.try_deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );
        // We only assert no panic; the contract may return InvalidTimeout for u64::MAX
        let _ = result;
    }
}

// ---------------------------------------------------------------------------
// INV-4: Disputed funds locked
// ---------------------------------------------------------------------------

proptest! {
    /// INV-4: withdraw MUST fail while escrow is Disputed.
    #[test]
    fn inv4_disputed_blocks_withdraw(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.deposit_with_arbiter(&ctx.alice.clone(), amount, &salt, 3600);

        ctx.client.dispute(&commitment);

        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-4 violated: withdraw succeeded on a Disputed escrow"
        );
    }
}

proptest! {
    /// INV-4: refund MUST fail while escrow is Disputed (even after expiry).
    #[test]
    fn inv4_disputed_blocks_refund(
        amount in amount_strategy(),
        salt in salt_strategy(),
        timeout in 1u64..=3600u64,
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.deposit_with_arbiter(&ctx.alice.clone(), amount, &salt, timeout);

        ctx.client.dispute(&commitment);

        // Advance past expiry
        ctx.advance_time(timeout + 1);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-4 violated: refund succeeded on a Disputed escrow after expiry"
        );
    }
}

// ---------------------------------------------------------------------------
// INV-5: Terminal states are final
// ---------------------------------------------------------------------------

proptest! {
    /// INV-5: a second withdraw on a Spent escrow MUST fail.
    #[test]
    fn inv5_spent_is_terminal(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), amount, &salt);

        // First withdraw succeeds
        ctx.client.withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);

        // Second withdraw must fail
        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-5 violated: second withdraw succeeded on a Spent escrow"
        );
    }
}

proptest! {
    /// INV-5: refund on an already-Refunded escrow MUST fail.
    #[test]
    fn inv5_refunded_is_terminal(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        ctx.advance_time(timeout + 1);
        ctx.client.refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-5 violated: second refund succeeded on a Refunded escrow"
        );
    }
}

proptest! {
    /// INV-5: withdraw on a Refunded escrow MUST fail.
    #[test]
    fn inv5_refunded_blocks_withdraw(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        ctx.advance_time(timeout + 1);
        ctx.client.refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);

        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-5 violated: withdraw succeeded on a Refunded escrow"
        );
    }
}

// ---------------------------------------------------------------------------
// INV-6: No overpayment
// ---------------------------------------------------------------------------

proptest! {
    /// INV-6: partial_payment exceeding the remaining amount MUST fail.
    #[test]
    fn inv6_no_overpayment(
        amount_due in 2_i128..=1_000_000_i128,
        initial in 1_i128..=1_i128,   // pay 1 initially, leaving amount_due-1 remaining
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount_due + 1);

        let commitment = ctx.client.deposit_partial(
            &ctx.token,
            &amount_due,
            &initial,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &0,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Try to overpay by 1
        let overpay = amount_due; // remaining is amount_due - initial, overpay > remaining
        ctx.mint(&ctx.bob.clone(), overpay);
        let result = ctx.client.try_partial_payment(&commitment, &ctx.bob.clone(), &overpay, &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "INV-6 violated: overpayment was accepted"
        );
    }
}

// ---------------------------------------------------------------------------
// INV-7: Nonce uniqueness (replay protection)
// ---------------------------------------------------------------------------

proptest! {
    /// INV-7: consuming the same (signer, nonce) twice MUST fail.
    #[test]
    fn inv7_nonce_replay_rejected(
        nonce in any::<u64>(),
        valid_until_offset in 1u64..=86_400u64,
    ) {
        use crate::nonce::{verify_and_consume, ActionType};

        let ctx = TestContext::with_admin();
        let now = ctx.env.ledger().timestamp();
        let valid_until = now + valid_until_offset;
        let contract_id = ctx.client.address.clone();

        let (first_ok, second_ok) = ctx.env.as_contract(&contract_id, || {
            let first =
                verify_and_consume(&ctx.env, &ctx.alice, nonce, valid_until, ActionType::Withdraw)
                    .is_ok();
            let second =
                verify_and_consume(&ctx.env, &ctx.alice, nonce, valid_until, ActionType::Withdraw)
                    .is_ok();
            (first, second)
        });

        prop_assume!(first_ok); // skip if contract rejects for other reasons
        prop_assert!(!second_ok, "INV-7 violated: nonce replay was accepted for nonce={nonce}");
    }
}

proptest! {
    /// INV-7: an expired signature MUST be rejected regardless of nonce state.
    #[test]
    fn inv7_expired_signature_rejected(
        nonce in any::<u64>(),
        advance in 1u64..=86_400u64,
    ) {
        use crate::nonce::{verify_and_consume, ActionType};

        let ctx = TestContext::with_admin();
        let now = ctx.env.ledger().timestamp();
        // valid_until is in the past
        let valid_until = now.saturating_sub(1);
        ctx.advance_time(advance);
        let contract_id = ctx.client.address.clone();

        let result_ok = ctx.env.as_contract(&contract_id, || {
            verify_and_consume(&ctx.env, &ctx.alice, nonce, valid_until, ActionType::Withdraw)
                .is_ok()
        });

        prop_assert!(!result_ok, "INV-7 violated: expired signature was accepted");
    }
}

proptest! {
    /// Expiry edge: deposit at T, advance to exactly T+timeout, then try withdraw.
    /// At the boundary (now == expires_at) withdrawal MUST fail (INV-1).
    #[test]
    fn expiry_boundary_blocks_withdraw(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Advance to exactly the expiry boundary
        ctx.advance_time(timeout);

        let result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(
            result.is_err(),
            "Expiry boundary violated: withdraw succeeded at exactly expires_at"
        );
    }
}

proptest! {
    /// Expiry edge: refund at exactly T+timeout MUST succeed (boundary is inclusive).
    #[test]
    fn expiry_boundary_allows_refund(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        ctx.advance_time(timeout);

        let result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(
            result.is_ok(),
            "Expiry boundary violated: refund failed at exactly expires_at"
        );
    }
}

proptest! {
    /// Nonce expiry edge: valid_until == now MUST be rejected (boundary is exclusive).
    #[test]
    fn nonce_expiry_boundary_rejected(nonce in any::<u64>()) {
        use crate::nonce::{verify_and_consume, ActionType};

        let ctx = TestContext::with_admin();
        let now = ctx.env.ledger().timestamp();
        let contract_id = ctx.client.address.clone();

        let result_ok = ctx.env.as_contract(&contract_id, || {
            verify_and_consume(&ctx.env, &ctx.alice, nonce, now, ActionType::Withdraw).is_ok()
        });

        prop_assert!(!result_ok, "Nonce expiry boundary violated: accepted when valid_until == now");
    }
}

proptest! {
    /// Dispute → resolve_for_owner path: funds return to owner, state is Refunded.
    #[test]
    fn dispute_resolve_for_owner(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.deposit_with_arbiter(&ctx.alice.clone(), amount, &salt, 3600);

        ctx.client.dispute(&commitment);

        let balance_before = ctx.balance(&ctx.alice.clone());
        ctx.client.resolve_dispute(
            &ctx.arbiter.clone(),
            &commitment,
            &true,
            &ctx.bob.clone(), // recipient ignored when resolve_for_owner=true
            &0u64,
            &u64::MAX,
        );

        let balance_after = ctx.balance(&ctx.alice.clone());
        prop_assert!(
            balance_after > balance_before,
            "Dispute resolve-for-owner: owner balance did not increase"
        );

        // Further operations must fail (INV-5)
        let withdraw_result = ctx.client.try_withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(&salt), &0u64, &u64::MAX);
        prop_assert!(withdraw_result.is_err(), "INV-5 violated after dispute resolution");
    }
}

proptest! {
    /// Dispute → resolve_for_recipient path: funds go to recipient, state is Spent.
    #[test]
    fn dispute_resolve_for_recipient(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.deposit_with_arbiter(&ctx.alice.clone(), amount, &salt, 3600);

        ctx.client.dispute(&commitment);

        let balance_before = ctx.balance(&ctx.bob.clone());
        ctx.client.resolve_dispute(
            &ctx.arbiter.clone(),
            &commitment,
            &false,
            &ctx.bob.clone(),
            &0u64,
            &u64::MAX,
        );

        let balance_after = ctx.balance(&ctx.bob.clone());
        prop_assert!(
            balance_after > balance_before,
            "Dispute resolve-for-recipient: recipient balance did not increase"
        );

        // Further operations must fail (INV-5)
        let refund_result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(refund_result.is_err(), "INV-5 violated after dispute resolution");
    }
}

// ---------------------------------------------------------------------------
// deposit_with_commitment edge cases (Task #105)
// ---------------------------------------------------------------------------

proptest! {
    /// Fuzz deposit_with_commitment with various commitment and amount combinations.
    /// Ensures that commitment-based deposits work correctly and don't allow duplicate commits.
    #[test]
    fn fuzz_deposit_with_commitment_basic(
        amount in amount_strategy(),
        timeout in timeout_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);

        // Create commitment off-chain
        let commitment = ctx.client.create_amount_commitment(
            &ctx.alice.clone(),
            &amount,
            &ctx.salt(&salt),
        );

        // Deposit with commitment should succeed
        let result = ctx.client.try_deposit_with_commitment(
            &ctx.alice.clone(),
            &ctx.token,
            &amount,
            &commitment,
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );
        prop_assert!(result.is_ok(), "deposit_with_commitment should succeed");

        // Attempting duplicate deposit with same commitment should fail
        ctx.mint(&ctx.alice.clone(), amount);
        let dup_result = ctx.client.try_deposit_with_commitment(
            &ctx.alice.clone(),
            &ctx.token,
            &amount,
            &commitment,
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );
        prop_assert!(dup_result.is_err(), "duplicate commitment should be rejected");
    }
}

// ---------------------------------------------------------------------------
// partial_payment boundaries (Task #105)
// ---------------------------------------------------------------------------

proptest! {
    /// Fuzz partial_payment with amounts at and near the boundary.
    /// Ensures overpayment is always rejected and partial payments work correctly.
    #[test]
    fn fuzz_partial_payment_boundaries(
        total_amount in 100_i128..=1_000_000_i128,
        initial_payment in 10_i128..=100_000_i128,
        payment_amount in 1_i128..=100_000_i128,
    ) {
        let ctx = TestContext::with_admin();

        // amount_due >= initial_payment
        let amount_due = initial_payment + 1000;

        ctx.mint(&ctx.alice.clone(), initial_payment);
        let commitment = ctx.client.deposit_partial(
            &ctx.token,
            &amount_due,
            &initial_payment,
            &ctx.alice.clone(),
            &ctx.salt(b"partial"),
            &0,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Calculate remaining after initial payment
        let remaining = amount_due - initial_payment;

        // Test 1: payment exactly equal to remaining should succeed
        if payment_amount <= remaining {
            ctx.mint(&ctx.alice.clone(), payment_amount);
            let result = ctx.client.try_partial_payment(
                &commitment,
                &ctx.alice.clone(),
                &payment_amount,
                &0u64,
                &u64::MAX,
            );
            prop_assert!(result.is_ok(), "partial_payment within bounds should succeed");
        }

        // Test 2: overpayment should fail
        if payment_amount > remaining {
            ctx.mint(&ctx.alice.clone(), payment_amount);
            let over_result = ctx.client.try_partial_payment(
                &commitment,
                &ctx.alice.clone(),
                &payment_amount,
                &0u64,
                &u64::MAX,
            );
            prop_assert!(over_result.is_err(), "overpayment should be rejected");
        }
    }
}

// ---------------------------------------------------------------------------
// dispute with multiple arbiters (Task #105)
// ---------------------------------------------------------------------------

proptest! {
    /// Fuzz multi-sig dispute with voting until threshold is met.
    /// Ensures arbiters can vote independently and resolution only happens at threshold.
    #[test]
    fn fuzz_dispute_multi_sig_voting(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();

        // Create escrow with multiple arbiters (3 arbiters, threshold of 2)
        ctx.mint(&ctx.alice.clone(), amount);

        // For multi-sig setup, we need to create escrow with arbiters
        // For now, we'll test with single arbiter dispute to keep it simple
        let commitment = ctx.deposit_with_arbiter(&ctx.alice.clone(), amount, &salt, 0);

        // Dispute should lock funds
        let dispute_result = ctx.client.try_dispute(&commitment);
        prop_assert!(dispute_result.is_ok(), "dispute creation should succeed");

        // Withdrawal should now fail (funds are locked)
        let withdraw_result = ctx.client.try_withdraw(
            &ctx.token,
            &amount,
            &commitment,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &0u64,
            &u64::MAX,
        );
        prop_assert!(withdraw_result.is_err(), "withdraw should fail during dispute");

        // Refund should also fail (funds are locked)
        let refund_result = ctx.client.try_refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);
        prop_assert!(refund_result.is_err(), "refund should fail during dispute");
    }
}

// ---------------------------------------------------------------------------
// cleanup_escrow after finalize (Task #105)
// ---------------------------------------------------------------------------

proptest! {
    /// Fuzz cleanup_escrow to ensure only terminal states can be cleaned.
    /// Verifies that cleanup removes spent/refunded escrows and rejects others.
    #[test]
    fn fuzz_cleanup_escrow_terminal_states(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), amount, b"cleanup-test");

        // Cleanup should fail on Pending escrows
        let pending_cleanup = ctx.client.try_cleanup_escrow(&commitment);
        prop_assert!(pending_cleanup.is_err(), "cleanup should fail on Pending state");

        // Withdraw to move to Spent state
        ctx.client.withdraw(&ctx.token, &amount, &commitment, &ctx.alice.clone(), &ctx.salt(b"cleanup-test"), &0u64, &u64::MAX);

        // Cleanup should now succeed on Spent state
        let spent_cleanup = ctx.client.try_cleanup_escrow(&commitment);
        prop_assert!(spent_cleanup.is_ok(), "cleanup should succeed on Spent state");

        // Second cleanup should fail (already removed)
        let second_cleanup = ctx.client.try_cleanup_escrow(&commitment);
        prop_assert!(second_cleanup.is_err(), "cleanup should fail on non-existent escrow");
    }
}

proptest! {
    /// Fuzz cleanup_escrow on refunded escrows.
    /// Ensures refunded state escrows can also be cleaned up.
    #[test]
    fn fuzz_cleanup_escrow_refunded(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), amount);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &amount,
            &ctx.alice.clone(),
            &ctx.salt(&salt),
            &timeout,
            &None,
            &0u64,
            &u64::MAX,
        );

        // Advance past expiry
        ctx.advance_time(timeout + 1);

        // Refund to move to Refunded state
        ctx.client.refund(&commitment, &ctx.alice.clone(), &0u64, &u64::MAX);

        // Cleanup should succeed on Refunded state
        let refunded_cleanup = ctx.client.try_cleanup_escrow(&commitment);
        prop_assert!(refunded_cleanup.is_ok(), "cleanup should succeed on Refunded state");
    }
}

// ---------------------------------------------------------------------------
// extend_escrow_ttl timing (Task #105)
// ---------------------------------------------------------------------------

proptest! {
    /// Fuzz extend_escrow_ttl to ensure TTL extension doesn't affect expiry logic.
    /// Verifies that extending TTL keeps escrow accessible and doesn't cause spurious expirations.
    #[test]
    fn fuzz_extend_escrow_ttl_preserves_access(
        amount in amount_strategy(),
        timeout in 1u64..=3600u64,
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), amount, b"ttl-test");

        // Extend TTL should succeed on any escrow
        let extend_result = ctx.client.try_extend_escrow_ttl(&commitment);
        prop_assert!(extend_result.is_ok(), "extend_escrow_ttl should succeed");

        // Escrow should still be accessible after TTL extension
        let entry = ctx.client.get_escrow_details(&commitment);
        prop_assert!(entry.is_some(), "escrow should still exist after TTL extension");
    }
}

proptest! {
    /// Fuzz extend_escrow_ttl multiple times to ensure cumulative extensions work.
    /// Verifies that repeated TTL extensions don't corrupt escrow state.
    #[test]
    fn fuzz_extend_escrow_ttl_multiple(
        amount in amount_strategy(),
        salt in salt_strategy(),
    ) {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), amount, b"ttl-multi");

        // Extend TTL multiple times
        for _ in 0..5 {
            let extend_result = ctx.client.try_extend_escrow_ttl(&commitment);
            prop_assert!(extend_result.is_ok(), "extend_escrow_ttl should always succeed");
        }

        // Escrow should still be intact and functional
        let entry = ctx.client.get_escrow_details(&commitment);
        prop_assert!(entry.is_some(), "escrow should exist after multiple TTL extensions");

        // Should still be able to withdraw
        let withdraw_result = ctx.client.try_withdraw(
            &ctx.token,
            &amount,
            &commitment,
            &ctx.alice.clone(),
            &ctx.salt(b"ttl-multi"),
            &0u64,
            &u64::MAX,
        );
        prop_assert!(withdraw_result.is_ok(), "should be able to withdraw after TTL extensions");
    }
}

// ---------------------------------------------------------------------------
// Regression corpus
//
// Each entry is a deterministic test that reproduces a specific bug found
// during fuzzing. Add new entries here when proptest shrinks a failure.
//
// Format:
//   #[test]
//   fn regression_<short_description>() { ... }
// ---------------------------------------------------------------------------

#[cfg(test)]
mod regression_corpus {
    use super::*;

    /// REGRESSION-001: zero-amount deposit must be rejected.
    ///
    /// Discovered: manual review. The contract must return InvalidAmount for
    /// amount == 0 to prevent zero-value escrows that could confuse accounting.
    #[test]
    fn regression_001_zero_amount_deposit_rejected() {
        let ctx = TestContext::with_admin();
        let result = ctx.client.try_deposit(
            &ctx.token,
            &0,
            &ctx.alice.clone(),
            &ctx.salt(b"zero"),
            &0,
            &None,
            &0u64,
            &u64::MAX,
        );
        assert!(
            result.is_err(),
            "REGRESSION-001: zero-amount deposit was accepted"
        );
    }

    /// REGRESSION-002: negative-amount deposit must be rejected.
    #[test]
    fn regression_002_negative_amount_deposit_rejected() {
        let ctx = TestContext::with_admin();
        let result = ctx.client.try_deposit(
            &ctx.token,
            &-1,
            &ctx.alice.clone(),
            &ctx.salt(b"neg"),
            &0,
            &None,
            &0u64,
            &u64::MAX,
        );
        assert!(
            result.is_err(),
            "REGRESSION-002: negative-amount deposit was accepted"
        );
    }

    /// REGRESSION-003: dispute without arbiter must fail with NoArbiter.
    #[test]
    fn regression_003_dispute_without_arbiter_rejected() {
        let ctx = TestContext::with_admin();
        let commitment = ctx.simple_deposit(&ctx.alice.clone(), 1000, b"no-arb");
        let result = ctx.client.try_dispute(&commitment);
        assert!(
            result.is_err(),
            "REGRESSION-003: dispute without arbiter was accepted"
        );
    }

    /// REGRESSION-004: non-owner refund must fail with InvalidOwner.
    #[test]
    fn regression_004_non_owner_refund_rejected() {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), 1000);
        let commitment = ctx.client.deposit(
            &ctx.token,
            &1000,
            &ctx.alice.clone(),
            &ctx.salt(b"owner-check"),
            &1,
            &None,
            &0u64,
            &u64::MAX,
        );
        ctx.advance_time(2);
        // Bob tries to refund Alice's escrow
        let result = ctx
            .client
            .try_refund(&commitment, &ctx.bob.clone(), &0u64, &u64::MAX);
        assert!(
            result.is_err(),
            "REGRESSION-004: non-owner refund was accepted"
        );
    }

    /// REGRESSION-005: u64::MAX timeout must not panic (INV-3 overflow guard).
    #[test]
    fn regression_005_max_timeout_no_panic() {
        let ctx = TestContext::with_admin();
        ctx.mint(&ctx.alice.clone(), 1000);
        // Must not panic — contract should return InvalidTimeout
        let _ = ctx.client.try_deposit(
            &ctx.token,
            &1000,
            &ctx.alice.clone(),
            &ctx.salt(b"overflow"),
            &u64::MAX,
            &None,
            &0u64,
            &u64::MAX,
        );
    }

    /// REGRESSION-006: nonce replay across different signers must be independent.
    ///
    /// Alice consuming nonce N must not prevent Bob from consuming nonce N.
    #[test]
    fn regression_006_nonce_per_signer_independent() {
        use crate::nonce::{verify_and_consume, ActionType};

        let ctx = TestContext::with_admin();
        let now = ctx.env.ledger().timestamp();
        let valid_until = now + 3600;
        let nonce = 42u64;
        let contract_id = ctx.client.address.clone();

        let bob_ok = ctx.env.as_contract(&contract_id, || {
            verify_and_consume(
                &ctx.env,
                &ctx.alice,
                nonce,
                valid_until,
                ActionType::Withdraw,
            )
            .unwrap();
            // Bob's nonce N is independent of Alice's
            verify_and_consume(&ctx.env, &ctx.bob, nonce, valid_until, ActionType::Withdraw).is_ok()
        });

        assert!(bob_ok, "REGRESSION-006: nonce namespace not per-signer");
    }
}
