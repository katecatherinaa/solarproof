# Storage Cost Estimation for Contract Methods

> **Issue #564** — Static analysis of Soroban ledger-entry reads and writes per
> contract method for `energy_token` and `audit_registry`.

---

## 1. Soroban Storage Types and Cost Model

Soroban provides three storage tiers, each with different cost characteristics:

| Storage type | TTL behaviour | Use case | Approximate base rent |
|---|---|---|---|
| **Instance** | Tied to the contract instance; extended automatically when the contract is invoked | Small, always-needed values (admin, minter, counters) | Cheapest per call — shared ledger entry with the contract |
| **Persistent** | Independent TTL; must be extended explicitly or via `extend_ttl` calls | Per-address balances, allowances, per-hash anchors | Mid-range; one ledger entry per key |
| **Temporary** | Short-lived; expires automatically without extension | Nonces, idempotency guards | Lowest rent — entries are free to expire |

### Cost model summary

Soroban fees are denominated in **stroops** and calculated from two components:

1. **Read/write bandwidth** — measured in bytes transferred between storage and
   the WASM VM.  Each ledger entry access contributes the serialized size of the
   key + value.
2. **Ledger entry count** — each distinct ledger entry touched in a transaction
   is billed separately regardless of size.

The **instance storage** ledger entry is _one entry_ shared across all
instance-storage keys.  Reading or writing any instance key counts as a single
ledger-entry access (the whole instance blob is loaded/saved).

For **persistent** and **temporary** storage each logical key maps to its own
ledger entry.

> Soroban Protocol 22+ charges `ledger_entry_size_bytes * write_fee_per_byte`
> for writes and `ledger_entry_size_bytes * read_fee_per_byte` for reads.  TTL
> extension incurs a rent payment proportional to the number of ledgers
> extended.

---

## 2. Estimated Byte Sizes per Storage Entry

These are conservative upper-bound estimates for XDR-serialised values on
Stellar Testnet.  Actual sizes depend on address length (G… accounts ≈ 56 chars
encoded as 35 bytes binary).

| Key | Storage type | Value type | Estimated size (key + value) |
|---|---|---|---|
| `Admin` | instance | `Address` | ~72 B |
| `Minter` | instance | `Address` | ~72 B |
| `TotalMinted` | instance | `i128` | ~24 B |
| `TotalBurned` | instance | `i128` | ~24 B |
| `Paused` | instance | `bool` | ~12 B |
| `balance(address)` | persistent | `i128` | ~52 B |
| `Allowance(from, spender)` | persistent | `i128` | ~92 B |
| `Retired(address)` | persistent | `bool` | ~48 B |
| `ApiSigner` | instance | `Address` | ~72 B |
| `Version` | instance | `String` | ~20 B |
| `TotalAnchors` | instance | `u32` | ~16 B |
| `Nonce(bytes32)` | temporary | `bool` | ~48 B |
| `Bucket(id)` | persistent | `Map<BytesN<32>, u32>` | 64 B base + 40 B per entry |

> The **instance storage entry** is loaded as a whole blob; its total size is
> the sum of all instance keys currently stored.  For `energy_token` after
> `initialize` this is approximately **5 × ~45 B average = ~225 B**.
> For `audit_registry` after `initialize` it is approximately **4 × ~45 B = ~180 B**.

---

## 3. `energy_token` — Storage Operations per Method

### Legend

| Symbol | Meaning |
|---|---|
| `R` | Read (persistent get / instance get) |
| `W` | Write (persistent set / instance set) |
| `RW` | Read then write (get + set on same key) |
| `inst` | Instance storage |
| `pers` | Persistent storage |

### 3.1 Method table

| Method | Storage operations | Ledger entries touched | Approx. bandwidth (bytes) |
|---|---|---|---|
| `initialize` | W Admin(inst), W Minter(inst), W TotalMinted(inst), W TotalBurned(inst), W Paused(inst) | 1 (instance blob) | ~225 B write |
| `name` / `symbol` / `decimals` | None | 0 | 0 |
| `balance` | R balance(pers) | 1 | ~52 B read |
| `total_supply` | R TotalMinted(inst), R TotalBurned(inst) | 1 (instance blob) | ~225 B read |
| `admin` | R Admin(inst) | 1 (instance blob) | ~225 B read |
| `allowance` | R Allowance(pers) | 1 | ~92 B read |
| `mint` | R Minter(inst); RW balance(pers); RW TotalMinted(inst) | 2 (instance + 1 pers) | ~277 B read + ~277 B write |
| `burn` | RW balance(pers); RW TotalBurned(inst) | 2 (instance + 1 pers) | ~277 B read + ~277 B write |
| `transfer` | R Paused(inst), R Retired(pers)\*; RW balance×2(pers) | 3–4 (inst + 2–3 pers) | ~370–420 B read + ~104 B write |
| `approve` | W Allowance(pers) | 1 | ~92 B write |
| `transfer_from` | R Paused(inst), R Retired(pers)\*; RW Allowance(pers); RW balance×2(pers) | 4–5 | ~462–514 B read + ~196 B write |
| `burn_from` | R Paused(inst); RW Allowance(pers); RW balance(pers); RW TotalBurned(inst) | 3 | ~369 B read + ~369 B write |
| `set_minter` | R Admin(inst); W Minter(inst) | 1 (instance blob) | ~225 B read + ~225 B write |
| `retire` | R Retired(pers); RW balance(pers); W Retired(pers) (if full burn); RW TotalBurned(inst) | 2–3 | ~321–369 B read + ~321–369 B write |

