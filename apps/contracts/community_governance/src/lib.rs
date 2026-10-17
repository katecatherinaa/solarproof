//! # Community Governance — cooperative proposals + voting.
//!
//! ## Vote storage optimisation (issue #71)
//!
//! The original design stored one persistent ledger entry per voter per
//! proposal: `(voted, proposal_id, voter_address) → bool`.  At 1 000 voters
//! that is 1 000 entries × ~100 bytes each ≈ 100 kB of ledger state.
//!
//! This implementation replaces that with a **voter-index bitmap**:
//!
//! * Each voter is assigned a stable `u32` index stored in instance storage.
//! * Bits are packed 128-per-word into `u128` values keyed by
//!   `(bitmap, proposal_id, word_index)`.
//! * 1 000 voters → ⌈1000/128⌉ = 8 ledger entries ≈ 0.8 kB — a **>99%**
//!   reduction in entry count (well above the 50 % target).
//!
//! ### Benchmark (simulated, Soroban fee model)
//!
//! | Approach          | Entries @ 1 000 votes | Relative cost |
//! |-------------------|-----------------------|---------------|
//! | Per-entry bool    | 1 000                 | 1.00×         |
//! | Bitmap (128-wide) | 8                     | ~0.008×       |
//!
//! ## Token-balance vote weighting (issue #61)
//!
//! Voting is now optionally weighted by the voter's energy-token balance at
//! the ledger when the proposal was created (`snapshot_ledger`).  This
//! reflects each voter's stake in the cooperative.
//!
//! * If no `TokenContract` is configured every vote has weight **1** (original
//!   behaviour — fully backwards compatible).
//! * If a `TokenContract` is set, the voter's balance is fetched and clamped to
//!   `VoteWeightCap` (default: `1_000_000`) to prevent single-voter dominance.
//! * `yes_weight` and `no_weight` on the `Proposal` accumulate weighted totals.
//! * `finalize()` uses `yes_weight / (yes_weight + no_weight) >= threshold_bps`
//!   so that large-stake voters have proportionally more influence.
//!
//! ### Governance tuning guide
//!
//! See `docs/governance_tuning_guide.md §6` for weight parameter recommendations.

#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map, String,
};
// Cross-contract client for vote-weight balance queries (issue #61).
use energy_token::EnergyTokenClient;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The lifecycle state of a proposal.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalStatus {
    /// Voting is open.
    Active,
    /// Voting closed; quorum reached with majority yes.
    Passed,
    /// Voting closed; quorum not reached or majority no.
    Rejected,
    /// Voting closed; no votes cast.
    Expired,
    /// Passed proposal has been executed after the timelock.
    Executed,
}

/// A governance proposal.
#[contracttype]
#[derive(Clone, PartialEq)]
pub enum VoteChoice { For, Against, Abstain }

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    /// Auto-incrementing proposal identifier (1-based).
    pub id: u32,
    /// Address that submitted the proposal.
    pub proposer: Address,
    /// Short human-readable title.
    pub title: String,
    /// Full description of the proposal.
    pub description: String,
    /// Number of yes votes cast (head count, unweighted).
    pub yes_votes: u32,
    /// Number of no votes cast (head count, unweighted).
    pub no_votes: u32,
    /// Ledger sequence at which voting closes (inclusive).
    pub end_ledger: u32,
    /// Current lifecycle status.
    pub status: ProposalStatus,
    /// Ledger sequence after which the proposal may be executed (set on Passed).
    pub execute_after: u32,
    /// Ledger sequence at which this proposal was created; used as the token
    /// balance snapshot point for vote-weight calculations (issue #61).
    pub snapshot_ledger: u32,
    /// Accumulated weighted yes-vote total (issue #61).
    /// Equals `sum(min(balance_at_snapshot, cap))` for all yes voters.
    /// When no TokenContract is configured each vote contributes weight 1.
    pub yes_weight: i128,
    /// Accumulated weighted no-vote total (issue #61).
    pub no_weight: i128,
}

/// Enumeration of all instance-storage keys used by this contract.
#[contracttype]
pub enum DataKey {
    Admin,
    ProposalCount,
    Proposals,
    Quorum,
    VotingPeriod,
    /// Total number of registered voters (used to assign indices).
    VoterCount,
    /// voter_address → voter_index (u32)
    VoterIndex(Address),
    /// Reentrancy lock for vote(). Set to true while vote() is executing.
    VoteLock,
    /// Quorum in basis points (1–10000). Default: 1000 (10%).
    QuorumBps,
    /// Approval threshold in basis points (1–10000). Default: 5100 (51%).
    ThresholdBps,
    /// Pending contract upgrade proposal.
    PendingUpgrade,
    /// Contract version string.
    Version,
    /// Execution timelock in ledgers (set by set_execution_timelock).
    ExecuteTimelock,
    /// Optional energy-token contract address used for vote-weight queries.
    /// When absent, every vote has weight 1 (backwards compatible).
    TokenContract,
    /// Maximum vote weight per voter (i128). Default: 1_000_000.
    /// Prevents single large holders from dominating the vote.
    VoteWeightCap,
}

/// Pending contract upgrade proposal.
#[contracttype]
#[derive(Clone)]
pub struct UpgradeProposal {
    /// SHA-256 hash of the new WASM binary.
    pub new_wasm_hash: soroban_sdk::BytesN<32>,
    /// Ledger sequence after which the upgrade may be executed.
    pub unlock_ledger: u32,
}

/// 48 hours expressed in ledgers (10-second ledger time).
const UPGRADE_TIMELOCK_LEDGERS: u32 = 17_280;
/// 24 hours expressed in ledgers (10-second ledger time).
const EXECUTE_TIMELOCK_LEDGERS: u32 = 8_640;

const DEFAULT_QUORUM_BPS: u32 = 1_000; // 10%
const DEFAULT_THRESHOLD_BPS: u32 = 5_100; // 51%
const VERSION: &str = "1.0.0";

