use crate::errors::QuickexError;
use crate::events;
use crate::storage;
use crate::types::{GovernanceAction, GovernanceConfig, GovernanceProposal};
use soroban_sdk::{Address, Env, Vec};

pub const MIN_TIMELOCK_SECS: u64 = 86_400;
const MIN_SIGNERS: u32 = 2;
const MAX_SIGNERS: u32 = 16;

fn validate_signers(signers: &Vec<Address>, threshold: u32) -> Result<(), QuickexError> {
    let count = signers.len();
    if count < MIN_SIGNERS || count > MAX_SIGNERS || threshold < 2 || threshold > count {
        return Err(QuickexError::InvalidGovernanceConfig);
    }

    let mut left = 0;
    while left < count {
        let signer = signers
            .get(left)
            .ok_or(QuickexError::InvalidGovernanceConfig)?;
        let mut right = left + 1;
        while right < count {
            if signers.get(right).as_ref() == Some(&signer) {
                return Err(QuickexError::InvalidGovernanceConfig);
            }
            right += 1;
        }
        left += 1;
    }
    Ok(())
}

fn require_signer<'a>(
    env: &'a Env,
    caller: &'a Address,
) -> Result<GovernanceConfig, QuickexError> {
    let config = storage::get_governance_config(env)
        .ok_or(QuickexError::InvalidGovernanceConfig)?;
    if !config.signers.contains(caller) {
        return Err(QuickexError::NotGovernanceSigner);
    }
    caller.require_auth();
    Ok(config)
}

fn without_signer(env: &Env, signers: &Vec<Address>, excluded: &Address) -> Vec<Address> {
    let mut filtered = Vec::new(env);
    for signer in signers.clone() {
        if signer != *excluded {
            filtered.push_back(signer);
        }
    }
    filtered
}

fn current_signers(signers: &Vec<Address>, config: &GovernanceConfig, env: &Env) -> Vec<Address> {
    let mut filtered = Vec::new(env);
    for signer in signers.clone() {
        if config.signers.contains(&signer) {
            filtered.push_back(signer);
        }
    }
    filtered
}

pub fn initialize(
    env: &Env,
    caller: &Address,
    signers: Vec<Address>,
    threshold: u32,
    timelock_secs: u64,
) -> Result<(), QuickexError> {
    if storage::governance_is_initialized(env) {
        return Err(QuickexError::GovernanceAlreadyInitialized);
    }
    crate::admin::require_admin(env, caller)?;
    validate_signers(&signers, threshold)?;
    if timelock_secs < MIN_TIMELOCK_SECS {
        return Err(QuickexError::InvalidGovernanceConfig);
    }

    let config = GovernanceConfig {
        signers,
        threshold,
        timelock_secs,
    };
    storage::set_governance_config(env, &config);
    events::publish_governance_config_changed(env, &config);
    Ok(())
}

pub fn get_config(env: &Env) -> Option<GovernanceConfig> {
    storage::get_governance_config(env)
}

pub fn get_proposal(env: &Env, proposal_id: u64) -> Option<GovernanceProposal> {
    storage::get_governance_proposal(env, proposal_id)
}