> \* `transfer` and `transfer_from` call `require_not_retired`, which reads the
> `Retired(address)` persistent entry for the `from` address (~48 B read, 1 pers
> entry).  If the address has never been retired this entry does not exist and
> costs only a key-lookup fee.

### 3.2 Detailed breakdown

#### `initialize`

```
instance.set(Admin)        → W
instance.set(Minter)       → W
instance.set(TotalMinted)  → W  (0_i128)
instance.set(TotalBurned)  → W  (0_i128)
instance.set(Paused)       → W  (false)
```

The five writes are coalesced into **one ledger-entry write** (the instance
blob).  First call ever — no prior reads needed.

---

#### `mint`

```
instance.get(Minter)               → R inst   [auth check]
instance.get(Paused)               → R inst   [require_not_paused]
persistent.get(balance, to)        → R pers   [may return None → 0]
persistent.set(balance, to)        → W pers
instance.get(TotalMinted)          → R inst
instance.set(TotalMinted)          → W inst
```

**Total:** 1 instance blob R+W, 1 persistent R+W.
The instance blob is loaded once and written once regardless of how many
instance keys are accessed.

---

#### `burn`

```
instance.get(Paused)               → R inst
persistent.get(balance, from)      → R pers   [deduct_balance]
persistent.set(balance, from)      → W pers
instance.get(TotalBurned)          → R inst   [add_burned]
instance.set(TotalBurned)          → W inst
```

**Total:** 1 instance R+W, 1 persistent R+W.

---

#### `transfer`

```
instance.get(Paused)               → R inst
persistent.get(Retired, from)      → R pers   [require_not_retired]
persistent.get(balance, from)      → R pers   [move_balance]
persistent.get(balance, to)        → R pers
persistent.set(balance, from)      → W pers
persistent.set(balance, to)        → W pers
```

**Total:** 1 instance R, 3 persistent R, 2 persistent W.
(Optimisation note: self-transfers short-circuit in `move_balance` — no writes.)

---

#### `approve`

```
persistent.set(Allowance(from, spender)) → W pers
```

**Total:** 1 persistent W.

---

#### `transfer_from`

```
instance.get(Paused)               → R inst
persistent.get(Retired, from)      → R pers
persistent.get(Allowance)          → R pers   [spend_allowance]
persistent.set(Allowance)          → W pers
persistent.get(balance, from)      → R pers   [move_balance]
persistent.get(balance, to)        → R pers
persistent.set(balance, from)      → W pers
persistent.set(balance, to)        → W pers
```

**Total:** 1 instance R, 4 persistent R, 3 persistent W.

---

#### `burn_from`

```
instance.get(Paused)               → R inst
persistent.get(Allowance)          → R pers   [spend_allowance]
persistent.set(Allowance)          → W pers
persistent.get(balance, from)      → R pers   [deduct_balance]
persistent.set(balance, from)      → W pers
instance.get(TotalBurned)          → R inst   [add_burned]
instance.set(TotalBurned)          → W inst
```

**Total:** 1 instance R+W, 2 persistent R, 2 persistent W.

---

#### `set_minter`

```
instance.get(Admin)                → R inst   [auth check]
instance.set(Minter)               → W inst
```

**Total:** 1 instance R+W (single blob).

---

#### `total_supply`

```
instance.get(TotalMinted)          → R inst
instance.get(TotalBurned)          → R inst
```

**Total:** 1 instance R (single blob, both keys loaded together).

---

#### `retire`

```
persistent.get(Retired, account)   → R pers   [already retired check]
persistent.get(balance, account)   → R pers
persistent.set(balance, account)   → W pers
persistent.set(Retired, account)   → W pers   [conditional: only if bal == amount]
instance.get(TotalBurned)          → R inst   [add_burned]
instance.set(TotalBurned)          → W inst
```

