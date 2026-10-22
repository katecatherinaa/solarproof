# ADR-006: Certificate Retirement Model

**Date:** 2026-05-29  
**Status:** Accepted

## Context

Energy certificates (RECs) must be retired — permanently consumed — to prevent double-counting. The retirement event must be publicly auditable and irreversible. Options considered:

1. **Burn to zero address** — transfer token to `0x000…` (EVM convention, not idiomatic on Stellar).
2. **Contract-managed burn** — `energy_token` contract exposes a `retire(amount, beneficiary)` function that destroys the balance and emits an on-chain event.
3. **Off-chain registry** — record retirement in a database only.

## Decision

Use **contract-managed burn** (option 2). The `energy_token` contract's `retire` function:

- Decrements the caller's balance permanently (no re-mint path).
- Records `(beneficiary, kwh, timestamp, tx_hash)` in the `audit_registry` contract for public verification.
- Emits a Soroban event consumed by the public verifier UI.

### Certificate expiry (time-bound claims)

Certificates are currently perpetual. Some regulatory frameworks require time-bound certificates (e.g., valid for one calendar year). We add an **optional** expiry to certificates:

- The `energy_token` contract gains an optional `expires_at` field (a ledger timestamp; `None`/`NULL` means the certificate never expires, preserving backward compatibility).
- The Supabase `certificates` table gains a nullable `expires_at` column, added via a migration with a `NULL` default so existing rows remain valid.
- The API **rejects transfers of expired certificates**: any transfer where `expires_at` is set and is in the past fails with an explicit error rather than silently succeeding.
- Expiry is surfaced on the certificate detail page and the public verifier page so holders and verifiers can see the validity window.

## Consequences

- **Easier:** retirement is cryptographically final and publicly verifiable without trusting SolarProof's database; the verifier at `/verify` can reconstruct the full chain.
- **Easier:** time-bound certificates can satisfy regulatory frameworks that require a bounded validity window, while perpetual certificates remain the default for existing issuances.
- **Harder:** retired tokens cannot be recovered if a user retires by mistake; UX must include a confirmation step with clear warnings.
- **Harder:** expiry introduces a time dimension — transfers must check `expires_at`, and the UI must clearly communicate when a certificate has lapsed.