fn validate_action(env: &Env, action: &GovernanceAction) -> Result<(), QuickexError> {
    match action {
        GovernanceAction::SetUpgradeWindow(start, end) if *end != 0 && *end <= *start => {
            Err(QuickexError::InvalidUpgradeWindow)
        }
        GovernanceAction::RotateSigners(signers, threshold) => validate_signers(signers, *threshold),
        GovernanceAction::SetTimelock(seconds) if *seconds < MIN_TIMELOCK_SECS => {
            Err(QuickexError::InvalidGovernanceConfig)
        }
        GovernanceAction::Upgrade(_, version) => {
            if storage::is_upgrade_in_progress(env) {
                return Err(QuickexError::UpgradeAlreadyInProgress);
            }
            if *version == 0 {
                return Err(QuickexError::InvalidContractVersion);
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn propose(
    env: &Env,
    proposer: &Address,
    action: GovernanceAction,
) -> Result<u64, QuickexError> {
    let config = require_signer(env, proposer)?;
    validate_action(env, &action)?;
    let proposal_id = storage::next_governance_proposal_id(env)
        .ok_or(QuickexError::InternalError)?;
    let execute_after = env
        .ledger()
        .timestamp()
        .checked_add(config.timelock_secs)
        .ok_or(QuickexError::InvalidTimeout)?;
    let mut approvals = Vec::new(env);
    approvals.push_back(proposer.clone());
    let proposal = GovernanceProposal {
        action,
        proposer: proposer.clone(),
        approvals,
        cancellation_votes: Vec::new(env),
        execute_after,
        executed: false,
        canceled: false,
    };
    storage::set_governance_proposal(env, proposal_id, &proposal);
    events::publish_governance_proposal_created(
        env,
        proposal_id,
        proposer.clone(),
        proposal.action.clone(),
        execute_after,
    );
    Ok(proposal_id)
}

pub fn approve(
    env: &Env,
    signer: &Address,
    proposal_id: u64,
) -> Result<u32, QuickexError> {
    let config = require_signer(env, signer)?;
    let mut proposal = storage::get_governance_proposal(env, proposal_id)
        .ok_or(QuickexError::ProposalNotFound)?;
    if proposal.executed {
        return Err(QuickexError::ProposalAlreadyExecuted);
    }
    if proposal.canceled {
        return Err(QuickexError::ProposalCanceled);
    }
    proposal.approvals = current_signers(&proposal.approvals, &config, env);
    proposal.cancellation_votes = current_signers(&proposal.cancellation_votes, &config, env);
    if proposal.approvals.contains(signer) {
        return Err(QuickexError::ProposalAlreadyApproved);
    }
    if proposal.cancellation_votes.contains(signer) {
        proposal.cancellation_votes = without_signer(env, &proposal.cancellation_votes, signer);
    }
    proposal.approvals.push_back(signer.clone());
    let count = proposal.approvals.len();
    storage::set_governance_proposal(env, proposal_id, &proposal);
    events::publish_governance_proposal_approved(env, proposal_id, signer.clone(), count);
    Ok(count)
}

pub fn vote_to_cancel(
    env: &Env,
    signer: &Address,
    proposal_id: u64,
) -> Result<bool, QuickexError> {
    let config = require_signer(env, signer)?;
    let mut proposal = storage::get_governance_proposal(env, proposal_id)
        .ok_or(QuickexError::ProposalNotFound)?;
    if proposal.executed {
        return Err(QuickexError::ProposalAlreadyExecuted);
    }
    if proposal.canceled {
        return Err(QuickexError::ProposalCanceled);
    }
    proposal.approvals = current_signers(&proposal.approvals, &config, env);
    proposal.cancellation_votes = current_signers(&proposal.cancellation_votes, &config, env);
    if proposal.cancellation_votes.contains(signer) {
        return Err(QuickexError::InvalidProposal);
    }
    proposal.approvals = without_signer(env, &proposal.approvals, signer);
    proposal.cancellation_votes.push_back(signer.clone());
    let vote_count = proposal.cancellation_votes.len();
    let canceled = vote_count >= config.threshold;
    proposal.canceled = canceled;
    storage::set_governance_proposal(env, proposal_id, &proposal);
    events::publish_governance_cancellation_vote(
        env,
        proposal_id,
        signer.clone(),
        vote_count,
        config.threshold,
    );
    if canceled {
        events::publish_governance_proposal_canceled(env, proposal_id, signer.clone());
    }
    Ok(canceled)
}

pub fn execute(env: &Env, proposal_id: u64) -> Result<(), QuickexError> {
    let config = storage::get_governance_config(env)
        .ok_or(QuickexError::InvalidGovernanceConfig)?;
    let mut proposal = storage::get_governance_proposal(env, proposal_id)
        .ok_or(QuickexError::ProposalNotFound)?;
    if proposal.executed {
        return Err(QuickexError::ProposalAlreadyExecuted);
    }
    if proposal.canceled {
        return Err(QuickexError::ProposalCanceled);
    }
    let mut active_approvals = 0;
    let approvals = proposal.approvals.clone();
    for approved_signer in approvals {
        if config.signers.contains(&approved_signer) {
            active_approvals += 1;
        }
    }
    if active_approvals < config.threshold {
        return Err(QuickexError::InsufficientApprovals);
    }
    if env.ledger().timestamp() < proposal.execute_after {
        return Err(QuickexError::TimelockNotElapsed);
    }
    validate_action(env, &proposal.action)?;

    let authority = storage::get_admin(env).ok_or(QuickexError::Unauthorized)?;
    storage::set_governance_execution(env, true);
    apply_action(env, &authority, &config, &proposal.action)?;
    storage::set_governance_execution(env, false);

    proposal.executed = true;
    storage::set_governance_proposal(env, proposal_id, &proposal);
    events::publish_governance_proposal_executed(env, proposal_id);
    Ok(())
}

fn apply_action(
    env: &Env,
    authority: &Address,
    current_config: &GovernanceConfig,
    action: &GovernanceAction,
) -> Result<(), QuickexError> {
    match action {
        GovernanceAction::SetAdmin(new_admin) => {
            crate::admin::set_admin(env, authority.clone(), new_admin.clone())
        }
        GovernanceAction::GrantRole(target, role) => {
            crate::admin::grant_role(env, authority.clone(), target.clone(), *role)
        }
        GovernanceAction::RevokeRole(target, role) => {
            crate::admin::revoke_role(env, authority.clone(), target.clone(), *role)
        }
        GovernanceAction::SetPaused(paused, reason) => {
            crate::admin::set_paused(env, authority.clone(), *paused, *reason)
        }
        GovernanceAction::SetPauseFlags(enable, disable, reason, event_reason) => {
            crate::admin::set_pause_flags(env, authority, *enable, *disable, *reason, *event_reason)
        }
        GovernanceAction::SetFeeConfig(config) => {
            crate::admin::set_fee_config(env, authority, *config)
        }
        GovernanceAction::SetPerAssetFee(token, config) => {
            crate::admin::set_per_asset_fee(env, authority, token.clone(), *config)
        }
        GovernanceAction::SetOracleFeeConfig(config) => {
            crate::admin::set_oracle_fee_config(env, authority, config.clone())
        }
        GovernanceAction::RecordOraclePrice(price_micros) => {
            crate::admin::require_admin(env, authority)?;
            crate::oracle::record_price(env, *price_micros)
        }
        GovernanceAction::SetPlatformWallet(wallet) => {
            crate::admin::set_platform_wallet(env, authority, wallet.clone())
        }
        GovernanceAction::RotateFeeCollector(collector) => {
            crate::admin::rotate_fee_collector(env, authority, collector.clone()).map(|_| ())
        }
        GovernanceAction::SetHookAllowed(contract, allowed) => {
            crate::admin::set_hook_allowed(env, authority, contract.clone(), *allowed)
        }
        GovernanceAction::RegisterHook(contract) => {
            crate::admin::require_admin(env, authority)?;
            crate::hook::register_hook(env, contract.clone())
        }
        GovernanceAction::UnregisterHook(contract) => {
            crate::admin::require_admin(env, authority)?;
            crate::hook::unregister_hook(env, contract.clone())
        }
        GovernanceAction::SetUpgradeWindow(start, end) => {
            crate::admin::set_upgrade_window(env, authority, *start, *end)
        }
        GovernanceAction::RotateSigners(signers, threshold) => {
            validate_signers(signers, *threshold)?;
            let updated_config = GovernanceConfig {
                signers: signers.clone(),
                threshold: *threshold,
                timelock_secs: current_config.timelock_secs,
            };
            storage::set_governance_config(env, &updated_config);
            events::publish_governance_config_changed(env, &updated_config);
            Ok(())
        }
        GovernanceAction::SetTimelock(timelock_secs) => {
            if *timelock_secs < MIN_TIMELOCK_SECS {
                return Err(QuickexError::InvalidGovernanceConfig);
            }
            let updated_config = GovernanceConfig {
                signers: current_config.signers.clone(),
                threshold: current_config.threshold,
                timelock_secs: *timelock_secs,
            };
            storage::set_governance_config(env, &updated_config);
            events::publish_governance_config_changed(env, &updated_config);
            Ok(())
        }
        GovernanceAction::Upgrade(wasm_hash, version) => {
            if !storage::is_upgrade_window_active(env) {
                return Err(QuickexError::InvalidUpgradeWindow);
            }
            if storage::is_upgrade_in_progress(env) {
                return Err(QuickexError::UpgradeAlreadyInProgress);
            }
            storage::set_pending_upgrade_version(env, *version);
            storage::set_upgrade_in_progress(env, true);
            storage::set_wasm_hash(env, wasm_hash);
            let (window_start, window_end) = storage::get_upgrade_window(env);
            events::publish_upgrade_started(
                env,
                authority,
                crate::admin::get_version(env),
                *version,
                window_start,
                window_end,
            );
            env.deployer()
                .update_current_contract_wasm(wasm_hash.clone());
            events::publish_contract_upgraded(env, wasm_hash.clone(), authority);
            Ok(())
        }
    }
}

pub fn is_active_signer(env: &Env, signer: &Address) -> bool {
    storage::get_governance_config(env)
        .map(|config| config.signers.contains(signer))
        .unwrap_or(false)
}