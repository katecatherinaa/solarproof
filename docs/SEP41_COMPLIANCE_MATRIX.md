# SEP-41 Compliance Matrix — `energy_token`

> Tracks the compliance status of every function required by the
> [SEP-0041 Token Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
> against the `energy_token` Soroban contract.

---

## Overview

`energy_token` is a Soroban fungible token that represents verified renewable
energy certificates (10 000 000 stroops = 1 kWh).  It implements the complete
SEP-41 interface with one intentional deviation documented below.

---

## Required Function Matrix

| # | SEP-41 Function | Signature | Status | Notes |
|---|---|---|---|---|
| 1 | `name` | `name(e: Env) → String` | ✅ Compliant | Returns `"SolarProof kWh"` |
| 2 | `symbol` | `symbol(e: Env) → String` | ✅ Compliant | Returns `"SKWH"` |
| 3 | `decimals` | `decimals(e: Env) → u32` | ✅ Compliant | Returns `7` (stroop precision; 10 000 000 stroops = 1 kWh) |
| 4 | `balance` | `balance(e: Env, id: Address) → i128` | ✅ Compliant | Returns `0` for unknown accounts |
| 5 | `transfer` | `transfer(e: Env, from: Address, to: Address, amount: i128)` | ✅ Compliant | Requires `from` auth; emits `transfer` event |
| 6 | `transfer_from` | `transfer_from(e: Env, spender: Address, from: Address, to: Address, amount: i128)` | ✅ Compliant | Requires `spender` auth; checks allowance |
| 7 | `approve` | `approve(e: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32)` | ✅ Compliant† | Sets allowance; `0` revokes |
| 8 | `allowance` | `allowance(e: Env, from: Address, spender: Address) → i128` | ✅ Compliant | Returns `0` when none set |
| 9 | `mint` | `mint(e: Env, to: Address, amount: i128)` | ✅ Compliant‡ | Minter-role gated; emits `mint` event |
| 10 | `burn` | `burn(e: Env, from: Address, amount: i128)` | ✅ Compliant | Requires `from` auth; emits `burn` event |
| 11 | `burn_from` | `burn_from(e: Env, spender: Address, from: Address, amount: i128)` | ✅ Compliant | Allowance-based burn |

---

## Deviations and Justifications

### † `approve` — `expiration_ledger` parameter accepted but not enforced

**SEP-41 spec**: Allowances SHOULD expire at `expiration_ledger`.

**Current behaviour**: The `expiration_ledger` parameter is received but stored
as `_expiration_ledger` (unused).  Allowances do not auto-expire.

**Justification**: Soroban persistent storage TTL handles ledger entry
expiration at the infrastructure level.  Implementing per-allowance ledger
expiry requires a separate expiration index and `bump_ttl` call per approval,
adding significant storage cost per interaction.  This is a known trade-off
accepted by the project and will be addressed in a future upgrade once the
Soroban fee model stabilises.

**Risk**: Low. Allowances can always be revoked explicitly by calling
`approve(from, spender, 0, 0)`.

---

### ‡ `mint` — minter-role gated (not open)

**SEP-41 spec**: No opinion on who may mint.

**Current behaviour**: Only the registered `minter` address may call `mint`.
The `admin` may rotate the minter via `set_minter`.

**Justification**: Unconstrained minting would break the core invariant that
every token corresponds to a verified meter reading.  Restricting mint to the
SolarProof API keypair preserves the cryptographic chain of custody.

---

## Additional Non-SEP-41 Entry Points

The following functions extend SEP-41 for SolarProof-specific requirements:

| Function | Purpose |
|---|---|
| `initialize(admin, minter)` | One-time contract setup |
| `total_supply()` | `total_minted - total_burned` |
| `set_minter(new_minter)` | Admin-only minter rotation |
| `admin()` | Returns the admin address |
| `minter()` | Returns the minter address |
| `retire(from, amount)` | Certificate retirement (burns + marks address retired) |
| `is_retired(address)` | Query retirement status |
| `pause()` / `unpause()` | Admin emergency halt |
| `is_paused()` | Query pause state |
| `version()` | Contract version string |

---

## SEP-41 Client Interaction Simulation

An integration test (`test_sep41_client_interaction`) in
`apps/contracts/energy_token/src/lib.rs` simulates a complete SEP-41 client
lifecycle:

1. Deploy and initialise `energy_token`
2. Mint tokens to a holder via the minter
3. Query `name`, `symbol`, `decimals`
4. Query `balance`
5. `approve` a spender
6. Query `allowance`
7. `transfer_from` using the approved allowance
8. `burn` directly by the holder
9. `burn_from` using allowance
10. Verify final balances and `total_supply`

See: [`apps/contracts/energy_token/src/lib.rs`](../apps/contracts/energy_token/src/lib.rs) — `test_sep41_client_interaction`

---

## References

- [SEP-0041 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
- [Soroban Token Interface](https://developers.stellar.org/docs/tokens/token-interface)
- [ADR-003: SEP-41 Token Standard](adr/003-sep41-token-standard.md)
