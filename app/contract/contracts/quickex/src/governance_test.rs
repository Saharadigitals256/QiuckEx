use crate::{
    errors::QuickexError,
    governance::MIN_TIMELOCK_SECS,
    types::{FeeConfig, GovernanceAction},
    QuickexContract, QuickexContractClient,
};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

struct GovernanceContext<'a> {
    env: Env,
    client: QuickexContractClient<'a>,
    admin: Address,
    signers: Vec<Address>,
}

fn setup<'a>() -> GovernanceContext<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(QuickexContract, ());
    let client = QuickexContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let third = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, first, second, third];
    client.initialize(&admin);
    client.initialize_governance(&admin, &signers, &2, &MIN_TIMELOCK_SECS);
    GovernanceContext {
        env,
        client,
        admin,
        signers,
    }
}

fn advance_to_execution(ctx: &GovernanceContext, proposal_id: u64) {
    let proposal = ctx
        .client
        .get_governance_proposal(&proposal_id)
        .expect("proposal exists");
    ctx.env.ledger().with_mut(|ledger| {
        ledger.timestamp = proposal.execute_after;
    });
}

#[test]
fn proposal_requires_quorum_and_timelock_before_execution() {
    let ctx = setup();
    let first = ctx.signers.get(0).unwrap();
    let second = ctx.signers.get(1).unwrap();
    let proposal_id = ctx.client.propose_governance_action(
        &first,
        &GovernanceAction::SetFeeConfig(FeeConfig { fee_bps: 250 }),
    );

    assert_eq!(
        ctx.client.try_execute_governance_proposal(&proposal_id),
        Err(Ok(QuickexError::InsufficientApprovals))
    );
    ctx.client
        .approve_governance_proposal(&second, &proposal_id);
    assert_eq!(
        ctx.client
            .try_approve_governance_proposal(&second, &proposal_id),
        Err(Ok(QuickexError::ProposalAlreadyApproved))
    );
    assert_eq!(
        ctx.client.try_execute_governance_proposal(&proposal_id),
        Err(Ok(QuickexError::TimelockNotElapsed))
    );

    advance_to_execution(&ctx, proposal_id);
    ctx.client.execute_governance_proposal(&proposal_id);
    assert_eq!(ctx.client.get_fee_config().fee_bps, 250);
    assert_eq!(
        ctx.client.try_set_fee_config(
            &ctx.admin,
            &FeeConfig { fee_bps: 300 }
        ),
        Err(Ok(QuickexError::GovernanceRequired))
    );
    assert_eq!(
        ctx.client.try_migrate(&ctx.admin),
        Err(Ok(QuickexError::GovernanceRequired))
    );
}

#[test]
fn proposal_cancellation_requires_quorum_and_blocks_execution() {
    let ctx = setup();
    let first = ctx.signers.get(0).unwrap();
    let second = ctx.signers.get(1).unwrap();
    let proposal_id = ctx.client.propose_governance_action(
        &first,
        &GovernanceAction::SetFeeConfig(FeeConfig { fee_bps: 400 }),
    );

    assert!(!ctx
        .client
        .vote_to_cancel_governance_proposal(&first, &proposal_id));
    assert!(ctx
        .client
        .vote_to_cancel_governance_proposal(&second, &proposal_id));
    advance_to_execution(&ctx, proposal_id);
    assert_eq!(
        ctx.client.try_execute_governance_proposal(&proposal_id),
        Err(Ok(QuickexError::ProposalCanceled))
    );
    assert_eq!(ctx.client.get_fee_config().fee_bps, 0);
}

#[test]
fn signer_rotation_is_delayed_and_old_signers_lose_authority() {
    let ctx = setup();
    let first = ctx.signers.get(0).unwrap();
    let second = ctx.signers.get(1).unwrap();
    let replacement = Address::generate(&ctx.env);
    let new_signers = soroban_sdk::vec![&ctx.env, second.clone(), replacement.clone()];
    let proposal_id = ctx.client.propose_governance_action(
        &first,
        &GovernanceAction::RotateSigners(new_signers, 2),
    );
    ctx.client
        .approve_governance_proposal(&second, &proposal_id);
    advance_to_execution(&ctx, proposal_id);
    ctx.client.execute_governance_proposal(&proposal_id);

    assert_eq!(
        ctx.client.try_propose_governance_action(
            &first,
            &GovernanceAction::SetFeeConfig(FeeConfig { fee_bps: 500 })
        ),
        Err(Ok(QuickexError::NotGovernanceSigner))
    );
    let next_proposal = ctx.client.propose_governance_action(
        &replacement,
        &GovernanceAction::SetFeeConfig(FeeConfig { fee_bps: 500 }),
    );
    assert!(ctx
        .client
        .get_governance_proposal(&next_proposal)
        .is_some());
}

#[test]
fn bootstrap_rejects_duplicate_signers_and_subminimum_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(QuickexContract, ());
    let client = QuickexContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let signer = Address::generate(&env);
    client.initialize(&admin);

    let duplicate_signers = soroban_sdk::vec![&env, signer.clone(), signer];
    assert_eq!(
        client.try_initialize_governance(
            &admin,
            &duplicate_signers,
            &2,
            &MIN_TIMELOCK_SECS
        ),
        Err(Ok(QuickexError::InvalidGovernanceConfig))
    );
    let valid_signers = soroban_sdk::vec![&env, Address::generate(&env), Address::generate(&env)];
    assert_eq!(
        client.try_initialize_governance(&admin, &valid_signers, &2, &(MIN_TIMELOCK_SECS - 1)),
        Err(Ok(QuickexError::InvalidGovernanceConfig))
    );
}

#[test]
fn upgrade_window_errors_have_dedicated_codes() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(QuickexContract, ());
    let client = QuickexContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(
        client.try_set_upgrade_window(&admin, &10, &10),
        Err(Ok(QuickexError::InvalidUpgradeWindow))
    );
    assert_eq!(
        client.try_start_upgrade(&admin, &1),
        Err(Ok(QuickexError::InvalidAmount))
    );
}

#[test]
fn approved_upgrade_still_requires_an_active_window() {
    let ctx = setup();
    let first = ctx.signers.get(0).unwrap();
    let second = ctx.signers.get(1).unwrap();
    let wasm_hash = soroban_sdk::BytesN::from_array(&ctx.env, &[0xabu8; 32]);
    let proposal_id = ctx.client.propose_governance_action(
        &first,
        &GovernanceAction::Upgrade(wasm_hash, 1),
    );
    ctx.client
        .approve_governance_proposal(&second, &proposal_id);
    advance_to_execution(&ctx, proposal_id);

    assert_eq!(
        ctx.client.try_execute_governance_proposal(&proposal_id),
        Err(Ok(QuickexError::InvalidUpgradeWindow))
    );
    assert!(!ctx
        .client
        .get_governance_proposal(&proposal_id)
        .unwrap()
        .executed);
}