**Total:** 1 instance R+W, 2–3 persistent R, 2 persistent W.

---

## 4. `audit_registry` — Storage Operations per Method

### 4.1 Method table

| Method | Storage operations | Ledger entries touched | Approx. bandwidth (bytes) |
|---|---|---|---|
| `initialize` | W Admin(inst), W ApiSigner(inst), W TotalAnchors(inst), W Version(inst) | 1 (instance blob) | ~180 B write |
| `get_version` | R Version(inst) | 1 (instance blob) | ~180 B read |
| `api_signer` | R ApiSigner(inst) | 1 (instance blob) | ~180 B read |
| `admin` | R Admin(inst) | 1 (instance blob) | ~180 B read |
| `total_anchors` | R TotalAnchors(inst) | 1 (instance blob) | ~180 B read |
| `anchor` | R ApiSigner(inst); R+W Nonce(temp); R+W Bucket(pers); RW TotalAnchors(inst) | 3 (inst + temp + pers) | ~500–700 B read + ~500–700 B write |
| `verify` | R Bucket(pers) | 1 | 64 B + 40 B × N read |
| `is_anchored` | R Bucket(pers) | 1 | 64 B + 40 B × N read |
| `set_api_signer` | R Admin(inst); W ApiSigner(inst) | 1 (instance blob) | ~180 B read + ~180 B write |
| `migrate` | R Admin(inst); W Version(inst) | 1 (instance blob) | ~180 B read + ~180 B write |
| `extend_bucket_ttl` | R Admin(inst); extend_ttl Bucket(pers) | 1 inst + TTL op | ~180 B read + rent |
| `extend_contract_ttl` | R Admin(inst); extend_ttl instance | 1 inst | ~180 B read + rent |

### 4.2 Detailed breakdown

#### `initialize`

```
instance.set(Admin)        → W
instance.set(ApiSigner)    → W
instance.set(TotalAnchors) → W  (0_u32)
instance.set(Version)      → W  ("1.0.0")
```

**Total:** 1 instance W.

---

#### `anchor`

```
instance.get(ApiSigner)            → R inst   [auth + equality check]
temporary.has(Nonce)               → R temp   [idempotency check]
persistent.get(Bucket(id))         → R pers   [load or create bucket map]
temporary.set(Nonce)               → W temp
persistent.set(Bucket(id))         → W pers   [updated map]
instance.get(TotalAnchors)         → R inst
instance.set(TotalAnchors)         → W inst
```

**Total:** 1 instance R+W, 1 temporary R+W, 1 persistent R+W.

The bucket map grows by ~40 B per new entry (32-byte hash key + 4-byte u32
value + XDR overhead).  Bucket maps are bounded to 1024 buckets (indices
0–1023); each bucket may hold many hashes.

---

#### `verify`

```
persistent.get(Bucket(id))         → R pers
```

**Total:** 1 persistent R.

---

#### `is_anchored`

```
persistent.get(Bucket(id))         → R pers
```

**Total:** 1 persistent R.

---

#### `total_anchors`

```
instance.get(TotalAnchors)         → R inst
```

**Total:** 1 instance R.

---

#### `set_api_signer`

```
instance.get(Admin)                → R inst
instance.set(ApiSigner)            → W inst
```

**Total:** 1 instance R+W.

---

#### `migrate`

```
instance.get(Admin)                → R inst
instance.set(Version)              → W inst
```

**Total:** 1 instance R+W.

---

## 5. TTL and Rent Considerations

### Persistent storage

Persistent entries survive until their TTL expires.  On Stellar Testnet the
default minimum TTL is **17,280 ledgers (~24 hours)** and the maximum TTL is
**3,110,400 ledgers (~180 days)**.

| Entry | Risk | Recommendation |
|---|---|---|
| `balance(address)` | Expires if holder is inactive for 180+ days | Extend TTL on every balance-mutating call |
| `Allowance(from, spender)` | Low risk — short-lived by nature | Accept natural expiry or set TTL = expiration_ledger |
| `Retired(address)` | Must survive indefinitely | Extend TTL on every retire call |
| `Bucket(id)` | Critical — loss = lost anchors | Admin should call `extend_bucket_ttl` periodically |

### Temporary storage

Temporary entries are **automatically expired** after a short TTL (~16 ledgers
on Testnet, configurable per network).  This makes them ideal for nonces:

- `Nonce(bytes32)` in `audit_registry` — intentionally temporary; replay
  protection only needs to last for the transaction finality window.

### Instance storage

Instance storage TTL is extended automatically whenever the contract is invoked
(the network bumps it on any successful transaction).  No manual management is
required under normal operation.

---

## 6. Optimization Recommendations