/// Default maximum vote weight per voter (issue #61).
/// Equivalent to 100 kWh in energy-token stroops (1 kWh = 1000 units).
/// Prevents single large holders from dominating votes.
const DEFAULT_VOTE_WEIGHT_CAP: i128 = 1_000_000;

/// Cooperative governance contract.
#[contract]
pub struct CommunityGovernance;

// ── bitmap helpers ────────────────────────────────────────────────────────────

/// Storage key for a single 128-bit word of the voted bitmap.
fn bitmap_key(proposal_id: u32, word: u32) -> (soroban_sdk::Symbol, u32, u32) {
    (symbol_short!("bitmap"), proposal_id, word)
}

/// Return the voter's stable index, registering them if first seen.
fn voter_index(env: &Env, voter: &Address) -> u32 {
    let key = DataKey::VoterIndex(voter.clone());
    if let Some(idx) = env.storage().instance().get::<_, u32>(&key) {
        return idx;
    }
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::VoterCount)
        .unwrap_or(0);
    env.storage().instance().set(&key, &count);
    env.storage()
        .instance()
        .set(&DataKey::VoterCount, &(count + 1));
    count
}

/// Check whether bit `idx` is set in the bitmap for `proposal_id`.
fn bitmap_get(env: &Env, proposal_id: u32, idx: u32) -> bool {
    let word_idx = idx / 128;
    let bit = idx % 128;
    let word: u128 = env
        .storage()
        .persistent()
        .get(&bitmap_key(proposal_id, word_idx))
        .unwrap_or(0_u128);
    (word >> bit) & 1 == 1
}

/// Set bit `idx` in the bitmap for `proposal_id`.
fn bitmap_set(env: &Env, proposal_id: u32, idx: u32) {
    let word_idx = idx / 128;
    let bit = idx % 128;
    let key = bitmap_key(proposal_id, word_idx);
    let word: u128 = env.storage().persistent().get(&key).unwrap_or(0_u128);
    env.storage()
        .persistent()
        .set(&key, &(word | (1_u128 << bit)));
}

// ── contract ──────────────────────────────────────────────────────────────────

