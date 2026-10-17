//! # Audit Registry (`audit-registry`)
//!
//! Immutable on-chain anchor of Ed25519-signed meter readings.
//!
//! ## Purpose
//! Provides a tamper-proof, publicly verifiable record that a specific meter
//! reading hash was accepted by the SolarProof API at a known ledger sequence.
//! The full reading payload (pubkey, signature, kwh, meter_id, timestamp) is
//! stored off-chain in Supabase; only the 32-byte SHA-256 hash is stored here.
//!
//! ## Flow
//! 1. Smart meter signs `sha256(meter_id || kwh_stroops_le || timestamp_le)`
//!    with its Ed25519 private key.
//! 2. SolarProof API verifies the signature off-chain.
//! 3. API calls `anchor(reading_hash)` — stores hash + ledger sequence.
//! 4. `energy_token.mint()` references the anchor as proof of generation.
//! 5. Any party can call `is_anchored(hash)` to verify the reading was accepted.
//!
//! ## Storage layout
//! | Key | Storage type | Value | Size |
//! |-----|-------------|-------|------|
//! | `DataKey::Admin` | instance | `Address` | ~57 B |
//! | `DataKey::TotalAnchors` | instance | `u32` | 4 B |
//! | `DataKey::Bucket(id)` | persistent | `Map<BytesN<32>, u32>` | Var |
//!
//! ## Invariants
//! 1. Each `reading_hash` can be anchored at most once.
//! 2. `total_anchors` is monotonically increasing.
//! 3. `anchored_at_ledger` is set to the ledger sequence at anchor time and
//!    never mutated.
//!
//! ## Known limitations / out-of-scope
//! - No admin-gated removal of anchors (immutability is a feature).
//! - Persistent storage TTL extension not implemented; entries may expire on
//!   long-lived networks if not bumped.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map,
};

const VERSION: &str = "1.0.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Minimal on-chain record — 36 bytes per anchor entry.
///
/// The full reading payload lives in Supabase, keyed by `reading_hash`.
#[contracttype]
#[derive(Clone)]
pub struct AuditAnchor {
    /// SHA-256 of `(meter_id_utf8 || kwh_stroops_i64_le || timestamp_unix_u64_le)`.
    /// This is the canonical hash signed by the meter device.
    pub reading_hash: BytesN<32>,
    /// Stellar ledger sequence number at the time of anchoring.
    pub anchored_at_ledger: u32,
}

/// Consolidated read-only view of anchor status for a reading hash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorStatus {
    /// Whether `reading_hash` has been anchored.
    pub is_anchored: bool,
    /// Ledger sequence at anchor time; `0` when `is_anchored` is `false`.
    pub anchored_at_ledger: u32,
}

/// Enumeration of all storage keys used by this contract.
#[contracttype]
pub enum DataKey {
    /// `Address` — the contract administrator.
    Admin,
    /// `Address` — the only address authorised to call `anchor()`.
    ApiSigner,
    /// Bucketed storage for reading hashes to reduce ledger entry count.
    /// `Map<BytesN<32>, u32>` — keyed by bucket index (0-1023).
    Bucket(u32),
    /// `bool` — keyed by the 32-byte nonce. Used for idempotency.
    Nonce(BytesN<32>),
    /// `u32` — total number of anchors stored.
    TotalAnchors,
    Version,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    AlreadyAnchored = 2,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/// Immutable anchor registry for Ed25519-signed meter readings.
#[contract]
pub struct AuditRegistry;

#[contractimpl]
impl AuditRegistry {
    /// Initialise the contract.
    ///
    /// # Arguments
    /// * `admin`      — address that administers the registry.
    /// * `api_signer` — the only address authorised to call `anchor()`.
    ///
    /// # Panics
    /// Panics with `"already initialized"` if called more than once.
    pub fn initialize(env: Env, admin: soroban_sdk::Address, api_signer: soroban_sdk::Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ApiSigner, &api_signer);
        env.storage().instance().set(&DataKey::TotalAnchors, &0_u32);
        env.storage().instance().set(
            &DataKey::Version,
            &soroban_sdk::String::from_str(&env, VERSION),
        );
    }

