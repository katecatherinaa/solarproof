# Contract Event Schema Stability Guide

This document provides guidance on maintaining backward compatibility and schema stability for contract events in SolarProof's Soroban smart contracts.

---

## Overview

Contract events are emitted by Soroban smart contracts to signal state changes and are indexed by external systems (indexers, off-chain data services, event listeners). **Once an event schema is used in production, it must remain stable** to avoid breaking downstream consumers.

### Why Schema Stability Matters

1. **Indexer Compatibility** — Off-chain indexers rely on predictable event structures to parse and store blockchain data
2. **Client Applications** — Web UIs and APIs depend on consistent event formats for notifications and state reconciliation
3. **Audit Trails** — Immutable event logs must maintain consistent structure for compliance and forensics
4. **Third-Party Integrations** — Partners integrating with SolarProof expect stable, versioned event schemas

---

## Event Declaration Best Practices

### 1. Always Use Typed Events

Define events as explicit struct types with clear field names. Avoid tuple events without context.

**✅ Good:**
```rust
#[derive(Clone, Debug)]
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub reading_hash: BytesN<32>,
}

pub fn mint(env: Env, to: Address, amount: i128, reading_hash: BytesN<32>) {
    // ... validation ...
    env.events().publish(("mint",), MintEvent { recipient: to, amount, reading_hash });
}
```

**❌ Avoid:**
```rust
// Tuple events lose semantic meaning
env.events().publish(("mint",), (to, amount)); // What does this tuple mean?
```

### 2. Document Event Purpose and Fields

Every event should have inline documentation explaining its purpose, preconditions, and field meanings.

```rust
/// Emitted when tokens are minted to an account.
/// 
/// - `recipient`: The address receiving newly minted tokens
/// - `amount`: Number of tokens minted (in stroops, 1 kWh = 10_000_000)
/// - `reading_hash`: SHA-256 hash of the anchored meter reading
/// - Precondition: Minter authorization must be valid
#[derive(Clone, Debug)]
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub reading_hash: BytesN<32>,
}
```

### 3. Use Enums for Event Variants

When multiple event types exist, use enums to maintain type safety and prevent accidental schema changes.

```rust
#[derive(Clone, Debug)]
pub enum CertificateEvent {
    Minted(MintEvent),
    Burned(BurnEvent),
    Transferred(TransferEvent),
}

pub fn mint(env: Env, to: Address, amount: i128) {
    let event = CertificateEvent::Minted(MintEvent {
        recipient: to,
        amount,
    });
    env.events().publish(("certificate",), event);
}
```

---

## Schema Versioning Strategy

### 1. Never Remove Fields

Removing fields breaks indexers and off-chain systems. Instead, deprecate by marking fields as deprecated in comments.

**❌ Never do this:**
```rust
// Before
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub meter_id: String,  // <-- Removed in v2
}

// After (BREAKING)
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
}
```

**✅ Do this instead:**
```rust
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub meter_id: String,           // Deprecated: meter metadata moved to audit_registry
    pub reading_hash: BytesN<32>,   // NEW: link to audit_registry for meter context
}
```

### 2. Reorder Fields Only If Necessary and Document

Field reordering in Soroban contracts affects serialization. If reordering is necessary, provide migration guidance.

```rust
// v1
pub struct AuditAnchorEvent {
    pub reading_hash: BytesN<32>,
    pub meter_pubkey: BytesN<32>,
    pub timestamp: u64,
}

// v2 - reordered for logical grouping (document in changelog)
pub struct AuditAnchorEvent {
    pub meter_pubkey: BytesN<32>,   // Moved: meter context first
    pub reading_hash: BytesN<32>,   // Moved: hash follows context
    pub timestamp: u64,              // Moved: timeline last
}
```

Provide a migration guide in `CHANGELOG.md`:
```markdown
## v2.0.0 - 2026-06-30

### Event Schema Changes

**audit_registry**: `AuditAnchorEvent` fields reordered for clarity:
- Old: `reading_hash` → `meter_pubkey` → `timestamp`
- New: `meter_pubkey` → `reading_hash` → `timestamp`

Indexers must handle field positions by name (as with Soroban's RPC), not position.
```

### 3. Optional Fields and Forward Compatibility

Use Option types (or similar) to add optional fields without breaking existing consumers.

```rust
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub reading_hash: BytesN<32>,
    pub referrer: Option<Address>,  // NEW: optional for future loyalty programs
}
```

### 4. Additive Changes Only

Always append new fields to the end of structs to maintain backward compatibility with serialized data.

```rust
// v1
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
}

// v2 - GOOD (additive)
pub struct MintEvent {
    pub recipient: Address,
    pub amount: i128,
    pub reading_hash: BytesN<32>,  // NEW field appended
}

// v2 - BAD (insertive)
pub struct MintEvent {
    pub recipient: Address,
    pub reading_hash: BytesN<32>,  // NEW field inserted (breaks serialization)
    pub amount: i128,
}
```

---

## Event Naming Conventions

### Topic Names

Topic names should be:
- **Singular, lowercase** — `"mint"`, `"burn"`, `"transfer"`
- **Action-oriented** — Use past tense for event names (`"minted"`, `"burned"`)
- **Namespaced if necessary** — `"registry:anchor"`, `"governance:voted"`

