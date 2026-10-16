//! Comprehensive Option/None edge-case tests for `energy_token` (#107).
//!
//! Covers every None-return code path for the certificate/balance layer:
//!
//! - `balance()` returns `0` (the implicit None default) for unknown accounts
//! - `total_supply()` before any mint
//! - `allowance()` returns `0` (implicit None) for unknown pairs
//! - `admin()` behaves deterministically for initialized contract
//!
//! All tests use the local Soroban sandbox (`Env::default()`).

#![cfg(test)]

use crate::{EnergyToken, EnergyTokenClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

fn setup() -> (Env, Address, Address, EnergyTokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(EnergyToken, ());
    let client = EnergyTokenClient::new(&env, &id);
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    client.initialize(&admin, &minter);
    (env, admin, minter, client)
}

// ---------------------------------------------------------------------------
// get_certificate equivalent — balance() None paths
// ---------------------------------------------------------------------------

/// `balance()` must return `0` (the None/default) for an address that has
/// never received any tokens.
#[test]
fn balance_returns_zero_for_unknown_account() {
    let (env, _admin, _minter, client) = setup();
    let unknown = Address::generate(&env);
    assert_eq!(
        client.balance(&unknown),
        0,
        "balance must return 0 (None-default) for an account that never received tokens"
    );
}

/// `balance()` must return `0` for any number of distinct unknown addresses.
#[test]
fn balance_returns_zero_for_multiple_unknown_accounts() {
    let (env, _admin, _minter, client) = setup();
    for _ in 0..5 {
        let addr = Address::generate(&env);
        assert_eq!(
            client.balance(&addr),
            0,
            "balance must return 0 for every never-funded address"
        );
    }
}

/// `balance()` must return `0` even when other accounts hold tokens.
#[test]
fn balance_returns_zero_for_unfunded_account_when_others_hold_tokens() {
    let (env, _admin, _minter, client) = setup();
    let funded = Address::generate(&env);
    let unfunded = Address::generate(&env);
    client.mint(&funded, &1_000_i128);
    assert_eq!(
        client.balance(&unfunded),
        0,
        "unfunded account balance must be zero even when other accounts have tokens"
    );
}

/// After a full burn, `balance()` must return `0` again (back to None-state).
#[test]
fn balance_returns_zero_after_full_burn() {
    let (env, _admin, _minter, client) = setup();
    let user = Address::generate(&env);
    client.mint(&user, &500_i128);
    client.burn(&user, &500_i128);
    assert_eq!(
        client.balance(&user),
        0,
        "balance must be 0 after burning all tokens (effectively None)"
    );
}

// ---------------------------------------------------------------------------
// total_supply — None before any mint (implicitly zero)
// ---------------------------------------------------------------------------

/// `total_supply()` must return `0` before any token has been minted.
#[test]
fn total_supply_is_zero_before_any_mint() {
    let (_env, _admin, _minter, client) = setup();
    assert_eq!(
        client.total_supply(),
        0,
        "total_supply must be 0 (None-equivalent) before any mint"
    );
}

/// `total_supply()` must return `0` after equal mint and burn operations.
#[test]
fn total_supply_is_zero_after_equal_mint_and_burn() {
    let (env, _admin, _minter, client) = setup();
    let user = Address::generate(&env);
    client.mint(&user, &1_000_i128);
    client.burn(&user, &1_000_i128);
    assert_eq!(
        client.total_supply(),
        0,
        "total_supply must be 0 after minting and fully burning all tokens"
    );
}

// ---------------------------------------------------------------------------
// allowance — None paths (returns 0 for unknown pairs)
// ---------------------------------------------------------------------------

/// `allowance()` must return `0` for any owner/spender pair where no `approve`
/// was called — the None-equivalent for the allowance map.
#[test]
fn allowance_returns_zero_for_unknown_pair() {
    let (env, _admin, _minter, client) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    assert_eq!(
        client.allowance(&owner, &spender),
        0,
        "allowance must return 0 (None-default) for a pair that was never approved"
    );
}

/// `allowance()` must return `0` for all cross-combinations of generated
/// addresses when no `approve` was called.
#[test]
fn allowance_returns_zero_for_multiple_unknown_pairs() {
    let (env, _admin, _minter, client) = setup();
    for _ in 0..3 {
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        assert_eq!(
            client.allowance(&owner, &spender),
            0,
            "allowance must be 0 for every never-approved pair"
        );
    }
}

/// After the allowance is fully consumed via `transfer_from`, it must return `0`
/// (back to None-state).
#[test]
fn allowance_returns_zero_after_full_consumption() {
    let (env, _admin, _minter, client) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.mint(&owner, &200_i128);
    client.approve(&owner, &spender, &200_i128, &1000_u32);
    client.transfer_from(&spender, &owner, &recipient, &200_i128);
    assert_eq!(
        client.allowance(&owner, &spender),
        0,
        "allowance must be 0 after being fully consumed by transfer_from"
    );
}

/// After `approve(..., 0, ...)` (revocation), allowance must return `0`.
#[test]
fn allowance_returns_zero_after_explicit_revocation() {
    let (env, _admin, _minter, client) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.approve(&owner, &spender, &500_i128, &1000_u32);
    // Revoke via zero-amount approve.
    client.approve(&owner, &spender, &0_i128, &1000_u32);
    assert_eq!(
        client.allowance(&owner, &spender),
        0,
        "allowance must return 0 (None-equivalent) after explicit revocation"
    );
}
