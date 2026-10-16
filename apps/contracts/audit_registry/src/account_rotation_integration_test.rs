//! Integration tests for contract account rotation (#100).
//!
//! Verifies that rotating the `api_signer` (minter/API key) of `audit_registry`
//! does not invalidate existing anchored certificate proofs, that new readings
//! must use the new key, and that the revoked old key can no longer anchor.
//!
//! Tests run against the local Soroban sandbox via `soroban_sdk::Env::default()`.

#![cfg(test)]

use crate::{AuditRegistry, AuditRegistryClient, Error};
use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, BytesN, Env};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup() -> (Env, Address, Address, AuditRegistryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AuditRegistry, ());
    let client = AuditRegistryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let api_signer = Address::generate(&env);
    client.initialize(&admin, &api_signer);
    (env, admin, api_signer, client)
}

fn make_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn make_nonce(env: &Env, val: u8) -> BytesN<32> {
    BytesN::from_array(env, &[val; 32])
}

// ---------------------------------------------------------------------------
// Test 1 — anchor a reading, rotate key, existing anchor remains valid
// ---------------------------------------------------------------------------

/// Anchor a reading with the original key.
/// Rotate to a new key.
/// The previously-anchored reading must still verify correctly.
#[test]
fn existing_anchor_remains_valid_after_key_rotation() {
    let (env, _admin, old_signer, client) = setup();

    // 1. Anchor a reading with the original api_signer.
    env.ledger().set_sequence_number(100);
    let reading_hash = make_hash(&env, 0xAB);
    let nonce = make_nonce(&env, 1);
    client
        .try_anchor(&old_signer, &reading_hash, &nonce)
        .expect("anchor should succeed with old signer");

    // Confirm it is anchored.
    assert!(
        client.is_anchored(&reading_hash),
        "reading must be anchored before rotation"
    );

    // 2. Rotate the api_signer.
    let new_signer = Address::generate(&env);
    client.set_api_signer(&new_signer);

    // 3. The existing anchor is still intact — verify returns the correct record.
    let anchor = client
        .verify(&reading_hash)
        .expect("existing anchor must survive key rotation");
    assert_eq!(
        anchor.reading_hash, reading_hash,
        "reading_hash must be unchanged after rotation"
    );
    assert_eq!(
        anchor.anchored_at_ledger, 100,
        "ledger sequence must be preserved after rotation"
    );
    assert!(
        client.is_anchored(&reading_hash),
        "is_anchored must still return true after rotation"
    );
    assert_eq!(
        client.total_anchors(),
        1,
        "total_anchors must not change after rotation"
    );
}

// ---------------------------------------------------------------------------
// Test 2 — new readings use the new key and verify correctly
// ---------------------------------------------------------------------------

/// After rotation, the new api_signer can anchor new readings.
/// Those new readings verify correctly with the expected ledger sequence.
#[test]
fn new_readings_anchor_and_verify_with_new_key() {
    let (env, _admin, old_signer, client) = setup();

    // 1. Anchor one reading with the old key before rotation.
    env.ledger().set_sequence_number(50);
    let old_hash = make_hash(&env, 0x01);
    client
        .try_anchor(&old_signer, &old_hash, &make_nonce(&env, 1))
        .expect("pre-rotation anchor should succeed");

    // 2. Rotate the api_signer.
    let new_signer = Address::generate(&env);
    client.set_api_signer(&new_signer);

    // 3. Anchor a new reading with the new key.
    env.ledger().set_sequence_number(200);
    let new_hash = make_hash(&env, 0x02);
    client
        .try_anchor(&new_signer, &new_hash, &make_nonce(&env, 2))
        .expect("post-rotation anchor should succeed with new signer");

    // 4. New reading verifies correctly.
    assert!(
        client.is_anchored(&new_hash),
        "new reading must be anchored after rotation"
    );
    let anchor = client
        .verify(&new_hash)
        .expect("new anchor must be Some");
    assert_eq!(anchor.reading_hash, new_hash);
    assert_eq!(
        anchor.anchored_at_ledger, 200,
        "new anchor must record the correct ledger sequence"
    );

    // 5. Both old and new readings coexist.
    assert_eq!(
        client.total_anchors(),
        2,
        "both pre- and post-rotation anchors must be counted"
    );
    assert!(client.is_anchored(&old_hash), "pre-rotation anchor must still be valid");
}

// ---------------------------------------------------------------------------
// Test 3 — revoked old key cannot anchor new readings
// ---------------------------------------------------------------------------

/// After rotation the old api_signer must be rejected with `Error::Unauthorized`
/// for any attempt to anchor new readings.
#[test]
fn revoked_old_key_cannot_anchor_new_readings() {
    let (env, _admin, old_signer, client) = setup();

    // 1. Rotate immediately (no pre-rotation anchors needed for this test).
    let new_signer = Address::generate(&env);
    client.set_api_signer(&new_signer);

    // 2. Old signer tries to anchor a new reading — must be rejected.
    let new_hash = make_hash(&env, 0xCC);
    let result = client.try_anchor(&old_signer, &new_hash, &make_nonce(&env, 1));
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "old signer must receive Unauthorized after rotation"
    );

    // 3. The hash must not have been anchored.
    assert!(
        !client.is_anchored(&new_hash),
        "rejected anchor attempt must not store the hash"
    );
    assert_eq!(
        client.total_anchors(),
        0,
        "total_anchors must remain zero after a rejected call"
    );
}

// ---------------------------------------------------------------------------
// Test 4 — multiple rotations: each successive key works, all previous do not
// ---------------------------------------------------------------------------

/// Rotate the api_signer twice.  Each rotation revokes the previous key.
/// Only the most recent key can anchor; the two older keys must be rejected.
#[test]
fn successive_rotations_revoke_all_previous_keys() {
    let (env, _admin, key_v1, client) = setup();

    // Rotate to key_v2.
    let key_v2 = Address::generate(&env);
    client.set_api_signer(&key_v2);

    // Rotate to key_v3.
    let key_v3 = Address::generate(&env);
    client.set_api_signer(&key_v3);

    // key_v1 must be rejected.
    assert_eq!(
        client.try_anchor(&key_v1, &make_hash(&env, 0x10), &make_nonce(&env, 1)),
        Err(Ok(Error::Unauthorized)),
        "key_v1 must be rejected after two rotations"
    );

    // key_v2 must be rejected.
    assert_eq!(
        client.try_anchor(&key_v2, &make_hash(&env, 0x20), &make_nonce(&env, 2)),
        Err(Ok(Error::Unauthorized)),
        "key_v2 must be rejected after it was superseded"
    );

    // key_v3 (current) must succeed.
    client
        .try_anchor(&key_v3, &make_hash(&env, 0x30), &make_nonce(&env, 3))
        .expect("current key_v3 must be able to anchor");
    assert_eq!(client.total_anchors(), 1);
}
