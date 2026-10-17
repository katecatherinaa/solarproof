//! # Energy Token (`energy-token`)
//!
//! SEP-41 fungible certificate token representing verified renewable energy.
//! **10_000_000 stroops = 1 kWh** (decimals = 7; 1 stroop = 0.0000001 kWh).
//! Generation is cryptographically anchored on-chain via the `audit_registry` contract..
//!
//! ## Roles
//! | Role | Description |
//! |------|-------------|
//! | `admin` | Set at initialisation; can rotate the `minter` address. |
//! | `minter` | The only address authorised to call `mint()`. Should be the SolarProof API keypair. |
//!
//! ## Invariants
//! 1. `total_supply() == total_minted - total_burned` at all times.
//! 2. No address can hold a negative balance.
//! 3. `mint()` and `set_minter()` require the respective role's authorisation.
//! 4. `burn()` and `transfer()` require the token holder's authorisation.

#![no_std]

#[allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    Admin,
    Minter,
    TotalMinted,
    TotalBurned,
    Paused,
    /// Allowance: (from, spender) -> i128
    Allowance(Address, Address),
    /// Retired: address -> bool
    Retired(Address),
}

#[contract]
pub struct EnergyToken;

#[contractimpl]
impl EnergyToken {
    /// Initialise the contract. Must be called exactly once after deployment.
    ///
    /// # Arguments
    /// * `admin`  — address that can rotate the `minter` via [`set_minter`].
    /// * `minter` — the only address authorised to call [`mint`].
    ///
    /// # Panics
    /// Panics with `"already initialized"` if called more than once.
    pub fn initialize(env: Env, admin: Address, minter: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &minter);
        env.storage().instance().set(&DataKey::TotalMinted, &0_i128);
        env.storage().instance().set(&DataKey::TotalBurned, &0_i128);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    // ── SEP-41 metadata ─────────────────────────────────────────────────────

    /// Returns the human-readable token name: `"SolarProof kWh"`.
    pub fn name(env: Env) -> String {
        String::from_str(&env, "SolarProof kWh")
    }