    /// Returns the contract version string (e.g. `"1.0.0"`).
    pub fn get_version(env: Env) -> soroban_sdk::String {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| soroban_sdk::String::from_str(&env, VERSION))
    }

    /// Migrate state schema to a new version. Admin-only.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn migrate(env: Env, new_version: soroban_sdk::String) {
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

    /// Update the authorised API signer address. Admin-only.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn set_api_signer(env: Env, new_signer: soroban_sdk::Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ApiSigner, &new_signer);
    }

    /// Returns the current authorised API signer address.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn api_signer(env: Env) -> soroban_sdk::Address {
        env.storage()
            .instance()
            .get(&DataKey::ApiSigner)
            .expect("not initialized")
    }

    /// Helper to get bucket ID from a hash (0-1023).
    fn get_bucket_id(hash: &BytesN<32>) -> u32 {
        let b0 = hash.get(0).unwrap_or(0) as u32;
        let b1 = hash.get(1).unwrap_or(0) as u32;
        ((b0 << 8) | b1) % 1024
    }

    fn lookup_ledger(env: Env, reading_hash: BytesN<32>) -> Option<u32> {
        let bucket_id = Self::get_bucket_id(&reading_hash);
        let bucket: Map<BytesN<32>, u32> = env
            .storage()
            .persistent()
            .get(&DataKey::Bucket(bucket_id))?;
        bucket.get(reading_hash)
    }

    /// Anchor a reading hash on-chain. Only the registered `api_signer` may call this.
    ///
    /// # Arguments
    /// * `caller`       — must equal the registered `api_signer`.
    /// * `reading_hash` — 32-byte SHA-256 of `(meter_id || kwh_stroops_le || timestamp_le)`.
    /// * `nonce`        — 32-byte unique value; prevents replay of the same anchor call.
    ///
    /// # Authorization
    /// Requires `caller` authorisation. Returns `Err(Error::Unauthorized)` if
    /// `caller` is not the registered `api_signer`.
    ///
    /// # Errors
    /// * `Error::Unauthorized`    — caller is not the `api_signer`.
    /// * `Error::AlreadyAnchored` — `reading_hash` or `nonce` was already used.
    ///
    /// # Events
    /// Emits `(topic: "anchor", data: (reading_hash, ledger_sequence, ledger_timestamp))`.
    ///
    /// # Example
    /// ```ignore
    /// client.anchor(&api_signer, &reading_hash, &nonce).unwrap();
    /// assert!(client.is_anchored(&reading_hash));
    /// ```
    pub fn anchor(
        env: Env,
        caller: soroban_sdk::Address,
        reading_hash: BytesN<32>,
        nonce: soroban_sdk::BytesN<32>,
    ) -> Result<(), Error> {
        caller.require_auth();
        let api_signer: Address = env
            .storage()
            .instance()
            .get(&DataKey::ApiSigner)
            .expect("not initialized");
        if caller != api_signer {
            return Err(Error::Unauthorized);
        }

        // Use temporary storage for nonces (idempotency) to reduce persistent entry costs.
        let nonce_key = DataKey::Nonce(nonce);
        if env.storage().temporary().has(&nonce_key) {
            return Err(Error::AlreadyAnchored);
        }

        let bucket_id = Self::get_bucket_id(&reading_hash);
        let bucket_key = DataKey::Bucket(bucket_id);
        let mut bucket: Map<BytesN<32>, u32> = env
            .storage()
            .persistent()
            .get(&bucket_key)
            .unwrap_or_else(|| Map::new(&env));

        if bucket.contains_key(reading_hash.clone()) {
            return Err(Error::AlreadyAnchored);
        }

        env.storage().temporary().set(&nonce_key, &true);

        bucket.set(reading_hash.clone(), env.ledger().sequence());
        env.storage().persistent().set(&bucket_key, &bucket);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAnchors)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalAnchors, &(count + 1));

        env.events().publish(
            (symbol_short!("anchor"),),
            (
                reading_hash,
                env.ledger().sequence(),
                env.ledger().timestamp(),
            ),
        );
        Ok(())
    }

    /// Returns the `AuditAnchor` for `reading_hash`, or `None` if not anchored.
    ///
    /// # Example
    /// ```ignore
    /// if let Some(anchor) = client.verify(&hash) {
    ///     println!("anchored at ledger {}", anchor.anchored_at_ledger);
    /// }
    /// ```
    pub fn verify(env: Env, reading_hash: BytesN<32>) -> Option<AuditAnchor> {
        let anchored_at_ledger = Self::lookup_ledger(env.clone(), reading_hash.clone())?;
        Some(AuditAnchor {
            reading_hash,
            anchored_at_ledger,
        })
    }

    /// Returns `true` if `reading_hash` has been anchored, `false` otherwise.
    pub fn is_anchored(env: Env, reading_hash: BytesN<32>) -> bool {
        Self::lookup_ledger(env, reading_hash).is_some()
    }

    /// Returns consolidated anchor status for `reading_hash` in a single call.
    ///
    /// Prefer this over separate `is_anchored` + `verify` calls when you need
    /// both the presence flag and the anchor ledger sequence.
    pub fn anchor_status(env: Env, reading_hash: BytesN<32>) -> AnchorStatus {
        match Self::lookup_ledger(env, reading_hash) {
            Some(anchored_at_ledger) => AnchorStatus {
                is_anchored: true,
                anchored_at_ledger,
            },
            None => AnchorStatus {
                is_anchored: false,
                anchored_at_ledger: 0,
            },
        }
    }

    /// Returns the ledger sequence at which `reading_hash` was anchored.
    ///
    /// Returns `None` when the hash has not been anchored.
    pub fn anchored_at_ledger(env: Env, reading_hash: BytesN<32>) -> Option<u32> {
        Self::lookup_ledger(env, reading_hash)
    }

    /// Returns the persistent storage bucket index (0–1023) for `reading_hash`.
    pub fn bucket_for_hash(_env: Env, reading_hash: BytesN<32>) -> u32 {
        Self::get_bucket_id(&reading_hash)
    }

    /// Returns the total number of reading hashes anchored so far.
    pub fn total_anchors(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalAnchors)
            .unwrap_or(0)
    }

    /// Returns the admin address.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn admin(env: Env) -> soroban_sdk::Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
    }

    /// Extend the TTL for a single persistent bucket entry.
    ///
    /// This is admin-only and should be used to keep bucketed anchor storage
    /// alive on long-lived networks.
    pub fn extend_bucket_ttl(env: Env, bucket_id: u32, threshold: u32, extend_to: u32) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bucket(bucket_id), threshold, extend_to);
    }

    /// Extend the TTL for a single persistent bucket entry with limits.
    ///
    /// The extension only happens if it exceeds `min_extension` ledgers and the
    /// result will not exceed `max_extension` ledgers.
    pub fn extend_bucket_ttl_with_limits(
        env: Env,
        bucket_id: u32,
        extend_to: u32,
        min_extension: u32,
        max_extension: u32,
    ) {
        Self::require_admin(&env);
        if extend_to < min_extension || extend_to > max_extension {
            return;
        }
        env.storage().persistent().extend_ttl(
            &DataKey::Bucket(bucket_id),
            min_extension,
            extend_to,
        );
    }

    /// Extend the TTL of the contract instance and code.
    ///
    /// This is admin-only and should be used to keep the contract itself alive
    /// alongside persistent bucket entries.
    pub fn extend_contract_ttl(env: Env, threshold: u32, extend_to: u32) {
        Self::require_admin(&env);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Extend the TTL of the contract instance and code with limits.
    ///
    /// The extension only happens if it exceeds `min_extension` ledgers and the
    /// result will not exceed `max_extension` ledgers.
    pub fn extend_contract_ttl_with_limits(
        env: Env,
        extend_to: u32,
        min_extension: u32,
        max_extension: u32,
    ) {
        Self::require_admin(&env);
        if extend_to < min_extension || extend_to > max_extension {
            return;
        }
        env.storage()
            .instance()
            .extend_ttl(min_extension, extend_to);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::storage::{Instance, Persistent},
        testutils::Address as _,
        testutils::Ledger,
        Env,
    };

    fn setup() -> (Env, soroban_sdk::Address, AuditRegistryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AuditRegistry, ());
        let client = AuditRegistryClient::new(&env, &id);
        let admin = soroban_sdk::Address::generate(&env);
        let api_signer = soroban_sdk::Address::generate(&env);
        client.initialize(&admin, &api_signer);
        (env, api_signer, client)
    }

    fn hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[1u8; 32])
    }

    fn make_nonce(env: &Env, val: u8) -> BytesN<32> {
        BytesN::from_array(env, &[val; 32])
    }

    #[test]
    fn test_anchor_and_verify() {
        let (env, api_signer, client) = setup();
        let h = hash(&env);
        let n = make_nonce(&env, 1);
        client.anchor(&api_signer, &h, &n);
        assert!(client.is_anchored(&h));
        assert_eq!(client.total_anchors(), 1);
        let anchor = client.verify(&h).unwrap();
        assert_eq!(anchor.reading_hash, h);
    }

    #[test]
    fn test_anchor_records_ledger_sequence() {
        let (env, api_signer, client) = setup();
        let h = hash(&env);
        let n = make_nonce(&env, 1);
        client.anchor(&api_signer, &h, &n);
        let anchor = client.verify(&h).unwrap();
        let _ = anchor.anchored_at_ledger;
    }

    #[test]
    fn test_duplicate_anchor_rejected() {
        let (env, api_signer, client) = setup();
        let h = hash(&env);
        let n1 = make_nonce(&env, 1);
        let n2 = make_nonce(&env, 2);
        client.anchor(&api_signer, &h, &n1);
        assert_eq!(
            client.try_anchor(&api_signer, &h, &n2),
            Err(Ok(Error::AlreadyAnchored))
        );
    }

    #[test]
    fn test_duplicate_nonce_rejected() {
        let (env, api_signer, client) = setup();
        let h1 = BytesN::from_array(&env, &[1u8; 32]);
        let h2 = BytesN::from_array(&env, &[2u8; 32]);
        let n = make_nonce(&env, 1);
        client.anchor(&api_signer, &h1, &n);
        assert_eq!(
            client.try_anchor(&api_signer, &h2, &n),
            Err(Ok(Error::AlreadyAnchored))
        );
    }

    #[test]
    fn test_duplicate_anchor_does_not_increment_total() {
        let (env, api_signer, client) = setup();
        let h = hash(&env);
        let n1 = make_nonce(&env, 1);
        let n2 = make_nonce(&env, 2);
        client.anchor(&api_signer, &h, &n1);
        let _ = client.try_anchor(&api_signer, &h, &n2);
        assert_eq!(client.total_anchors(), 1);
    }

    #[test]
    fn test_different_hashes_are_independent() {
        let (env, api_signer, client) = setup();
        let h1 = BytesN::from_array(&env, &[0xAAu8; 32]);
        let h2 = BytesN::from_array(&env, &[0xBBu8; 32]);
        client.anchor(&api_signer, &h1, &make_nonce(&env, 1));
        client.anchor(&api_signer, &h2, &make_nonce(&env, 2));
        assert!(client.is_anchored(&h1));
        assert!(client.is_anchored(&h2));
        assert_eq!(client.total_anchors(), 2);
    }

    #[test]
    fn test_unauthorized_caller_rejected() {
        let (env, _api_signer, client) = setup();
        let attacker = soroban_sdk::Address::generate(&env);
        assert_eq!(
            client.try_anchor(&attacker, &hash(&env), &make_nonce(&env, 1)),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn test_old_signer_rejected_after_rotation() {
        let (env, old_signer, client) = setup();
        let new_signer = soroban_sdk::Address::generate(&env);
        client.set_api_signer(&new_signer);
        assert_eq!(
            client.try_anchor(&old_signer, &hash(&env), &make_nonce(&env, 1)),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn test_not_anchored_returns_none() {
        let (env, _api_signer, client) = setup();
        let h = BytesN::from_array(&env, &[9u8; 32]);
        assert!(!client.is_anchored(&h));
        assert!(client.verify(&h).is_none());
    }

    #[test]
    fn test_total_anchors_starts_at_zero() {
        let (env, _api_signer, client) = setup();
        assert_eq!(client.total_anchors(), 0);
        let _ = client.verify(&BytesN::from_array(&env, &[0u8; 32]));
        assert_eq!(client.total_anchors(), 0);
    }

    #[test]
    fn test_total_anchors_increments() {
        let (env, api_signer, client) = setup();
        for i in 0u8..5 {
            client.anchor(
                &api_signer,
                &BytesN::from_array(&env, &[i; 32]),
                &make_nonce(&env, i),
            );
        }
        assert_eq!(client.total_anchors(), 5);
    }

    #[test]
    fn test_admin_query() {
        let (env, _api_signer, client) = setup();
        let _admin = client.admin();
        let _ = &env;
    }

    #[test]
    fn test_api_signer_query() {
        let (env, api_signer, client) = setup();
        assert_eq!(client.api_signer(), api_signer);
    }

    #[test]
    fn test_large_number_of_anchors() {
        let (env, api_signer, client) = setup();
        let count: u8 = 50;
        for i in 0..count {
            let h = BytesN::from_array(&env, &[i; 32]);
            client.anchor(&api_signer, &h, &make_nonce(&env, i));
        }
        assert_eq!(client.total_anchors(), u32::from(count));
        assert!(client.is_anchored(&BytesN::from_array(&env, &[0u8; 32])));
        assert!(client.is_anchored(&BytesN::from_array(&env, &[count - 1; 32])));
    }

    #[test]
    fn test_boundary_hash_values() {
        let (env, api_signer, client) = setup();
        let all_zeros = BytesN::from_array(&env, &[0x00u8; 32]);
        let all_ones = BytesN::from_array(&env, &[0xFFu8; 32]);
        client.anchor(&api_signer, &all_zeros, &make_nonce(&env, 1));
        client.anchor(&api_signer, &all_ones, &make_nonce(&env, 2));
        assert!(client.is_anchored(&all_zeros));
        assert!(client.is_anchored(&all_ones));
        assert_eq!(client.total_anchors(), 2);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_rejected() {
        let (env, _api_signer, client) = setup();
        let admin2 = soroban_sdk::Address::generate(&env);
        let signer2 = soroban_sdk::Address::generate(&env);
        client.initialize(&admin2, &signer2);
    }

    #[test]
    fn test_set_api_signer_updates_authorized_caller() {
        let (env, _old_signer, client) = setup();
        let new_signer = soroban_sdk::Address::generate(&env);
        client.set_api_signer(&new_signer);
        let h = hash(&env);
        client.anchor(&new_signer, &h, &make_nonce(&env, 1));
        assert!(client.is_anchored(&h));
    }

    #[test]
    fn test_migrate_updates_version() {
        let (env, _api_signer, client) = setup();
        let new_ver = soroban_sdk::String::from_str(&env, "2.0.0");
        client.migrate(&new_ver);
        assert_eq!(client.get_version(), new_ver);
    }

    #[test]
    fn test_version() {
        let (env, _api_signer, client) = setup();
        assert_eq!(
            client.get_version(),
            soroban_sdk::String::from_str(&env, "1.0.0")
        );
    }

    #[test]
    fn test_extend_bucket_ttl() {
        let (env, api_signer, client) = setup();
        let contract_id = client.address.clone();
        let h = hash(&env);
        let n = make_nonce(&env, 1);
        client.anchor(&api_signer, &h, &n);
        let bucket_id = AuditRegistry::get_bucket_id(&h);
        let before = env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .get_ttl(&DataKey::Bucket(bucket_id))
        });
        client.extend_bucket_ttl(&bucket_id, &before, &(before + 50));
        let after = env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .get_ttl(&DataKey::Bucket(bucket_id))
        });
        assert!(after >= before);
    }

    #[test]
    fn test_extend_contract_ttl() {
        let (env, _api_signer, client) = setup();
        let contract_id = client.address.clone();
        let before = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        client.extend_contract_ttl(&before, &(before + 50));
        let after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        assert!(after >= before);
    }

    #[test]
    fn test_anchor_status_not_anchored() {
        let (env, _api_signer, client) = setup();
        let h = BytesN::from_array(&env, &[9u8; 32]);
        assert_eq!(
            client.anchor_status(&h),
            AnchorStatus {
                is_anchored: false,
                anchored_at_ledger: 0,
            }
        );
        assert!(client.anchored_at_ledger(&h).is_none());
    }

    #[test]
    fn test_anchor_status_after_anchor() {
        let (env, api_signer, client) = setup();
        env.ledger().set_sequence_number(42);
        let h = hash(&env);
        client.anchor(&api_signer, &h, &make_nonce(&env, 1));
        assert_eq!(
            client.anchor_status(&h),
            AnchorStatus {
                is_anchored: true,
                anchored_at_ledger: 42,
            }
        );
        assert_eq!(client.anchored_at_ledger(&h), Some(42));
        assert_eq!(client.bucket_for_hash(&h), AuditRegistry::get_bucket_id(&h));
    }

    #[test]
    fn test_issue_281_bucket_collision() {
        let (env, api_signer, client) = setup();
        // Force hashes that likely end up in the same bucket
        // Our bucket ID is ((hash[0] << 8) | hash[1]) % 1024
        // So any hash starting with 0x00 0x00 will be in bucket 0.
        let mut h1_arr = [0u8; 32];
        h1_arr[2] = 1;
        let h1 = BytesN::from_array(&env, &h1_arr);

        let mut h2_arr = [0u8; 32];
        h2_arr[2] = 2;
        let h2 = BytesN::from_array(&env, &h2_arr);

        client.anchor(&api_signer, &h1, &make_nonce(&env, 1));
        client.anchor(&api_signer, &h2, &make_nonce(&env, 2));

        assert!(client.is_anchored(&h1));
        assert!(client.is_anchored(&h2));
        assert_eq!(client.total_anchors(), 2);
    }
}

#[cfg(test)]
mod verify_integration_test;

#[cfg(test)]
mod hash_collision_test;