### `energy_token`

| Method | Current cost | Recommendation |
|---|---|---|
| `transfer` | 3 pers R + 2 pers W | Batch `Paused` + `Retired` checks into one instance read — already done via shared instance blob |
| `transfer_from` | 4 pers R + 3 pers W | Highest-cost method; consider caching `Allowance` in instance storage for hot spender pairs |
| `retire` | 2–3 pers R + 2 pers W | `Retired` flag and balance are separate persistent entries; merging them into one struct would save 1 ledger entry per call |
| `mint` (first time for address) | 1 pers W | No optimisation needed — unavoidable new entry creation |
| All methods | Instance blob loaded on every call | The 5 instance keys total ~224 B; this is well within the per-call budget |

### `audit_registry`

| Method | Current cost | Recommendation |
|---|---|---|
| `anchor` | 1 inst R+W + 1 temp R+W + 1 pers R+W | **Highest-cost method.** Bucket map design already amortises persistent entry cost across up to 1024 hashes per bucket — this is a deliberate optimisation |
| `verify` / `is_anchored` | 1 pers R | Already optimal |
| Bucket TTL | Not auto-extended | Call `extend_bucket_ttl` regularly, ideally in the same transaction as `anchor` to amortise the admin-auth cost |
| Nonce temporary storage | Short TTL | Confirm minimum TTL covers the transaction finality window on target network |

### General

- **Avoid reading the same persistent key twice in one transaction.** Soroban
  bills per ledger entry _access_, so restructure helper functions to pass
  already-read values as parameters rather than re-reading from storage.
- **Group instance writes.** All instance keys share a single ledger entry.
  Writing five keys costs the same ledger-entry fee as writing one — only the
  serialized blob size changes.
- **Use `unwrap_or(default)` instead of `has` + `get`.**  `has` then `get` is
  two storage operations; `get` with `unwrap_or` is one.

---

## 7. Quick Reference — Operations per Method

```
energy_token
────────────
initialize      5 inst W  → 1 ledger entry write
balance         1 pers R  → 1 ledger entry read
total_supply    2 inst R  → 1 ledger entry read
admin           1 inst R  → 1 ledger entry read
allowance       1 pers R  → 1 ledger entry read
mint            1 inst RW + 1 pers RW
burn            1 inst RW + 1 pers RW
transfer        1 inst R  + 2 pers RW + 1 pers R (Retired)
approve         1 pers W
transfer_from   1 inst R  + 3 pers RW + 1 pers R (Retired)
burn_from       1 inst RW + 2 pers RW
set_minter      1 inst RW
retire          1 inst RW + 2 pers RW (+ 1 pers W if full burn)

audit_registry
──────────────
initialize      4 inst W  → 1 ledger entry write
get_version     1 inst R
api_signer      1 inst R
admin           1 inst R
total_anchors   1 inst R
anchor          1 inst RW + 1 temp RW + 1 pers RW  ← most expensive
verify          1 pers R
is_anchored     1 pers R
set_api_signer  1 inst RW
migrate         1 inst RW
```

---

*Generated for SolarProof issue #564 · Soroban SDK 23.1.0 · Protocol 22*

---

## 8. Automated Storage Regression Tests (issue #59)

To prevent silent size regressions, a dedicated test crate lives at
`apps/contracts/storage_regression/`.  It asserts that every storage entry
stays within the budgets defined below (baseline + 10 % tolerance).

### Budget table

| Contract         | Entry                      | Baseline (B) | Budget (+10%) |
|------------------|----------------------------|-------------|--------------|
| `audit_registry` | Instance blob (initialize) | 180         | 198          |
| `audit_registry` | Bucket (1 entry)           | 104         | 115          |
| `audit_registry` | Bucket (10 entries)        | 464         | 510          |
| `audit_registry` | Per-entry growth           | 40 B/entry  | 50 B/entry   |
| `energy_token`   | Instance blob (initialize) | 225         | 248          |
| `energy_token`   | Balance entry (proxy)      | 52          | 58           |

### Updating budgets

If a deliberate storage layout change causes a test to fail:

1. Measure the new size locally:
   ```bash
   cargo test --manifest-path apps/contracts/storage_regression/Cargo.toml -- --nocapture 2>&1 | grep STORAGE
   ```
2. Update the constant in `apps/contracts/storage_regression/src/lib.rs`.
3. Update the budget table above.
4. Add a comment in the PR explaining why the size increased.

### Running locally

```bash
cargo test --manifest-path apps/contracts/storage_regression/Cargo.toml
```

The CI step `storage-regression` in `.github/workflows/contracts-ci.yml` runs
this automatically on every pull request touching `apps/contracts/`.