```rust
// Contract: energy_token
env.events().publish(("mint",), MintEvent { /* ... */ });       // ✅ Good
env.events().publish(("minted",), MintEvent { /* ... */ });     // ✅ Also acceptable
env.events().publish(("MINT",), MintEvent { /* ... */ });       // ❌ Avoid caps

// Contract: audit_registry
env.events().publish(("anchor",), AnchorEvent { /* ... */ });   // ✅ Good
env.events().publish(("registry:anchor",), AnchorEvent { /* ... */ });  // ✅ Namespace if needed
```

---

## Testing Event Schema Stability

### Enforcement Status

This guide describes the compatibility policy; it is not itself an automated
schema lock. Existing contract tests cover selected event emissions, but the
repository does not yet enforce a versioned schema snapshot for every emitted
event or verify all schemas against the off-chain indexer. Issue #54 tracks
that implementation work.

Before treating this policy as enforced, add contract tests that inspect the
actual emitted topic and serialized data (not only event structs or decoded
values), maintain a versioned schema manifest, and verify its compatibility
with the indexer. Any approved schema change must update the manifest and add a
changelog entry in the same change.

### 1. Unit Tests for Event Emissions

Verify events are emitted with the correct structure and values.

```rust
#[test]
fn test_mint_event_structure() {
    let env = Env::default();
    // ... setup ...

    let event = MintEvent {
        recipient: user_address.clone(),
        amount: 10_000_000,
        reading_hash: reading_hash.clone(),
    };

    env.events().publish(("mint",), event);

    // Verify event was emitted (mock/inspect on test harness)
    // Validate field types and values
}
```

### 2. Schema Compatibility Checks

Document expected event structures in tests to catch unintended schema changes.

```rust
#[test]
fn test_energy_token_event_schema() {
    // This test documents the stable schema
    let _event = MintEvent {
        recipient: Address::random(&Env::default()),
        amount: 1_000_000_000,
        reading_hash: BytesN::from_array(&Env::default(), &[0u8; 32]),
    };

    // If you add/remove fields without updating this test, the schema changed!
}
```

### 3. Changelog Validation

Before releasing, review the changelog to document any event schema changes.

**Example Changelog Entry:**
```markdown
## [2.1.0] - 2026-07-15

### Added
- **energy_token**: New `referrer` field in `MintEvent` (optional, for tracking referrals)

### Changed
- **audit_registry**: `AuditAnchorEvent` now includes `contract_version` field

### Deprecated
- **community_governance**: `ProposalEvent.metadata` field (use `metadata_cid` instead)
```

---

## Migration Path for Breaking Changes

If a breaking change is unavoidable:

1. **Emit Both Old and New Events**
   ```rust
   // During transition period
   env.events().publish(("mint", "v1"), OldMintEvent { /* ... */ });
   env.events().publish(("mint", "v2"), NewMintEvent { /* ... */ });
   ```

2. **Maintain a Grace Period**
   - Announce deprecation 2+ releases in advance
   - Provide migration guidance
   - Support both schemas in indexers during transition

3. **Version the Contract**
   - Increment major version for breaking schema changes
   - Tag events with version: `("mint", "v2")`

4. **Document Thoroughly**
   - Update [ADR-002](./adr/002-stellar-soroban.md) if design rationale changes
   - Create a migration guide in docs
   - Add comments in code explaining the change

---

## Monitoring and Observability

### 1. Event Emission Logging

Include rich context in tests to catch schema divergence early.

```rust
#[test]
fn test_event_emission_with_context() {
    // Log: "Emitting MintEvent with recipient={}, amount={}, reading_hash={}"
    // This helps catch accidental field modifications
}
```

### 2. Indexer Integration Tests

Test that off-chain indexers can parse events correctly after contract updates.

```bash
# Integration test script
./scripts/test-indexer-compatibility.sh --contract energy_token --version 2.0.0
```

### 3. Event Schema Registry

Maintain a schema registry documenting stable event structures:

```yaml
contracts:
  energy_token:
    events:
      - name: mint
        version: 1
        fields:
          - name: recipient
            type: Address
          - name: amount
            type: i128
      - name: burn
        version: 1
        fields:
          - name: from
            type: Address
          - name: amount
            type: i128
```

---

## Summary: Event Stability Checklist

Before committing event schema changes:

- [ ] Is this an additive change (no removals)?
- [ ] Are all fields documented with inline comments?
- [ ] Have I considered downstream consumers (indexers, UIs)?
- [ ] Is there a changelog entry describing the change?
- [ ] Have I written tests verifying the event structure?
- [ ] If breaking: Is there a migration path and grace period?
- [ ] Are topic names following naming conventions?
- [ ] Have I reviewed for backward compatibility?

---

## References

- [Soroban Events Documentation](https://developers.stellar.org/docs/build/smart-contracts/events)
- [SEP-41 Token Standard](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0041.md)
- [ADR-002: Stellar & Soroban Architecture](./adr/002-stellar-soroban.md)

---

**Last Updated:** June 2026
**Owner:** SolarProof Contributors