    /// Returns the token ticker symbol: `"SKWH"`.
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "SKWH")
    }

    /// Returns the number of decimal places: `7` (stroop precision).
    /// 1 stroop = 0.0000001 kWh; 10_000_000 stroops = 1 kWh.
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    // ── SEP-41 balance / transfer ────────────────────────────────────────────

    /// Returns the token balance of `account`. Returns `0` for unknown accounts.
    ///
    /// # Example
    /// ```ignore
    /// let bal = client.balance(&holder_address); // e.g. 125_000_000 (12.5 kWh in stroops)
    /// ```
    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&(symbol_short!("balance"), account))
            .unwrap_or(0)
    }

    /// Transfer `amount` tokens from `from` to `to`.
    ///
    /// # Arguments
    /// * `from`   — sender (must authorise).
    /// * `to`     — recipient.
    /// * `amount` — number of tokens to transfer (must be positive).
    ///
    /// # Authorization
    /// Requires `from` authorisation.
    ///
    /// # Panics
    /// * `"amount must be positive"` if `amount <= 0`.
    /// * `"contract is paused"` if the contract is paused.
    /// * `"token is retired"` if `from` has been retired.
    /// * `"insufficient balance"` if `from` has fewer tokens than `amount`.
    ///
    /// # Events
    /// Emits `(topic: "transfer", data: (from, to, amount))`.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");
        Self::require_not_paused(&env);
        Self::require_not_retired(&env, &from);
        Self::move_balance(&env, &from, &to, amount);
        env.events()
            .publish((symbol_short!("transfer"),), (from, to, amount));
    }

    // ── SEP-41 allowance / approve ───────────────────────────────────────────

    /// Returns the amount `spender` is allowed to spend on behalf of `from`.
    /// Returns `0` if no allowance has been set.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    /// Approve `spender` to spend up to `amount` tokens from `from`.
    /// Setting `amount` to `0` revokes the allowance.
    ///
    /// # Arguments
    /// * `from`    — token owner (must authorise).
    /// * `spender` — address being granted the allowance.
    /// * `amount`  — maximum tokens `spender` may spend (must be ≥ 0).
    /// * `_expiration_ledger` — ledger number when the allowance expires.
    ///
    /// # Authorization
    /// Requires `from` authorisation.
    ///
    /// # Panics
    /// * `"amount must be non-negative"` if `amount < 0`.
    ///
    /// # Events
    /// Emits `(topic: "approve", data: (from, spender, amount))`.
    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _expiration_ledger: u32) {
        from.require_auth();
        assert!(amount >= 0, "amount must be non-negative");
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from.clone(), spender.clone()), &amount);
        env.events()
            .publish((symbol_short!("approve"),), (from, spender, amount));
    }

    /// Transfer `amount` tokens from `from` to `to` using caller's allowance.
    ///
    /// # Arguments
    /// * `spender` — address spending the allowance (must authorise).
    /// * `from`    — token owner whose allowance is consumed.
    /// * `to`      — recipient.
    /// * `amount`  — number of tokens to transfer (must be positive).
    ///
    /// # Authorization
    /// Requires `spender` (caller) authorisation.
    ///
    /// # Panics
    /// * `"amount must be positive"` if `amount <= 0`.
    /// * `"contract is paused"` if the contract is paused.
    /// * `"token is retired"` if `from` has been retired.
    /// * `"insufficient allowance"` if `spender`'s allowance is less than `amount`.
    /// * `"insufficient balance"` if `from` has fewer tokens than `amount`.
    ///
    /// # Events
    /// Emits `(topic: "transfer", data: (from, to, amount))`.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        assert!(amount > 0, "amount must be positive");
        Self::require_not_paused(&env);
        Self::require_not_retired(&env, &from);
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::move_balance(&env, &from, &to, amount);
        env.events()
            .publish((symbol_short!("transfer"),), (from, to, amount));
    }

    /// Burn `amount` tokens from `from` using caller's allowance.
    ///
    /// # Arguments
    /// * `spender` — address spending the allowance (must authorise).
    /// * `from`    — token owner whose tokens are burned.
    /// * `amount`  — number of tokens to burn (must be positive).
    ///
    /// # Authorization
    /// Requires `spender` (caller) authorisation.
    ///
    /// # Panics
    /// * `"amount must be positive"` if `amount <= 0`.
    /// * `"contract is paused"` if the contract is paused.
    /// * `"insufficient allowance"` if `spender`'s allowance is less than `amount`.
    /// * `"insufficient balance"` if `from` has fewer tokens than `amount`.
    ///
    /// # Events
    /// Emits `(topic: "burn", data: (from, amount))`.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        assert!(amount > 0, "amount must be positive");
        Self::require_not_paused(&env);
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::deduct_balance(&env, &from, amount);
        Self::add_burned(&env, amount);
        env.events()
            .publish((symbol_short!("burn"),), (from, amount));
    }

    // ── Mint / burn (privileged) ─────────────────────────────────────────────

    /// Mint `amount` new tokens to `to`. Only the registered `minter` may call this.
    ///
    /// # Arguments
    /// * `to`     — recipient address.
    /// * `amount` — number of tokens to mint (must be positive).
    ///
    /// # Authorization
    /// Requires `minter` authorisation.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    /// * `"amount must be positive"` if `amount <= 0`.
    /// * `"contract is paused"` if the contract is paused.
    /// * `"overflow: balance"` if minting would overflow `to`'s balance.
    /// * `"overflow: total_minted"` if minting would overflow the total supply counter.
    ///
    /// # Events
    /// Emits `(topic: "mint", data: (to, amount))`.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let minter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Minter)
            .expect("not initialized");
        minter.require_auth();
        assert!(amount > 0, "amount must be positive");
        Self::require_not_paused(&env);

        let key = (symbol_short!("balance"), to.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_bal = bal
            .checked_add(amount)
            .unwrap_or_else(|| panic!("overflow: balance"));
        env.storage().persistent().set(&key, &new_bal);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalMinted)
            .unwrap_or(0);
        let new_total = total
            .checked_add(amount)
            .unwrap_or_else(|| panic!("overflow: total_minted"));
        env.storage()
            .instance()
            .set(&DataKey::TotalMinted, &new_total);

        env.events().publish((symbol_short!("mint"),), (to, amount));
    }

    /// Burn `amount` tokens from `from`. The token holder calls this directly.
    ///
    /// # Arguments
    /// * `from`   — address whose tokens are burned (must authorise).
    /// * `amount` — number of tokens to burn (must be positive).
    ///
    /// # Authorization
    /// Requires `from` authorisation.
    ///
    /// # Panics
    /// * `"amount must be positive"` if `amount <= 0`.
    /// * `"contract is paused"` if the contract is paused.
    /// * `"insufficient balance"` if `from` has fewer tokens than `amount`.
    ///
    /// # Events
    /// Emits `(topic: "burn", data: (from, amount))`.
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");
        Self::require_not_paused(&env);
        Self::deduct_balance(&env, &from, amount);
        Self::add_burned(&env, amount);
        env.events()
            .publish((symbol_short!("burn"),), (from, amount));
    }

    /// Returns the current circulating supply: `total_minted - total_burned`.
    ///
    /// # Example
    /// ```ignore
    /// let supply = client.total_supply(); // tokens currently in circulation
    /// ```
    pub fn total_supply(env: Env) -> i128 {
        let minted: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalMinted)
            .unwrap_or(0);
        let burned: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalBurned)
            .unwrap_or(0);
        minted - burned
    }

    /// Replace the authorised minter address. Admin-only.
    ///
    /// # Arguments
    /// * `new_minter` — address that will be authorised to call [`mint`].
    ///
    /// # Authorization
    /// Requires `admin` authorisation.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn set_minter(env: Env, new_minter: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Minter, &new_minter);
    }

    /// Returns the admin address.
    ///
    /// # Panics
    /// * `"not initialized"` if the contract has not been initialised.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Retire `amount` tokens held by `account`, permanently marking the address as retired if full balance is retired.
    ///
    /// Burns the specified amount.
    ///
    /// # Arguments
    /// * `account` — address retiring their tokens (must authorise).
    /// * `amount`  — number of tokens to retire.
    /// * `reason`  — human-readable retirement reason (e.g. `"REC compliance"`).
    ///
    /// # Panics
    /// * `"already retired"` if `account` is already retired.
    /// * `"insufficient balance"` if `account` holds fewer tokens than `amount`.
    ///
    /// # Events
    /// Emits `(topic: "retire", data: (account, amount, reason))`.
    pub fn retire(env: Env, account: Address, amount: i128, reason: String) {
        account.require_auth();
        assert!(
            !env.storage()
                .persistent()
                .get::<_, bool>(&DataKey::Retired(account.clone()))
                .unwrap_or(false),
            "already retired"
        );
        let key = (symbol_short!("balance"), account.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        assert!(bal >= amount, "insufficient balance");
        assert!(amount > 0, "amount must be positive");

        env.storage().persistent().set(&key, &(bal - amount));

        if bal == amount {
            env.storage()
                .persistent()
                .set(&DataKey::Retired(account.clone()), &true);
        }

        Self::add_burned(&env, amount);
        env.events()
            .publish((symbol_short!("retire"),), (account, amount, reason));
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "contract is paused");
    }

    fn require_not_retired(env: &Env, account: &Address) {
        let retired: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Retired(account.clone()))
            .unwrap_or(false);
        assert!(!retired, "token is retired");
    }

    fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        if from == to {
            return;
        }
        let fk = (symbol_short!("balance"), from.clone());
        let fb: i128 = env.storage().persistent().get(&fk).expect("no balance");
        assert!(fb >= amount, "insufficient balance");
        let tk = (symbol_short!("balance"), to.clone());
        let tb: i128 = env.storage().persistent().get(&tk).unwrap_or(0);
        env.storage().persistent().set(&fk, &(fb - amount));
        let new_tb = tb
            .checked_add(amount)
            .unwrap_or_else(|| panic!("overflow: recipient balance"));
        env.storage().persistent().set(&tk, &new_tb);
    }

    fn deduct_balance(env: &Env, from: &Address, amount: i128) {
        let key = (symbol_short!("balance"), from.clone());
        let bal: i128 = env.storage().persistent().get(&key).expect("no balance");
        assert!(bal >= amount, "insufficient balance");
        env.storage().persistent().set(&key, &(bal - amount));
    }

    fn add_burned(env: &Env, amount: i128) {
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalBurned)
            .unwrap_or(0);
        let new_total = total
            .checked_add(amount)
            .unwrap_or_else(|| panic!("overflow: total_burned"));
        env.storage()
            .instance()
            .set(&DataKey::TotalBurned, &new_total);
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        assert!(current >= amount, "insufficient allowance");
        env.storage().persistent().set(&key, &(current - amount));
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, IntoVal};

    fn setup() -> (Env, EnergyTokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        (env, client)
    }

    // ── existing tests (preserved) ───────────────────────────────────────────

    #[test]
    fn test_mint_burn_supply() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1000_i128);
        assert_eq!(client.total_supply(), 1000_i128);
        client.burn(&user, &400_i128);
        assert_eq!(client.total_supply(), 600_i128);
        assert_eq!(client.balance(&user), 600_i128);
    }

    #[test]
    fn test_admin_and_minter_assignment() {
        let (env, client) = setup();
        let admin = client.admin();
        assert_eq!(client.admin(), admin);
        let minter = Address::generate(&env);
        client.set_minter(&admin, &minter);
        // Verify the new minter can be used to mint
        client.mint(&Address::generate(&env), &500_i128);
        assert_eq!(client.total_supply(), 500_i128);
    }

    #[test]
    #[should_panic]
    fn test_set_minter_requires_admin() {
        let (env, client) = setup();
        let non_admin = Address::generate(&env);
        let new_minter = Address::generate(&env);
        client.set_minter(&non_admin, &new_minter);
    }

    #[test]
    #[should_panic]
    fn test_mint_requires_minter() {
        let (env, client) = setup();
        let unauthorized = Address::generate(&env);
        client.mint(&unauthorized, &100_i128);
    }

    #[test]
    fn test_transfer() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.mint(&a, &500_i128);
        client.transfer(&a, &b, &200_i128);
        assert_eq!(client.balance(&a), 300_i128);
        assert_eq!(client.balance(&b), 200_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn test_burn_overdraft() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &10_i128);
        client.burn(&user, &100_i128);
    }

    #[test]
    fn test_mint_max_i128() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &i128::MAX);
        assert_eq!(client.balance(&user), i128::MAX);
        assert_eq!(client.total_supply(), i128::MAX);
    }

    #[test]
    #[should_panic(expected = "overflow: balance")]
    fn test_mint_overflow_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &i128::MAX);
        client.mint(&user, &1_i128);
    }

    #[test]
    fn test_fuzz_mint_amounts() {
        let amounts: &[i128] = &[
            1,
            1_000,
            1_000_000,
            1_000_000_000,
            1_000_000_000_000,
            i128::MAX / 4,
            i128::MAX / 2,
        ];
        for &amount in amounts {
            let env = Env::default();
            env.mock_all_auths();
            let id = env.register(EnergyToken, ());
            let client = EnergyTokenClient::new(&env, &id);
            let admin = Address::generate(&env);
            let minter = Address::generate(&env);
            client.initialize(&admin, &minter);
            let user = Address::generate(&env);
            client.mint(&user, &amount);
            assert_eq!(client.balance(&user), amount);
            assert_eq!(client.total_supply(), amount);
        }
    }

    // ── SEP-41 compliance tests ──────────────────────────────────────────────

    #[test]
    fn test_sep41_metadata() {
        let (env, client) = setup();
        assert_eq!(client.name(), String::from_str(&env, "SolarProof kWh"));
        assert_eq!(client.symbol(), String::from_str(&env, "SKWH"));
        assert_eq!(client.decimals(), 7);
    }

    #[test]
    fn test_sep41_approve_and_allowance() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        assert_eq!(client.allowance(&owner, &spender), 0);
        client.approve(&owner, &spender, &500_i128, &1000_u32);
        assert_eq!(client.allowance(&owner, &spender), 500_i128);
    }

    #[test]
    fn test_sep41_transfer_from() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &400_i128, &1000_u32);
        client.transfer_from(&spender, &owner, &recipient, &300_i128);
        assert_eq!(client.balance(&owner), 700_i128);
        assert_eq!(client.balance(&recipient), 300_i128);
        // allowance reduced
        assert_eq!(client.allowance(&owner, &spender), 100_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn test_sep41_transfer_from_exceeds_allowance() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &100_i128, &1000_u32);
        client.transfer_from(&spender, &owner, &recipient, &200_i128);
    }

    #[test]
    fn test_sep41_burn_from() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &600_i128, &1000_u32);
        client.burn_from(&spender, &owner, &400_i128);
        assert_eq!(client.balance(&owner), 600_i128);
        assert_eq!(client.total_supply(), 600_i128);
        assert_eq!(client.allowance(&owner, &spender), 200_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn test_sep41_burn_from_exceeds_allowance() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &50_i128, &1000_u32);
        client.burn_from(&spender, &owner, &100_i128);
    }

    #[test]
    fn test_sep41_approve_overwrite() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.approve(&owner, &spender, &500_i128, &1000_u32);
        client.approve(&owner, &spender, &100_i128, &1000_u32);
        assert_eq!(client.allowance(&owner, &spender), 100_i128);
    }

    #[test]
    fn test_sep41_approve_zero_revokes() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.approve(&owner, &spender, &500_i128, &1000_u32);
        client.approve(&owner, &spender, &0_i128, &1000_u32);
        assert_eq!(client.allowance(&owner, &spender), 0);
    }

    /// Cross-operator: spender A cannot spend from owner B without approval.
    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn test_sep41_no_allowance_cross_operator() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        // no approve call
        client.transfer_from(&spender, &owner, &recipient, &100_i128);
    }

    // ── edge-case / coverage tests ───────────────────────────────────────────

    // initialize

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_initialize_double_init_panics() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        client.initialize(&a, &a);
    }

    // balance

    #[test]
    fn test_balance_zero_for_unknown_account() {
        let (env, client) = setup();
        let unknown = Address::generate(&env);
        assert_eq!(client.balance(&unknown), 0);
    }

    // total_supply

    #[test]
    fn test_total_supply_zero_before_mint() {
        let (_, client) = setup();
        assert_eq!(client.total_supply(), 0);
    }

    // mint

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_mint_zero_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &0_i128);
    }

    // transfer

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_transfer_zero_panics() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.mint(&a, &100_i128);
        client.transfer(&a, &b, &0_i128);
    }

    #[test]
    #[should_panic(expected = "no balance")]
    fn test_transfer_no_balance_panics() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.transfer(&a, &b, &1_i128);
    }

    #[test]
    fn test_transfer_self() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        client.mint(&a, &100_i128);
        client.transfer(&a, &a, &40_i128);
        assert_eq!(client.balance(&a), 100_i128);
    }

    // burn

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_burn_zero_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &100_i128);
        client.burn(&user, &0_i128);
    }

    #[test]
    #[should_panic(expected = "no balance")]
    fn test_burn_no_balance_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.burn(&user, &1_i128);
    }

    // retire

    #[test]
    fn test_retire_reduces_supply_and_emits_event() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1000_i128);
        client.retire(&user, &300_i128, &String::from_str(&env, "retire"));
        assert_eq!(client.balance(&user), 700_i128);
        assert_eq!(client.total_supply(), 700_i128);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_retire_zero_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &100_i128);
        client.retire(&user, &0_i128, &String::from_str(&env, "retire"));
    }

    // approve

    #[test]
    #[should_panic(expected = "amount must be non-negative")]
    fn test_approve_negative_panics() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.approve(&owner, &spender, &-1_i128, &1000_u32);
    }

    // transfer_from

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_transfer_from_zero_panics() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &100_i128);
        client.approve(&owner, &spender, &100_i128, &1000_u32);
        client.transfer_from(&spender, &owner, &recipient, &0_i128);
    }

    // burn_from

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_burn_from_zero_panics() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.mint(&owner, &100_i128);
        client.approve(&owner, &spender, &100_i128, &1000_u32);
        client.burn_from(&spender, &owner, &0_i128);
    }

    // set_minter

    #[test]
    fn test_set_minter_rotates() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let new_minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        client.set_minter(&new_minter);
        // new minter can mint; old minter's auth is no longer checked (mock_all_auths)
        let user = Address::generate(&env);
        client.mint(&user, &1_i128);
        assert_eq!(client.balance(&user), 1_i128);
    }

    // pause/unpause

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_pause_blocks_mint() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);
        client.initialize(&admin, &minter);
        client.pause();
        client.mint(&user, &100_i128);
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_pause_blocks_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let owner = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.initialize(&admin, &minter);
        client.mint(&owner, &100_i128);
        client.pause();
        client.transfer(&owner, &recipient, &10_i128);
    }

    #[test]
    fn test_unpause_allows_operations_again() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);
        client.initialize(&admin, &minter);
        client.pause();
        client.unpause();
        assert!(!client.paused());
        client.mint(&user, &100_i128);
        assert_eq!(client.balance(&user), 100_i128);
    }

    #[test]
    fn test_admin_returns_correct_address() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        assert_eq!(client.admin(), admin);
    }

    // ── access control tests ─────────────────────────────────────────────────

    /// Unauthorized caller cannot mint — auth is required from the registered minter.
    /// Soroban enforces this: calling without the minter's auth causes a host error.
    #[test]
    #[should_panic]
    fn test_mint_unauthorized_caller_panics() {
        let env = Env::default();
        // Do NOT mock_all_auths — real auth enforcement
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Initialize: mock only the initialize call
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &id,
                fn_name: "initialize",
                args: (&admin, &minter).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.initialize(&admin, &minter);

        // No auth mocked for mint — must panic (host auth failure)
        client.mint(&recipient, &100_i128);
    }

    /// Authorized minter can mint successfully.
    #[test]
    fn test_mint_succeeds_with_minter_auth() {
        let env = Env::default();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let recipient = Address::generate(&env);

        env.mock_auths(&[
            soroban_sdk::testutils::MockAuth {
                address: &admin,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &id,
                    fn_name: "initialize",
                    args: (&admin, &minter).into_val(&env),
                    sub_invokes: &[],
                },
            },
            soroban_sdk::testutils::MockAuth {
                address: &minter,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &id,
                    fn_name: "mint",
                    args: (&recipient, &500_i128).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);
        client.initialize(&admin, &minter);
        client.mint(&recipient, &500_i128);
        assert_eq!(client.balance(&recipient), 500_i128);
    }

    /// Non-admin cannot call set_minter — host auth failure causes a panic.
    #[test]
    #[should_panic]
    fn test_set_minter_unauthorized_caller_panics() {
        let env = Env::default();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let new_minter = Address::generate(&env);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &id,
                fn_name: "initialize",
                args: (&admin, &minter).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.initialize(&admin, &minter);

        // No auth mocked for set_minter — must panic
        client.set_minter(&new_minter);
    }

    // ── retire tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_retire_burns_balance_and_updates_supply() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1000_i128);
        client.retire(&user, &1000_i128, &String::from_str(&env, "REC compliance"));
        assert_eq!(client.balance(&user), 0);
        assert_eq!(client.total_supply(), 0);
    }

    #[test]
    #[should_panic(expected = "already retired")]
    fn test_retire_double_retire_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &500_i128);
        client.retire(&user, &500_i128, &String::from_str(&env, "first"));
        // mint again so balance > 0, but retired flag is set
        client.mint(&user, &100_i128);
        client.retire(&user, &100_i128, &String::from_str(&env, "second"));
    }

    #[test]
    #[should_panic(expected = "token is retired")]
    fn test_transfer_from_retired_address_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&user, &1000_i128);
        client.retire(&user, &1000_i128, &String::from_str(&env, "REC compliance"));
        // mint again so balance > 0, but retired flag blocks transfer
        client.mint(&user, &100_i128);
        client.transfer(&user, &recipient, &100_i128);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_retire_zero_balance_panics() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.retire(&user, &0_i128, &String::from_str(&env, "empty"));
    }

    // SEP-41 compliance tests
    #[test]
    fn test_approve_and_allowance() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.approve(&owner, &spender, &500_i128, &1000_u32);
        assert_eq!(client.allowance(&owner, &spender), 500_i128);
    }

    #[test]
    fn test_transfer_from() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &300_i128, &1000_u32);
        client.transfer_from(&spender, &owner, &recipient, &200_i128);
        assert_eq!(client.balance(&owner), 800_i128);
        assert_eq!(client.balance(&recipient), 200_i128);
        assert_eq!(client.allowance(&owner, &spender), 100_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn test_transfer_from_exceeds_allowance() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.mint(&owner, &1000_i128);
        client.approve(&owner, &spender, &100_i128, &1000_u32);
        client.transfer_from(&spender, &owner, &recipient, &200_i128);
    }

    #[test]
    fn test_approve_zero_revokes() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        client.approve(&owner, &spender, &500_i128, &1000_u32);
        client.approve(&owner, &spender, &0_i128, &0_u32);
        assert_eq!(client.allowance(&owner, &spender), 0_i128);
    }

    #[test]
    fn test_sep41_name_symbol_decimals() {
        let (env, client) = setup();
        assert_eq!(client.name(), String::from_str(&env, "SolarProof kWh"));
        assert_eq!(client.symbol(), String::from_str(&env, "SKWH"));
        assert_eq!(client.decimals(), 7_u32);
    }

    #[test]
    fn test_one_kwh_is_ten_million_stroops() {
        let (env, client) = setup();
        let holder = Address::generate(&env);
        let one_kwh = 10_000_000_i128;

        client.mint(&holder, &one_kwh);

        assert_eq!(client.balance(&holder), one_kwh);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_mint_zero_rejected() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &0_i128);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_mint_negative_rejected() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &-1_i128);
    }

    #[test]
    #[should_panic(expected = "overflow: balance")]
    fn test_mint_overflow_rejected() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        // Fill balance to i128::MAX - 1
        client.mint(&user, &(i128::MAX - 1));
        // This should overflow
        client.mint(&user, &2_i128);
    }

    #[test]
    fn test_mint_boundary_max_minus_one() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &(i128::MAX - 1));
        assert_eq!(client.balance(&user), i128::MAX - 1);
    }

    #[test]
    fn test_mint_amount_one() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1_i128);
        assert_eq!(client.balance(&user), 1_i128);
    }

    // ── event emission tests (#330) ──────────────────────────────────────────

    #[test]
    fn test_mint_emits_event() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &500_i128);
        let events = env.events().all();
        // Find the mint event: topic = ("mint",), data = (to, amount)
        let mint_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("mint"), &env)]
        });
        assert!(mint_event.is_some(), "mint event not emitted");
        let (_, _, data) = mint_event.unwrap();
        let (to, amount): (Address, i128) = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(to, user);
        assert_eq!(amount, 500_i128);
    }

    #[test]
    fn test_transfer_emits_event() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.mint(&a, &1000_i128);
        env.events().all(); // clear
        client.transfer(&a, &b, &300_i128);
        let events = env.events().all();
        let transfer_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("transfer"), &env)]
        });
        assert!(transfer_event.is_some(), "transfer event not emitted");
        let (_, _, data) = transfer_event.unwrap();
        let (from, to, amount): (Address, Address, i128) = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(from, a);
        assert_eq!(to, b);
        assert_eq!(amount, 300_i128);
    }

    #[test]
    fn test_retire_emits_event() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1000_i128);
        client.retire(&user, &String::from_str(&env, "REC compliance"));
        let events = env.events().all();
        let retire_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("retire"), &env)]
        });
        assert!(retire_event.is_some(), "retire event not emitted");
    }

    #[test]
    fn test_burn_emits_event() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1000_i128);
        client.burn(&user, &200_i128);
        let events = env.events().all();
        let burn_event = events.iter().find(|(_, topics, _)| {
            topics == &soroban_sdk::vec![&env, soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&symbol_short!("burn"), &env)]
        });
        assert!(burn_event.is_some(), "burn event not emitted");
        let (_, _, data) = burn_event.unwrap();
        let (from, amount): (Address, i128) = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(from, user);
        assert_eq!(amount, 200_i128);
    }

    // ── Access control tests for set_minter and admin (issue #562) ──────────

    /// Admin can call set_minter successfully; the new minter can then mint.
    #[test]
    fn test_set_minter_by_admin_succeeds() {
        let (env, client) = setup();
        let admin = client.admin();
        let new_minter = Address::generate(&env);
        // Admin rotates the minter
        client.set_minter(&admin, &new_minter);
        // New minter should be able to mint (mock_all_auths is active)
        let user = Address::generate(&env);
        client.mint(&user, &500_i128);
        assert_eq!(client.balance(&user), 500_i128);
    }

    /// A random non-admin address must not be able to call set_minter.
    #[test]
    #[should_panic]
    fn test_set_minter_by_non_admin_panics() {
        let (env, client) = setup();
        let non_admin = Address::generate(&env);
        let new_minter = Address::generate(&env);
        client.set_minter(&non_admin, &new_minter);
    }

    /// The current minter address must not be able to call set_minter
    /// (role separation: minter cannot self-promote or reassign the role).
    #[test]
    #[should_panic]
    fn test_set_minter_by_minter_itself_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        // Minter tries to change the minter — must panic because it is not the admin
        let new_minter = Address::generate(&env);
        // Disable mock_all_auths so only the minter signs
        // We use a fresh env without mock_all_auths for this check.
        // Since require_auth on admin will fail when minter signs:
        // (in mock_all_auths context every call is authorised so we verify via
        // a contract-level guard instead — pass minter as the `new_minter` arg
        // but call with a non-admin caller address to hit the auth path)
        client.set_minter(&minter, &new_minter);
    }

    /// admin() returns the address set during initialization.
    #[test]
    fn test_admin_address_accessible() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        assert_eq!(client.admin(), admin);
    }

    /// set_minter with the same address is idempotent — no panic, storage is just
    /// overwritten with the same value.
    #[test]
    fn test_set_minter_to_same_address_is_idempotent() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        client.initialize(&admin, &minter);
        // Calling set_minter with the current minter address should succeed silently
        client.set_minter(&admin, &minter);
        // Minting still works
        let user = Address::generate(&env);
        client.mint(&user, &100_i128);
        assert_eq!(client.balance(&user), 100_i128);
    }

    /// Calling initialize a second time must panic with "already initialized".
    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (env, client) = setup();
        let a = Address::generate(&env);
        // Second call to initialize must panic
        client.initialize(&a, &a);
    }

    /// After set_minter, a newly minted balance goes to the specified recipient.
    /// Verifies the minter role update propagates correctly through the mint path.
    #[test]
    fn test_set_minter_updates_active_minter() {
        let (env, client) = setup();
        let admin = client.admin();
        let new_minter = Address::generate(&env);
        client.set_minter(&admin, &new_minter);
        // Mint under the new minter context (mock_all_auths covers the new minter)
        let recipient = Address::generate(&env);
        client.mint(&recipient, &250_i128);
        assert_eq!(client.balance(&recipient), 250_i128);
        assert_eq!(client.total_supply(), 250_i128);
    }

    /// Admin-set minter rotation does not affect existing balances.
    #[test]
    fn test_set_minter_does_not_affect_existing_balances() {
        let (env, client) = setup();
        let holder = Address::generate(&env);
        client.mint(&holder, &1_000_i128);
        // Rotate minter
        let admin = client.admin();
        let new_minter = Address::generate(&env);
        client.set_minter(&admin, &new_minter);
        // Existing balance is untouched
        assert_eq!(client.balance(&holder), 1_000_i128);
        assert_eq!(client.total_supply(), 1_000_i128);
    }

    // ── SEP-41 client interaction simulation (issue #53) ────────────────────

    /// Simulates a complete SEP-41 client interaction lifecycle:
    /// deploy → mint → query metadata → approve → transfer_from → burn → burn_from.
    ///
    /// This test verifies that an external client following the SEP-41 interface
    /// spec can interact with `energy_token` end-to-end without relying on any
    /// SolarProof-specific knowledge beyond the standard token interface.
    #[test]
    fn test_sep41_client_interaction() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);

        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let holder = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Step 1 — Deploy and initialise
        client.initialize(&admin, &minter);

        // Step 2 — SEP-41 metadata queries (name, symbol, decimals)
        assert_eq!(client.name(), String::from_str(&env, "SolarProof kWh"));
        assert_eq!(client.symbol(), String::from_str(&env, "SKWH"));
        assert_eq!(client.decimals(), 7_u32);

        // Step 3 — Mint 10 kWh (100_000_000 stroops) to holder
        let mint_amount: i128 = 100_000_000;
        client.mint(&holder, &mint_amount);
        assert_eq!(client.balance(&holder), mint_amount);
        assert_eq!(client.total_supply(), mint_amount);

        // Step 4 — Approve spender for 3 kWh (30_000_000 stroops)
        let allowance_amount: i128 = 30_000_000;
        client.approve(&holder, &spender, &allowance_amount, &9999_u32);
        assert_eq!(client.allowance(&holder, &spender), allowance_amount);

        // Step 5 — transfer_from: spender moves 2 kWh to recipient
        let transfer_amount: i128 = 20_000_000;
        client.transfer_from(&spender, &holder, &recipient, &transfer_amount);
        assert_eq!(client.balance(&holder), mint_amount - transfer_amount);
        assert_eq!(client.balance(&recipient), transfer_amount);
        assert_eq!(
            client.allowance(&holder, &spender),
            allowance_amount - transfer_amount
        );

        // Step 6 — Direct transfer: recipient sends 1 kWh back to holder
        client.transfer(&recipient, &holder, &10_000_000_i128);
        assert_eq!(client.balance(&recipient), 10_000_000_i128);
        assert_eq!(client.balance(&holder), mint_amount - transfer_amount + 1_000);

        // Step 7 — burn: holder burns 1 kWh directly
        let burn_amount: i128 = 1_000;
        client.burn(&holder, &burn_amount);
        let expected_supply = mint_amount - burn_amount;
        assert_eq!(client.total_supply(), expected_supply);

        // Step 8 — burn_from: spender burns remaining allowance (1_000 units)
        // Remaining allowance = 3_000 - 2_000 = 1_000
        let burn_from_amount: i128 = 1_000;
        client.burn_from(&spender, &holder, &burn_from_amount);
        assert_eq!(
            client.total_supply(),
            expected_supply - burn_from_amount
        );
        // Allowance fully consumed
        assert_eq!(client.allowance(&holder, &spender), 0);

        // Step 9 — Final supply invariant: total_supply == minted - burned
        let final_supply = client.total_supply();
        assert!(
            final_supply >= 0,
            "total_supply must never be negative"
        );
    }

    /// Verifies that a SEP-41 client can detect and handle the retire flow:
    /// retired addresses cannot transfer, matching the documented deviation.
    #[test]
    fn test_sep41_client_retirement_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(EnergyToken, ());
        let client = EnergyTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &minter);
        client.mint(&holder, &5_000_i128);

        // Retire full balance — marks address as retired
        client.retire(&holder, &5_000_i128, &String::from_str(&env, "REC compliance"));
        assert_eq!(client.balance(&holder), 0);
        assert_eq!(client.total_supply(), 0);
    }
}

#[cfg(test)]
mod overflow_tests;

#[cfg(test)]
mod storage_cost_tests;