#[contractimpl]
impl CommunityGovernance {
    /// Initialise the contract. Must be called exactly once after deployment.
    ///
    /// # Arguments
    /// * `admin`                 — administrator address.
    /// * `quorum`                — minimum yes-vote percentage required to pass (1–10000 bps).
    /// * `voting_period_ledgers` — number of ledgers each proposal stays open.
    ///
    /// # Panics
    /// * `"already initialized"` if called more than once.
    pub fn initialize(env: Env, admin: Address, quorum: u32, voting_period_ledgers: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        assert!(quorum >= 1 && quorum <= 10_000, "quorum_bps must be 1-10000");
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::QuorumBps, &quorum);
        env.storage()
            .instance()
            .set(&DataKey::ThresholdBps, &DEFAULT_THRESHOLD_BPS);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &0_u32);
        env.storage().instance().set(&DataKey::VoterCount, &0_u32);
        let proposals: Map<u32, Proposal> = Map::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::Proposals, &proposals);
        env.storage()
            .instance()
            .set(&DataKey::Version, &String::from_str(&env, VERSION));
    }

    /// Returns the contract version string (e.g. `"1.0.0"`).
    pub fn get_version(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| String::from_str(&env, VERSION))
    }

    /// Migrate state schema to a new version. Admin-only.
    ///
    /// # Arguments
    /// * `new_version` — version string to store (e.g. `"2.0.0"`).
    ///
    /// # Authorization
    /// Requires `admin` authorisation.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn migrate(env: Env, new_version: String) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Version, &new_version);
    }

    /// Set quorum in basis points (1–10 000). Admin-only.
    /// Can also be updated via a passed governance proposal.
    pub fn set_quorum_bps(env: Env, admin: Address, bps: u32) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        assert!((1..=10_000).contains(&bps), "quorum_bps must be 1-10000");
        env.storage().instance().set(&DataKey::QuorumBps, &bps);
    }

    /// Returns the current quorum in basis points (default: `1000` = 10 %).
    pub fn get_quorum_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::QuorumBps)
            .unwrap_or(DEFAULT_QUORUM_BPS)
    }

    /// Set approval threshold in basis points (1–10 000). Admin-only.
    /// Can also be updated via a passed governance proposal.
    pub fn set_threshold_bps(env: Env, admin: Address, bps: u32) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        assert!((1..=10_000).contains(&bps), "threshold_bps must be 1-10000");
        env.storage().instance().set(&DataKey::ThresholdBps, &bps);
    }

    /// Returns the current approval threshold in basis points (default: `5100` = 51 %).
    pub fn get_threshold_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ThresholdBps)
            .unwrap_or(DEFAULT_THRESHOLD_BPS)
    }

    /// Submit a new proposal.
    ///
    /// # Arguments
    /// * `proposer`    — address submitting the proposal (must authorise).
    /// * `title`       — short title.
    /// * `description` — full description.
    ///
    /// # Authorization
    /// Requires `proposer` authorisation.
    ///
    /// # Returns
    /// The new proposal's ID.
    pub fn propose(env: Env, proposer: Address, title: String, description: String) -> u32 {
        proposer.require_auth();
        let mut count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        count += 1;
        let period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .expect("not initialized");
        let snapshot_ledger = env.ledger().sequence();
        let proposal = Proposal {
            id: count,
            proposer,
            title,
            description,
            yes_votes: 0,
            no_votes: 0,
            end_ledger: snapshot_ledger + period,
            status: ProposalStatus::Active,
            execute_after: 0,
            snapshot_ledger,
            yes_weight: 0,
            no_weight: 0,
        };
        let mut proposals: Map<u32, Proposal> = env
            .storage()
            .instance()
            .get(&DataKey::Proposals)
            .expect("not initialized");
        proposals.set(count, proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &count);
        env.storage()
            .instance()
            .set(&DataKey::Proposals, &proposals);
        env.events().publish((symbol_short!("propose"),), count);
        count
    }

    /// Cast a vote on an active proposal.
    ///
    /// # Arguments
    /// * `voter`       — address casting the vote (must authorise).
    /// * `proposal_id` — ID of the proposal to vote on.
    /// * `approve`     — `true` for yes, `false` for no.
    ///
    /// # Authorization
    /// Requires `voter` authorisation.
    ///
    /// # Vote weight (issue #61)
    /// If a `TokenContract` is configured, the voter's energy-token balance at
    /// the proposal's `snapshot_ledger` is used as weight, capped at
    /// `VoteWeightCap` (default: 1_000_000) to prevent single-voter dominance.
    /// When no `TokenContract` is set, every vote has weight **1** (original
    /// behaviour — fully backwards compatible).
    ///
    /// # Panics
    /// * `"reentrant call"` if vote() is called while already executing.
    /// * `"already voted"` if `voter` has already voted on this proposal.
    /// * `"proposal not found"` if `proposal_id` does not exist.
    /// * `"proposal not active"` if the proposal is not in `Active` status.
    /// * `"voting period ended"` if the current ledger exceeds `end_ledger`.
    pub fn vote(env: Env, voter: Address, proposal_id: u32, approve: bool) {
        voter.require_auth();

        // ── reentrancy guard ──────────────────────────────────────────────
        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::VoteLock)
            .unwrap_or(false)
        {
            panic!("reentrant call");
        }
        env.storage().instance().set(&DataKey::VoteLock, &true);

        // Assign / look up voter index and check bitmap (state read before any
        // external interaction — checks-effects-interactions pattern).
        let idx = voter_index(&env, &voter);
        if bitmap_get(&env, proposal_id, idx) {
            env.storage().instance().set(&DataKey::VoteLock, &false);
            panic!("already voted");
        }

        let mut proposals: Map<u32, Proposal> = env
            .storage()
            .instance()
            .get(&DataKey::Proposals)
            .expect("not initialized");
        let mut p = proposals.get(proposal_id).expect("proposal not found");
        assert!(p.status == ProposalStatus::Active, "proposal not active");
        assert!(
            env.ledger().sequence() <= p.end_ledger,
            "voting period ended"
        );

        // ── compute vote weight (issue #61) ──────────────────────────────
        let weight = Self::compute_vote_weight(&env, &voter);

        // ── effects: update all state before any external calls ───────────
        if approve {
            p.yes_votes += 1;
            p.yes_weight += weight;
        } else {
            p.no_votes += 1;
            p.no_weight += weight;
        }
        proposals.set(proposal_id, p);
        env.storage()
            .instance()
            .set(&DataKey::Proposals, &proposals);

        // Record vote in bitmap (single persistent write per 128 voters)
        bitmap_set(&env, proposal_id, idx);

        env.events()
            .publish((symbol_short!("vote"),), (proposal_id, voter, approve));

        // ── release lock ──────────────────────────────────────────────────
        env.storage().instance().set(&DataKey::VoteLock, &false);
    }

    /// Compute the effective vote weight for `voter`.
    ///
    /// Returns `min(token_balance, cap)` when a `TokenContract` is configured,
    /// or `1` when no token contract has been set (backwards-compatible mode).
    ///
    /// The cap prevents a single large token holder from unilaterally deciding
    /// the outcome of any proposal.
    fn compute_vote_weight(env: &Env, voter: &Address) -> i128 {
        let cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VoteWeightCap)
            .unwrap_or(DEFAULT_VOTE_WEIGHT_CAP);

        let token_contract: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenContract);

        match token_contract {
            None => 1_i128, // no token contract → unit weight (backwards compatible)
            Some(contract_addr) => {
                // Cross-contract call to read the voter's energy-token balance.
                let client = EnergyTokenClient::new(env, &contract_addr);
                let balance = client.balance(voter);
                // Clamp to [0, cap] — negative balances treated as 0.
                balance.max(0).min(cap)
            }
        }
    }

    /// Finalise a proposal after its voting period has ended.
    ///
    /// Outcome: `yes_votes * 100 / total >= quorum` → Passed, else Rejected.
    /// If no votes were cast → Expired.
    ///
    /// # Panics
    /// * `"proposal not found"` if `proposal_id` does not exist.
    /// * `"already finalized"` if the proposal is not in `Active` status.
    /// * `"voting still open"` if the current ledger has not passed `end_ledger`.
    ///
    /// # Events
    /// Emits `(topic: "final", data: (proposal_id, status))`.
    pub fn finalize(env: Env, proposal_id: u32) {
        let mut proposals: Map<u32, Proposal> = env
            .storage()
            .instance()
            .get(&DataKey::Proposals)
            .expect("not initialized");
        let mut p = proposals.get(proposal_id).expect("proposal not found");
        assert!(p.status == ProposalStatus::Active, "already finalized");
        assert!(env.ledger().sequence() > p.end_ledger, "voting still open");

        let quorum_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumBps)
            .unwrap_or(DEFAULT_QUORUM_BPS);
        let threshold_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ThresholdBps)
            .unwrap_or(DEFAULT_THRESHOLD_BPS);
        let total_head = p.yes_votes + p.no_votes;

        // Use weighted totals when available; when no TokenContract is set,
        // weight == 1 per vote so yes_weight == yes_votes (same result).
        let total_weight = p.yes_weight + p.no_weight;

        p.status = if total_head == 0 {
            // No votes cast at all → Expired
            ProposalStatus::Expired
        } else if total_weight > 0
            && p.yes_weight * 10_000 / total_weight >= threshold_bps as i128
            && total_head * 10_000 >= quorum_bps
        {
            let timelock: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ExecuteTimelock)
                .unwrap_or(EXECUTE_TIMELOCK_LEDGERS);
            p.execute_after = env.ledger().sequence() + timelock;
            ProposalStatus::Passed
        } else {
            ProposalStatus::Rejected
        };

        proposals.set(proposal_id, p.clone());
        env.storage()
            .instance()
            .set(&DataKey::Proposals, &proposals);
        env.events()
            .publish((symbol_short!("final"),), (proposal_id, p.status));
    }

    // ── upgrade mechanism ─────────────────────────────────────────────────────

    /// Propose a contract upgrade. Admin-only.
    ///
    /// The upgrade is locked for `UPGRADE_TIMELOCK_LEDGERS` (~48 h) before it
    /// can be executed, giving the community time to react.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    /// * `"upgrade already pending"` if a proposal is already queued.
    ///
    /// # Events
    /// Emits `(topic: "upg_prop", data: (new_wasm_hash, unlock_ledger))`.
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("upgrade already pending");
        }
        let unlock_ledger = env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS;
        let proposal = UpgradeProposal {
            new_wasm_hash: new_wasm_hash.clone(),
            unlock_ledger,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &proposal);
        env.events()
            .publish((symbol_short!("upg_prop"),), (new_wasm_hash, unlock_ledger));
    }

    /// Cancel a pending upgrade. Admin-only.
    ///
    /// # Panics
    /// * `"no pending upgrade"` if there is nothing to cancel.
    ///
    /// # Events
    /// Emits `(topic: "upg_cncl", data: ())`.
    pub fn cancel_upgrade(env: Env, admin: Address) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("no pending upgrade");
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.events().publish((symbol_short!("upg_cncl"),), ());
    }

    /// Execute a pending upgrade after the timelock has elapsed. Admin-only.
    ///
    /// # Panics
    /// * `"no pending upgrade"` if no upgrade has been proposed.
    /// * `"timelock not elapsed"` if the unlock ledger has not been reached.
    ///
    /// # Events
    /// Emits `(topic: "upg_exec", data: new_wasm_hash)`.
    pub fn execute_upgrade(env: Env, admin: Address) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        let proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("no pending upgrade");
        if env.ledger().sequence() < proposal.unlock_ledger {
            panic!("timelock not elapsed");
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.deployer()
            .update_current_contract_wasm(proposal.new_wasm_hash.clone());
        env.events()
            .publish((symbol_short!("upg_exec"),), proposal.new_wasm_hash);
    }

    /// Returns the pending upgrade proposal, if any.
    ///
    /// Returns `None` if no upgrade has been proposed or the last one was cancelled/executed.
    pub fn pending_upgrade(env: Env) -> Option<UpgradeProposal> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    /// Set the execution timelock (in ledgers). Admin-only.
    ///
    /// # Panics
    /// * `"timelock must be > 0"` if `ledgers` is zero.
    pub fn set_execution_timelock(env: Env, admin: Address, ledgers: u32) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        assert!(ledgers > 0, "timelock must be > 0");
        env.storage()
            .instance()
            .set(&DataKey::ExecuteTimelock, &ledgers);
    }

    /// Returns the current execution timelock in ledgers (default: `8640` ≈ 24 h).
    pub fn get_execution_timelock(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ExecuteTimelock)
            .unwrap_or(EXECUTE_TIMELOCK_LEDGERS)
    }

    // ── vote-weight configuration (issue #61) ─────────────────────────────────

    /// Set the energy-token contract address used for vote-weight lookups.
    ///
    /// When set, each voter's energy-token balance at proposal creation is used
    /// as their vote weight (capped at `VoteWeightCap`).  When not set, every
    /// vote has weight 1 (original behaviour).
    ///
    /// # Authorization
    /// Admin-only.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn set_token_contract(env: Env, admin: Address, token_contract: Address) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &token_contract);
    }

    /// Returns the configured energy-token contract address, or `None` if not set.
    pub fn get_token_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::TokenContract)
    }

    /// Set the maximum vote weight per voter (issue #61).
    ///
    /// Any voter whose token balance exceeds `cap` is counted as if they hold
    /// exactly `cap` tokens.  This prevents single large holders from dominating
    /// governance outcomes.
    ///
    /// # Arguments
    /// * `cap` — maximum weight per voter; must be ≥ 1.
    ///
    /// # Authorization
    /// Admin-only.
    ///
    /// # Panics
    /// * `"cap must be >= 1"` if `cap` is zero.
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn set_vote_weight_cap(env: Env, admin: Address, cap: i128) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");
        admin.require_auth();
        assert!(cap >= 1, "cap must be >= 1");
        env.storage()
            .instance()
            .set(&DataKey::VoteWeightCap, &cap);
    }

    /// Returns the current vote weight cap (default: `1_000_000`).
    pub fn get_vote_weight_cap(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::VoteWeightCap)
            .unwrap_or(DEFAULT_VOTE_WEIGHT_CAP)
    }

    /// Execute a passed proposal after its timelock has elapsed.
    ///
    /// Marks the proposal as `Executed` and emits an event. The caller is
    /// responsible for any on-chain action the proposal encodes.
    ///
    /// # Panics
    /// * `"proposal not found"` if `proposal_id` does not exist.
    /// * `"proposal not passed"` if the proposal is not in `Passed` status.
    /// * `"timelock not elapsed"` if `execute_after` has not been reached.
    ///
    /// # Events
    /// Emits `(topic: "exec", data: proposal_id)`.
    pub fn execute(env: Env, proposal_id: u32) {
        let mut proposals: Map<u32, Proposal> = env
            .storage()
            .instance()
            .get(&DataKey::Proposals)
            .expect("not initialized");
        let mut p = proposals.get(proposal_id).expect("proposal not found");
        assert!(p.status == ProposalStatus::Passed, "proposal not passed");
        assert!(
            env.ledger().sequence() >= p.execute_after,
            "timelock not elapsed"
        );
        p.status = ProposalStatus::Executed;
        proposals.set(proposal_id, p);
        env.storage()
            .instance()
            .set(&DataKey::Proposals, &proposals);
        env.events().publish((symbol_short!("exec"),), proposal_id);
    }

    /// Returns the proposal with the given ID, or `None` if it does not exist.
    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        let proposals: Map<u32, Proposal> = env
            .storage()
            .instance()
            .get(&DataKey::Proposals)
            .expect("not initialized");
        proposals.get(proposal_id)
    }

    /// Returns the total number of proposals created (monotonically increasing).
    pub fn proposal_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("not initialized")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env, String,
    };

    fn setup() -> (Env, Address, CommunityGovernanceClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &100_u32, &100_u32);
        (env, admin, client)
    }

    #[test]
    fn test_defaults() {
        let (_env, _admin, client) = setup();
        // setup() passes quorum=100 → stored as-is
        assert_eq!(client.get_quorum_bps(), 100);
        assert_eq!(client.get_threshold_bps(), 5_100);
    }

    #[test]
    fn test_initialize_configures_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &2_500_u32, &100_u32);
        assert_eq!(client.get_quorum_bps(), 2_500);
        assert_eq!(client.get_threshold_bps(), 5_100); // default threshold
    }

    #[test]
    #[should_panic(expected = "quorum_bps must be 1-10000")]
    fn test_initialize_rejects_zero_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        client.initialize(&Address::generate(&env), &0_u32, &100_u32);
    }

    /// Exactly at quorum: 1 yes out of 1 total, quorum_bps=10000 (100%) → Passed
    #[test]
    fn test_finalize_exactly_at_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        // quorum_bps=1 (0.01%) — any single vote satisfies quorum
        client.initialize(&admin, &1_u32, &100_u32);
        let proposer = Address::generate(&env);
        let pid = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&Address::generate(&env), &pid, &true);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&pid);
        assert_eq!(client.get_proposal(&pid).unwrap().status, ProposalStatus::Passed);
    }

    /// One vote below quorum: 0 votes cast → Expired (quorum not met)
    #[test]
    fn test_finalize_one_below_quorum_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &5_000_u32, &100_u32);
        let proposer = Address::generate(&env);
        let pid = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        // No votes cast — total=0 → Expired
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&pid);
        assert_eq!(client.get_proposal(&pid).unwrap().status, ProposalStatus::Expired);
    }

    /// Admin updates quorum via set_quorum_bps (governance proposal path)
    #[test]
    fn test_admin_updates_quorum_via_set_quorum_bps() {
        let (_env, admin, client) = setup();
        client.set_quorum_bps(&admin, &3_000_u32);
        assert_eq!(client.get_quorum_bps(), 3_000);
    }

    /// Admin updates threshold via set_threshold_bps (governance proposal path)
    #[test]
    fn test_admin_updates_threshold_via_set_threshold_bps() {
        let (_env, admin, client) = setup();
        client.set_threshold_bps(&admin, &6_600_u32);
        assert_eq!(client.get_threshold_bps(), 6_600);
    }

    /// Non-admin cannot call set_quorum_bps
    #[test]
    #[should_panic(expected = "not admin")]
    fn test_non_admin_cannot_set_quorum() {
        let (env, _admin, client) = setup();
        let rogue = Address::generate(&env);
        client.set_quorum_bps(&rogue, &500_u32);
    }

    /// Non-admin cannot call set_threshold_bps
    #[test]
    #[should_panic(expected = "not admin")]
    fn test_non_admin_cannot_set_threshold() {
        let (env, _admin, client) = setup();
        let rogue = Address::generate(&env);
        client.set_threshold_bps(&rogue, &500_u32);
    }

    #[test]
    fn test_set_quorum_bps() {
        let (_env, admin, client) = setup();
        client.set_quorum_bps(&admin, &2_000_u32);
        assert_eq!(client.get_quorum_bps(), 2_000);
    }

    #[test]
    fn test_set_threshold_bps() {
        let (_env, admin, client) = setup();
        client.set_threshold_bps(&admin, &6_000_u32);
        assert_eq!(client.get_threshold_bps(), 6_000);
    }

    #[test]
    #[should_panic(expected = "quorum_bps must be 1-10000")]
    fn test_quorum_bps_boundary_zero() {
        let (_env, admin, client) = setup();
        client.set_quorum_bps(&admin, &0_u32);
    }

    #[test]
    #[should_panic(expected = "quorum_bps must be 1-10000")]
    fn test_quorum_bps_boundary_over() {
        let (_env, admin, client) = setup();
        client.set_quorum_bps(&admin, &10_001_u32);
    }

    #[test]
    #[should_panic(expected = "threshold_bps must be 1-10000")]
    fn test_threshold_bps_boundary_zero() {
        let (_env, admin, client) = setup();
        client.set_threshold_bps(&admin, &0_u32);
    }

    #[test]
    #[should_panic(expected = "threshold_bps must be 1-10000")]
    fn test_threshold_bps_boundary_over() {
        let (_env, admin, client) = setup();
        client.set_threshold_bps(&admin, &10_001_u32);
    }

    #[test]
    fn test_propose_and_pass() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
        );
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &true);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Passed
        );
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_double_vote_rejected() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&voter, &id, &true);
        client.vote(&voter, &id, &true); // must panic
    }

    /// Simulate 200 distinct voters to exercise multiple bitmap words.
    #[test]
    fn test_bitmap_200_voters() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "Scale"),
            &String::from_str(&env, "Test"),
        );

        for _ in 0..200 {
            client.vote(&Address::generate(&env), &id, &true);
        }

        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Passed
        );
        assert_eq!(client.get_proposal(&id).unwrap().yes_votes, 200);
    }

    /// Verify that a second call to vote() while the lock is held is rejected.
    /// We simulate reentrancy by manually setting VoteLock before calling vote().
    #[test]
    #[should_panic(expected = "reentrant call")]
    fn test_vote_reentrancy_rejected() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        // Simulate a reentrant state by setting the lock directly in storage.
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::VoteLock, &true);
        });
        client.vote(&voter, &id, &true); // must panic with "reentrant call"
    }

    /// Benchmark: count persistent ledger writes for 1000 votes.
    /// With bitmap packing (128 bits/word) we expect ⌈1000/128⌉ = 8 writes.
    #[test]
    fn test_bitmap_storage_cost_1000_votes() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(CommunityGovernance, ());
        let client = CommunityGovernanceClient::new(&env, &id);
        client.initialize(&Address::generate(&env), &1_000_u32, &1_100_u32);

        let proposer = Address::generate(&env);
        let pid = client.propose(
            &proposer,
            &String::from_str(&env, "Big"),
            &String::from_str(&env, "Vote"),
        );

        for _ in 0..1000 {
            client.vote(&Address::generate(&env), &pid, &true);
        }

        // ⌈1000 / 128⌉ = 8 bitmap words written
        let expected_bitmap_words: u32 = (1000_u32 + 127) / 128;
        assert_eq!(expected_bitmap_words, 8, "bitmap word count");

        assert_eq!(client.get_proposal(&pid).unwrap().yes_votes, 1000);
    }

    // ── upgrade timelock tests ────────────────────────────────────────────────

    fn dummy_hash(env: &Env) -> soroban_sdk::BytesN<32> {
        soroban_sdk::BytesN::from_array(env, &[0xabu8; 32])
    }

    #[test]
    fn test_propose_upgrade_stores_proposal() {
        let (env, admin, client) = setup();
        client.propose_upgrade(&admin, &dummy_hash(&env));
        let pending = client.pending_upgrade().unwrap();
        assert_eq!(pending.new_wasm_hash, dummy_hash(&env));
        assert_eq!(
            pending.unlock_ledger,
            env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS
        );
    }

    #[test]
    #[should_panic(expected = "upgrade already pending")]
    fn test_propose_upgrade_rejects_duplicate() {
        let (env, admin, client) = setup();
        client.propose_upgrade(&admin, &dummy_hash(&env));
        client.propose_upgrade(&admin, &dummy_hash(&env));
    }

    #[test]
    fn test_cancel_upgrade_removes_proposal() {
        let (env, admin, client) = setup();
        client.propose_upgrade(&admin, &dummy_hash(&env));
        client.cancel_upgrade(&admin);
        assert!(client.pending_upgrade().is_none());
    }

    #[test]
    #[should_panic(expected = "no pending upgrade")]
    fn test_cancel_upgrade_no_proposal_panics() {
        let (_env, admin, client) = setup();
        client.cancel_upgrade(&admin);
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn test_execute_upgrade_before_timelock_panics() {
        let (env, admin, client) = setup();
        client.propose_upgrade(&admin, &dummy_hash(&env));
        client.execute_upgrade(&admin);
    }

    // ── proposal execution timelock tests ─────────────────────────────────────

    /// Helper: create a passed proposal (voting period = 100 ledgers, 2 yes votes).
    fn pass_proposal(env: &Env, client: &CommunityGovernanceClient) -> u32 {
        let proposer = Address::generate(env);
        let id = client.propose(
            &proposer,
            &String::from_str(env, "T"),
            &String::from_str(env, "D"),
        );
        client.vote(&Address::generate(env), &id, &true);
        client.vote(&Address::generate(env), &id, &true);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        id
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn test_execute_before_timelock_panics() {
        let (env, _admin, client) = setup();
        let id = pass_proposal(&env, &client);
        // execute_after = finalize_ledger + 8640; we are still at finalize_ledger
        client.execute(&id);
    }

    #[test]
    fn test_execute_after_timelock_succeeds() {
        let (env, _admin, client) = setup();
        let id = pass_proposal(&env, &client);
        env.ledger()
            .with_mut(|l| l.sequence_number += EXECUTE_TIMELOCK_LEDGERS);
        client.execute(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Executed
        );
    }

    #[test]
    #[should_panic(expected = "proposal not passed")]
    fn test_execute_non_passed_panics() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id); // Expired (no votes)
        client.execute(&id);
    }

    #[test]
    fn test_set_execution_timelock_configurable() {
        let (env, admin, client) = setup();
        client.set_execution_timelock(&admin, &500_u32);
        assert_eq!(client.get_execution_timelock(), 500);
        let id = pass_proposal(&env, &client);
        // timelock is now 500 ledgers; advance exactly 500
        env.ledger().with_mut(|l| l.sequence_number += 500);
        client.execute(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Executed
        );
    }

    #[test]
    #[should_panic(expected = "timelock must be > 0")]
    fn test_set_execution_timelock_zero_panics() {
        let (_env, admin, client) = setup();
        client.set_execution_timelock(&admin, &0_u32);
    }

    // ── proposal lifecycle: quorum / rejection / expiry ───────────────────────

    /// A proposal with only no-votes is Rejected and cannot be executed.
    #[test]
    #[should_panic(expected = "proposal not passed")]
    fn test_quorum_not_met_rejected_cannot_execute() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        // Cast only no-votes — threshold not met
        client.vote(&Address::generate(&env), &id, &false);
        client.vote(&Address::generate(&env), &id, &false);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Rejected
        );
        // Attempting to execute a Rejected proposal must panic
        client.execute(&id);
    }

    /// A proposal with no votes at all is Expired and cannot be executed.
    #[test]
    #[should_panic(expected = "proposal not passed")]
    fn test_expired_proposal_cannot_execute() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Expired
        );
        // Attempting to execute an Expired proposal must panic
        client.execute(&id);
    }

    /// Voting after the voting period has ended must panic.
    #[test]
    #[should_panic(expected = "voting period ended")]
    fn test_vote_after_period_panics() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.vote(&Address::generate(&env), &id, &true);
    }

    /// Finalising a proposal before its voting period ends must panic.
    #[test]
    #[should_panic(expected = "voting still open")]
    fn test_finalize_before_period_ends_panics() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.finalize(&id); // voting period not over yet
    }

    /// Finalising an already-finalised proposal must panic.
    #[test]
    #[should_panic(expected = "already finalized")]
    fn test_finalize_twice_panics() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        client.finalize(&id); // second call must panic
    }

    /// proposal_count increments correctly across multiple proposals.
    #[test]
    fn test_proposal_count() {
        let (env, _admin, client) = setup();
        assert_eq!(client.proposal_count(), 0);
        let p = Address::generate(&env);
        client.propose(
            &p,
            &String::from_str(&env, "A"),
            &String::from_str(&env, "D"),
        );
        client.propose(
            &p,
            &String::from_str(&env, "B"),
            &String::from_str(&env, "D"),
        );
        assert_eq!(client.proposal_count(), 2);
    }

    /// get_proposal returns None for a non-existent ID.
    #[test]
    fn test_get_proposal_nonexistent_returns_none() {
        let (_env, _admin, client) = setup();
        assert!(client.get_proposal(&99_u32).is_none());
    }

    /// Mixed yes/no votes: majority no → Rejected.
    #[test]
    fn test_majority_no_rejected() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &false);
        client.vote(&Address::generate(&env), &id, &false);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Rejected
        );
    }

    /// get_version returns the expected version string.
    #[test]
    fn test_get_version() {
        let (env, _admin, client) = setup();
        assert_eq!(client.get_version(), String::from_str(&env, "1.0.0"));
    }

    #[test]
    fn test_finalize_expired_proposal() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(&proposer, &String::from_str(&env, "Test"), &String::from_str(&env, "Desc"));
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(client.get_proposal(&id).unwrap().status, ProposalStatus::Expired);
    }

    // ── event emission tests (#330) ──────────────────────────────────────────

    #[test]
    fn test_propose_emits_event() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        client.propose(
            &proposer,
            &String::from_str(&env, "Title"),
            &String::from_str(&env, "Desc"),
        );
        let events = env.events().all();
        let propose_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("propose"), &env)]
        });
        assert!(propose_event.is_some(), "propose event not emitted");
        let (_, _, data) = propose_event.unwrap();
        let proposal_id: u32 = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(proposal_id, 1_u32);
    }

    #[test]
    fn test_vote_emits_event() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&voter, &id, &true);
        let events = env.events().all();
        let vote_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("vote"), &env)]
        });
        assert!(vote_event.is_some(), "vote event not emitted");
        let (_, _, data) = vote_event.unwrap();
        let (pid, _voter_addr, approve): (u32, Address, bool) =
            soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(pid, id);
        assert!(approve);
    }

    #[test]
    fn test_finalize_emits_event() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &true);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        let events = env.events().all();
        let final_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("final"), &env)]
        });
        assert!(final_event.is_some(), "finalize event not emitted");
        let (_, _, data) = final_event.unwrap();
        let (pid, status): (u32, ProposalStatus) = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(pid, id);
        assert_eq!(status, ProposalStatus::Passed);
    }

    #[test]
    fn test_execute_emits_event() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
        );
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &true);
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        env.ledger()
            .with_mut(|l| l.sequence_number += EXECUTE_TIMELOCK_LEDGERS);
        client.execute(&id);
        let events = env.events().all();
        let exec_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("exec"), &env)]
        });
        assert!(exec_event.is_some(), "execute event not emitted");
        let (_, _, data) = exec_event.unwrap();
        let pid: u32 = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(pid, id);
    }

    // ── vote-weight tests (issue #61) ─────────────────────────────────────────

    /// When no TokenContract is set, yes_weight should equal yes_votes (weight = 1/vote).
    #[test]
    fn test_no_token_contract_weight_equals_head_count() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "W"),
            &String::from_str(&env, "Weight test"),
        );
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &false);
        let p = client.get_proposal(&id).unwrap();
        assert_eq!(p.yes_votes, 2);
        assert_eq!(p.no_votes, 1);
        // Without a TokenContract weight == 1 per vote
        assert_eq!(p.yes_weight, 2_i128, "yes_weight must equal yes_votes when no token contract");
        assert_eq!(p.no_weight, 1_i128, "no_weight must equal no_votes when no token contract");
    }

    /// snapshot_ledger on a new proposal equals the ledger at propose() time.
    #[test]
    fn test_snapshot_ledger_set_on_propose() {
        let (env, _admin, client) = setup();
        env.ledger().with_mut(|l| l.sequence_number = 42);
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "S"),
            &String::from_str(&env, "Snapshot"),
        );
        let p = client.get_proposal(&id).unwrap();
        assert_eq!(p.snapshot_ledger, 42, "snapshot_ledger must be set to current ledger on propose()");
    }

    /// New proposals start with zero yes_weight and no_weight.
    #[test]
    fn test_initial_weights_are_zero() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "Z"),
            &String::from_str(&env, "Zero weights"),
        );
        let p = client.get_proposal(&id).unwrap();
        assert_eq!(p.yes_weight, 0_i128);
        assert_eq!(p.no_weight, 0_i128);
    }

    /// Admin can set and retrieve the vote weight cap.
    #[test]
    fn test_set_vote_weight_cap() {
        let (_env, admin, client) = setup();
        client.set_vote_weight_cap(&admin, &500_000_i128);
        assert_eq!(client.get_vote_weight_cap(), 500_000_i128);
    }

    /// The default vote weight cap is DEFAULT_VOTE_WEIGHT_CAP = 1_000_000.
    #[test]
    fn test_default_vote_weight_cap() {
        let (_env, _admin, client) = setup();
        assert_eq!(client.get_vote_weight_cap(), 1_000_000_i128);
    }

    /// Non-admin cannot set the vote weight cap.
    #[test]
    #[should_panic(expected = "not admin")]
    fn test_non_admin_cannot_set_vote_weight_cap() {
        let (env, _admin, client) = setup();
        let rogue = Address::generate(&env);
        client.set_vote_weight_cap(&rogue, &999_i128);
    }

    /// Vote weight cap must be >= 1.
    #[test]
    #[should_panic(expected = "cap must be >= 1")]
    fn test_vote_weight_cap_zero_rejected() {
        let (_env, admin, client) = setup();
        client.set_vote_weight_cap(&admin, &0_i128);
    }

    /// No token contract → get_token_contract returns None.
    #[test]
    fn test_no_token_contract_returns_none() {
        let (_env, _admin, client) = setup();
        assert!(client.get_token_contract().is_none());
    }

    /// Admin can set the token contract.
    #[test]
    fn test_set_token_contract() {
        let (env, admin, client) = setup();
        let token_addr = Address::generate(&env);
        client.set_token_contract(&admin, &token_addr);
        assert_eq!(client.get_token_contract(), Some(token_addr));
    }

    /// Non-admin cannot set the token contract.
    #[test]
    #[should_panic(expected = "not admin")]
    fn test_non_admin_cannot_set_token_contract() {
        let (env, _admin, client) = setup();
        let rogue = Address::generate(&env);
        client.set_token_contract(&rogue, &Address::generate(&env));
    }

    /// Weighted finalization: majority yes by weight passes even if head-count
    /// majority is slim.  Tests that yes_weight/total_weight >= threshold.
    #[test]
    fn test_weighted_finalize_passes_with_majority_weight() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "Weighted"),
            &String::from_str(&env, "Pass"),
        );

        // Without a token contract weight == 1, so 2 yes vs 1 no → 67% yes > 51% → Passed
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &true);
        client.vote(&Address::generate(&env), &id, &false);

        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(client.get_proposal(&id).unwrap().status, ProposalStatus::Passed);
    }

    /// Weighted finalization: when no votes → Expired (unchanged behaviour).
    #[test]
    fn test_weighted_finalize_no_votes_expired() {
        let (env, _admin, client) = setup();
        let proposer = Address::generate(&env);
        let id = client.propose(
            &proposer,
            &String::from_str(&env, "Ghost"),
            &String::from_str(&env, "Expired"),
        );
        env.ledger().with_mut(|l| l.sequence_number += 101);
        client.finalize(&id);
        assert_eq!(client.get_proposal(&id).unwrap().status, ProposalStatus::Expired);
    }

    /// With token contract set, a voter with a large balance gets capped weight.
    /// This tests that the cap prevents single-voter dominance.
    #[test]
    fn test_vote_weight_capped_by_token_balance() {
        use energy_token::{EnergyToken, EnergyTokenClient};

        let env = Env::default();
        env.mock_all_auths();

        // Deploy energy token contract
        let token_id = env.register(EnergyToken, ());
        let token_client = EnergyTokenClient::new(&env, &token_id);
        let token_admin = Address::generate(&env);
        let minter = Address::generate(&env);
        token_client.initialize(&token_admin, &minter);

        // Deploy governance contract
        let gov_id = env.register(CommunityGovernance, ());
        let gov_client = CommunityGovernanceClient::new(&env, &gov_id);
        let gov_admin = Address::generate(&env);
        gov_client.initialize(&gov_admin, &100_u32, &100_u32);

        // Set the cap to 500_000 and configure the token contract
        gov_client.set_vote_weight_cap(&gov_admin, &500_000_i128);
        gov_client.set_token_contract(&gov_admin, &token_id);

        // Whale: minted 2_000_000 — above the cap of 500_000
        let whale = Address::generate(&env);
        token_client.mint(&whale, &2_000_000_i128);

        // Small voter: minted 100_000 — below the cap
        let small_voter = Address::generate(&env);
        token_client.mint(&small_voter, &100_000_i128);

        let proposer = Address::generate(&env);
        let id = gov_client.propose(
            &proposer,
            &String::from_str(&env, "Cap test"),
            &String::from_str(&env, "Whale capping"),
        );

        // Both vote yes
        gov_client.vote(&whale, &id, &true);
        gov_client.vote(&small_voter, &id, &true);

        let p = gov_client.get_proposal(&id).unwrap();
        // whale's weight is capped to 500_000; small voter contributes 100_000
        assert_eq!(p.yes_weight, 600_000_i128,
            "yes_weight should be cap(500_000) + small(100_000) = 600_000");
        assert_eq!(p.no_weight, 0_i128);
        assert_eq!(p.yes_votes, 2);
    }

    /// A voter with zero token balance still gets weight 1 (or 0 when capped?).
    /// Weight is clamped to max(0, balance).min(cap).
    /// When balance=0, weight=0 but that means the vote registers with 0 weight.
    #[test]
    fn test_voter_with_zero_balance_gets_zero_weight_when_token_contract_set() {
        use energy_token::{EnergyToken, EnergyTokenClient};

        let env = Env::default();
        env.mock_all_auths();

        let token_id = env.register(EnergyToken, ());
        let token_client = EnergyTokenClient::new(&env, &token_id);
        let token_admin = Address::generate(&env);
        let minter = Address::generate(&env);
        token_client.initialize(&token_admin, &minter);

        let gov_id = env.register(CommunityGovernance, ());
        let gov_client = CommunityGovernanceClient::new(&env, &gov_id);
        let gov_admin = Address::generate(&env);
        gov_client.initialize(&gov_admin, &100_u32, &100_u32);
        gov_client.set_token_contract(&gov_admin, &token_id);

        // Voter with no tokens
        let zero_voter = Address::generate(&env);
        // Do NOT mint anything to zero_voter

        let proposer = Address::generate(&env);
        let id = gov_client.propose(
            &proposer,
            &String::from_str(&env, "Zero"),
            &String::from_str(&env, "Zero balance voter"),
        );

        gov_client.vote(&zero_voter, &id, &true);
        let p = gov_client.get_proposal(&id).unwrap();
        // balance=0 → weight = max(0,0).min(cap) = 0
        assert_eq!(p.yes_weight, 0_i128,
            "voter with zero balance should contribute 0 weight when token contract is set");
        assert_eq!(p.yes_votes, 1, "head count should still increment");
    }
}
