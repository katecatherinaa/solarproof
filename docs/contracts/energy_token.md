# energy_token

SEP-41 fungible certificate token. **1 token = 1 kWh** of verified renewable energy.

Minting requires a valid audit anchor in `audit_registry` for the same reading hash.

- **Symbol:** `SPEC`
- **Decimals:** `7` (amounts in stroops: 1 kWh = `10_000_000`)
- **SDK:** Soroban SDK 23.1.0 / OpenZeppelin Stellar v0.5.1

## Precision

One token represents one kilowatt-hour. SEP-41 stores amounts as integers with
seven decimal places, so one stroop represents `0.0000001 kWh`.

| Energy | On-chain amount (stroops) |
|---:|---:|
| 1 kWh | `10_000_000` |
| 0.1 kWh | `1_000_000` |
| 0.0000001 kWh | `1` |

---

## Functions

### `initialize(env, admin, minter)`

One-time setup. Panics if called again.

| Parameter | Type | Description |
|---|---|---|
| `admin` | `Address` | Account authorized to call `set_minter` |
| `minter` | `Address` | Account authorized to call `mint` |

---

### `mint(env, to, amount)`

Mints `amount` tokens to `to`. Requires `minter` auth.

| Parameter | Type | Description |
|---|---|---|
| `to` | `Address` | Recipient address |
| `amount` | `i128` | Amount in stroops (must be > 0) |

Emits event: `("mint", (to, amount))`

**Example:**
```bash
stellar contract invoke --id <CONTRACT_ID> -- mint \
  --to GABC...XYZ \
  --amount 10000000
```

## Debugging with tracer-sim

Use `stellar contract invoke --send=no` to simulate a contract call without submitting
it to the network. This is useful for checking authorization, transaction cost,
and whether the function will succeed before sending the final transaction.

```bash
stellar contract invoke --id <CONTRACT_ID> --source YOUR_SECRET --network testnet \
  --send=no -- mint --to GABC...XYZ --amount 10000000
```

To print estimated execution cost to stderr:

```bash
stellar contract invoke --id <CONTRACT_ID> --source YOUR_SECRET --network testnet \
  --send=no --cost -- mint --to GABC...XYZ --amount 10000000
```

---

### `burn(env, from, amount)`

Burns `amount` tokens from `from`. Requires `from` auth.

| Parameter | Type | Description |
|---|---|---|
| `from` | `Address` | Token holder |
| `amount` | `i128` | Amount in stroops (must be > 0, ≤ balance) |

Emits event: `("burn", (from, amount))`

---

### `retire(env, from, amount)`

Permanently retires (burns) certificates, emitting a distinct `retire` event for indexers.

| Parameter | Type | Description |
|---|---|---|
| `from` | `Address` | Certificate holder |
| `amount` | `i128` | Amount in stroops (must be > 0, ≤ balance) |

Emits event: `("retire", (from, amount))`

---

### `transfer(env, from, to, amount)`

Transfers `amount` from `from` to `to`. Requires `from` auth.

| Parameter | Type | Description |
|---|---|---|
| `from` | `Address` | Sender |
| `to` | `Address` | Recipient |
| `amount` | `i128` | Amount in stroops (must be > 0, ≤ balance) |

Emits event: `("transfer", (from, to, amount))`

---

### `balance(env, account) → i128`

Returns the token balance of `account` in stroops.

---

### `total_supply(env) → i128`

Returns `total_minted - total_burned`.

---

### `set_minter(env, new_minter)`

Replaces the authorized minter. Requires `admin` auth.

---

### `pause(env)`

Pauses the contract. When paused, all state-changing operations are blocked.

| Parameter | Type | Description |
|---|---|---|
| `env` | `Env` | Contract environment |

Requires `admin` auth.

---

### `unpause(env)`

Unpauses the contract and restores normal operation.

| Parameter | Type | Description |
|---|---|---|
| `env` | `Env` | Contract environment |

Requires `admin` auth.

---

### `paused(env) → bool`

Returns `true` if the contract is currently paused.

---

### `admin(env) → Address`

Returns the admin address.

---

### `name(env) → String`

Returns `"SolarProof Energy Certificate"`.

### `symbol(env) → String`

Returns `"SPEC"`.

### `decimals(env) → u32`

Returns `7`.

---

## Error Codes

| Panic message | Cause |
|---|---|
| `"already initialized"` | `initialize` called more than once |
| `"amount must be positive"` | `amount ≤ 0` passed to `mint`, `burn`, `retire`, or `transfer` |
| `"no balance"` | `burn`/`retire` called on account with no balance entry |
| `"insufficient balance"` | `burn`, `retire`, or `transfer` amount exceeds balance |
| `"not initialized"` | Contract called before `initialize` |

---

## Events
These events are emitted to the Soroban ledger as transaction log entries and can be consumed by indexers or frontend services. Consumers should filter on the event topic to track token lifecycle activity.
| Topic | Data | Emitted by |
|---|---|---|
| `"mint"` | `(to: Address, amount: i128)` | `mint` |
| `"burn"` | `(from: Address, amount: i128)` | `burn`, `burn_from` |
| `"retire"` | `(from: Address, amount: i128)` | `retire` |
| `"transfer"` | `(from: Address, to: Address, amount: i128)` | `transfer`, `transfer_from` |
| `"approve"` | `(from: Address, spender: Address, amount: i128)` | `approve` |
