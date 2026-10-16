//! Comprehensive Option/None edge-case tests for `audit_registry` (#107).
//!
//! Covers every None-return code path identified in
//! docs/contract-option-none-tests.md:
//!
//! - `verify()` → `Option<AuditAnchor>` — returns `None` for unanchored hashes
//! - `anchored_at_ledger()` → `Option<u32>` — returns `None` for unanchored hashes
//! - `anchor_status()` — sentinel fields when not anchored
//!
//! All tests use the local Soroban sandbox (`Env::default()`).

#![cfg(test)]

use crate::{AnchorStatus, AuditRegistry, AuditRegistryClient};
use soroban_sdk::{testutils::Address as _, BytesN, Env};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

fn setup() -> (Env, soroban_sdk::Address, AuditRegistryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AuditRegistry, ());
    let client = AuditRegistryClient::new(&env, &id);
    let admin = soroban_sdk::Address::generate(&env);
    let signer = soroban_sdk::Address::generate(&env);
    client.initialize(&admin, &signer);
    (env, signer, client)
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn nonce(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// ---------------------------------------------------------------------------
// verify() — None return paths (get_reading equivalent)
// ---------------------------------------------------------------------------

/// `verify` must return `None` for a hash that has never been anchored.
#[test]
fn verify_returns_none_for_never_anchored_hash() {
    let (env, _signer, client) = setup();
    assert!(
        client.verify(&hash(&env, 0x01)).is_none(),
        "verify must return None for a hash that was never anchored"
    );
}

/// `verify` must return `None` for the all-zeros hash when nothing is anchored.
#[test]
fn verify_returns_none_for_all_zeros_hash_when_empty() {
    let (env, _signer, client) = setup();
    let all_zeros = BytesN::from_array(&env, &[0x00u8; 32]);
    assert!(
        client.verify(&all_zeros).is_none(),
        "verify must return None for all-zeros hash on empty registry"
    );
}

/// `verify` must return `None` for the all-0xFF hash when nothing is anchored.
#[test]
fn verify_returns_none_for_all_ff_hash_when_empty() {
    let (env, _signer, client) = setup();
    let all_ff = BytesN::from_array(&env, &[0xFFu8; 32]);
    assert!(
        client.verify(&all_ff).is_none(),
        "verify must return None for all-0xFF hash on empty registry"
    );
}

/// `verify` must return `None` for a hash that differs by one byte from an
/// anchored hash (i.e. not anchored on its own).
#[test]
fn verify_returns_none_for_hash_differing_by_one_byte_from_anchored() {
    let (env, signer, client) = setup();
    // Anchor hash 0xAA…AA
    let anchored = hash(&env, 0xAA);
    client.anchor(&signer, &anchored, &nonce(&env, 1));

    // Hash 0xAB…AA is not anchored — must return None.
    let mut arr = [0xAAu8; 32];
    arr[0] = 0xAB;
    let not_anchored = BytesN::from_array(&env, &arr);
    assert!(
        client.verify(&not_anchored).is_none(),
        "verify must return None for a hash that only differs by one byte"
    );
}

/// `verify` must still return `None` for a hash whose anchor was rejected
/// (duplicate anchor attempt) — the hash must remain unanchored.
#[test]
fn verify_returns_none_when_all_anchor_attempts_were_rejected() {
    let (env, signer, client) = setup();
    // Attempt to anchor hash 0xBB — second attempt with same nonce is rejected.
    let h = hash(&env, 0xBB);
    let n = nonce(&env, 1);
    // First call: should succeed.
    client.anchor(&signer, &h, &n);

    // Now try a *different* hash with the *same* nonce — this should be rejected.
    let h2 = hash(&env, 0xCC);
    let _ = client.try_anchor(&signer, &h2, &n); // rejected — nonce already used

    // h2 was never successfully anchored.
    assert!(
        client.verify(&h2).is_none(),
        "verify must return None for a hash whose anchor was rejected due to nonce reuse"
    );
}

// ---------------------------------------------------------------------------
// anchored_at_ledger() — None return paths (get_reading ledger equivalent)
// ---------------------------------------------------------------------------

/// `anchored_at_ledger` must return `None` for a hash that is not anchored.
#[test]
fn anchored_at_ledger_returns_none_for_unanchored_hash() {
    let (env, _signer, client) = setup();
    assert!(
        client.anchored_at_ledger(&hash(&env, 0x05)).is_none(),
        "anchored_at_ledger must return None for an unanchored hash"
    );
}

/// `anchored_at_ledger` must return `None` when the registry is completely
/// empty (no anchors stored at all).
#[test]
fn anchored_at_ledger_returns_none_on_empty_registry() {
    let (env, _signer, client) = setup();
    for byte in [0x00u8, 0x7Fu8, 0x80u8, 0xFFu8] {
        assert!(
            client.anchored_at_ledger(&hash(&env, byte)).is_none(),
            "anchored_at_ledger must return None for byte={byte:#04x} on empty registry"
        );
    }
}

// ---------------------------------------------------------------------------
// anchor_status() — sentinel fields when not anchored (get_certificate None)
// ---------------------------------------------------------------------------

/// `anchor_status` must report `is_anchored: false` and `anchored_at_ledger: 0`
/// for a hash that has never been anchored (sentinel / None equivalent).
#[test]
fn anchor_status_sentinel_for_unanchored_hash() {
    let (env, _signer, client) = setup();
    let status = client.anchor_status(&hash(&env, 0x10));
    assert_eq!(
        status,
        AnchorStatus {
            is_anchored: false,
            anchored_at_ledger: 0,
        },
        "anchor_status must return sentinel values for an unanchored hash"
    );
}

/// `anchor_status` sentinel must hold even after other hashes are anchored
/// (i.e., independent per-hash None semantics).
#[test]
fn anchor_status_sentinel_independent_of_other_anchored_hashes() {
    let (env, signer, client) = setup();
    // Anchor a different hash.
    client.anchor(&signer, &hash(&env, 0xDE), &nonce(&env, 1));

    // The target hash was never anchored.
    let status = client.anchor_status(&hash(&env, 0xAD));
    assert_eq!(
        status,
        AnchorStatus {
            is_anchored: false,
            anchored_at_ledger: 0,
        },
        "anchor_status sentinel must be independent of other anchored hashes"
    );
}

/// After a hash is anchored, `anchor_status` must no longer return the sentinel.
#[test]
fn anchor_status_transitions_from_none_to_some_after_anchor() {
    let (env, signer, client) = setup();
    let h = hash(&env, 0x42);

    // Before anchoring — sentinel.
    let before = client.anchor_status(&h);
    assert!(!before.is_anchored, "must not be anchored before anchor call");
    assert_eq!(before.anchored_at_ledger, 0, "sentinel ledger must be 0");

    // Anchor the hash.
    client.anchor(&signer, &h, &nonce(&env, 1));

    // After anchoring — must NOT return sentinel.
    let after = client.anchor_status(&h);
    assert!(after.is_anchored, "must be anchored after anchor call");
    assert_ne!(
        after.anchored_at_ledger, 0,
        "anchored_at_ledger must not be zero after anchor (unless ledger seq is 0)"
    );
}

// ---------------------------------------------------------------------------
// is_anchored() — false for all None paths (defensive completeness)
// ---------------------------------------------------------------------------

/// `is_anchored` must return `false` for any hash that has not been anchored,
/// consistent with the None semantics of `verify` and `anchored_at_ledger`.
#[test]
fn is_anchored_false_for_all_none_paths() {
    let (env, signer, client) = setup();

    // Anchor one known hash.
    let anchored_hash = hash(&env, 0x01);
    client.anchor(&signer, &anchored_hash, &nonce(&env, 1));

    // Several distinct, never-anchored hashes.
    for byte in [0x02u8, 0x50u8, 0x99u8, 0xFEu8] {
        assert!(
            !client.is_anchored(&hash(&env, byte)),
            "is_anchored must be false for unanchored hash with byte={byte:#04x}"
        );
    }
}
