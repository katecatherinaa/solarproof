# SolarProof — Threat Model

**Methodology:** STRIDE  
**Last reviewed:** 2026-06-12  
**Reviewer:** security-aware contributor

---

## 1. System Overview

```
Smart Meter (Ed25519 keypair)
        │  POST /api/readings  { kwh, timestamp, signature }
        ▼
SolarProof API (Next.js / Vercel)
        │  1. Verify Ed25519 signature
        │  2. Anchor reading hash → audit_registry (Soroban)
        │  3. Mint energy_token (1 token = 1 kWh)
        ▼
Stellar Testnet (Soroban)
        ├── energy_token        — SEP-41 certificate token
        ├── audit_registry      — immutable signed-reading anchors
        └── community_governance — cooperative proposals + voting
        ▼
Supabase (off-chain store)
        └── readings, meter registry, certificate metadata
```

---

## 2. Assets

| Asset | Confidentiality | Integrity | Availability |
|---|---|---|---|
| Meter Ed25519 private key | Critical | Critical | High |
| Minter signing key (HSM-backed, non-extractable) | Critical | Critical | High |
| On-chain reading hashes (audit_registry) | Public | Critical | High |
| Energy token balances (energy_token) | Public | Critical | High |
| Off-chain reading payloads (Supabase) | Medium | High | High |
| Cooperative membership & scoping data | Medium | Critical | High |
| Governance proposals & votes | Public | High | Medium |

---

## 3. Trust Boundaries

| Boundary | Trust level |
|---|---|
| Smart meter device | Trusted if Ed25519 keypair is uncompromised |
| SolarProof API (Vercel) | Trusted server; delegates signing to HSM (key never leaves hardware) |
| HSM (YubiKey / TPM) | Trusted; private key non-extractable, signing only |
| Stellar network | Trusted (BFT consensus) |
| Supabase | Trusted for availability; **not** trusted for integrity (hash is the source of truth) |
| Cooperative tenants | Mutually untrusted — each cooperative must only see its own data |
| Public verifier callers | Untrusted |
| Community governance voters | Untrusted (Sybil-mitigated via token-weighted voting) |

---

## 4. STRIDE Threat Catalogue

### 4.1 Spoofing

#### S1 — Forged meter reading
**Attack vector:** Submit `POST /api/readings` with a fabricated `signature_hex` for a registered meter.  
**Impact:** Fraudulent energy certificates minted.  
**Mitigation:** API verifies Ed25519 signature against the meter's registered `pubkey_hex` before anchoring or minting. Invalid signatures return HTTP 401.  
**Residual risk:** Low — requires breaking Ed25519 or compromising the meter keypair.

#### S2 — Impersonation of the minter
**Attack vector:** Attacker submits a Stellar transaction calling `energy_token.mint()` without the minter's signature, or attempts to steal/forge the minter signing key.  
**Impact:** Unauthorized certificate minting.  
**Mitigation:** `mint()` calls `minter.require_auth()` — Soroban rejects the transaction if the minter's Ed25519 signature is absent. The minter key is stored in an HSM (YubiKey / TPM) with a **non-extractable private key**; the API never holds the raw secret and instead requests hardware-backed signatures from the HSM (see `docs/HSM_INTEGRATION.md`, `docs/HSM_ONBOARDING.md`). Key rotation is performed via the `rotate-key` endpoint, which re-registers the new public key on-chain through the admin-only `set_minter()` path.  
**Residual risk:** Low — key material cannot be exfiltrated from the HSM; compromise requires physical access to the device plus its PIN.

---

### 4.2 Tampering

#### T1 — Off-chain reading payload tampering
**Attack vector:** Attacker with Supabase service-role key modifies `readings` table records (kwh, meter_id, timestamp).  
**Impact:** Misleading audit trail; certificate amounts appear incorrect.  
**Mitigation:** The on-chain `reading_hash` is the canonical source of truth. Any tampering is detectable by recomputing `sha256(meter_id ‖ kwh_stroops_le ‖ timestamp_le)` and comparing to the anchored hash.  
**Residual risk:** Low for integrity; Medium for availability (records could be deleted).

#### T2 — Persistent storage expiry (TTL)
**Attack vector:** Soroban persistent storage entries expire if TTL is not extended before the ledger advances past the entry's live-until ledger.  
**Impact:** Loss of anchored hashes or token balances on mainnet.  
**Mitigation:** TTL bump logic must be implemented before mainnet deployment (tracked in roadmap).  
**Residual risk:** High on mainnet without TTL management; Low on testnet.

#### T3 — Third-party script tampering (CDN compromise)
**Attack vector:** An attacker who compromises a third-party CDN (Sentry, analytics) or the upstream package replaces a served script or stylesheet with malicious content.  
**Impact:** Arbitrary JavaScript execution in the verifier UI context — e.g. exfiltration of session data or tampering with displayed audit results.  
**Mitigation:** Every external `<script>` and `<link>` tag carries a Subresource Integrity (`integrity`) hash plus `crossorigin="anonymous"`. The Content-Security-Policy includes `require-sri-for script style`, so browsers refuse to load any third-party asset that lacks an integrity attribute. An automated CI check fails the build if any external asset is added without an `integrity` hash.  
**Residual risk:** Low — a CDN compromise cannot alter the asset without breaking the hash.

**SRI fallback behaviour (when an integrity check fails):**

1. **Asset blocked.** The browser refuses to execute or apply the asset whose bytes do not match the `integrity` hash. The page continues to load without that asset; no partially-verified script is ever run.
2. **Feature disabled.** Any feature that depends on the blocked asset degrades gracefully — e.g. if the Sentry bundle fails SRI, error reporting is disabled for that session but the verifier UI remains fully functional. Features must never assume a third-party asset loaded successfully.
3. **Error surfaced.** The failure is reported via an `onerror` handler on the tag and a `window` `error`/`securitypolicyviolation` listener, which forwards a sanitized event (asset URL, expected hash, page route — never user data) to Sentry. CSP violations are additionally reported through the `report-uri`/`report-to` directive.
4. **No silent fallback to an unverified copy.** We never re-fetch the asset from an alternate origin or without integrity checking; a failed SRI check is treated as a potential compromise until investigated.

**Updating hashes when third-party versions change:**

- Hashes are generated from the exact pinned version, e.g. `openssl dgst -sha384 -binary sentry.min.js | openssl base64 -A` (or `shasum -b -a 384`), and recorded as `sha384-<base64>`.
- Third-party versions are pinned (no floating `latest` URLs); a version bump is a dedicated PR that updates the URL and the `integrity` hash together.
- The CI SRI check re-computes each hash against the fetched asset and fails if it does not match, so a stale hash cannot be merged.
- Hash updates require review from a security-aware contributor and are noted in the PR description.

---

### 4.3 Repudiation

#### R1 — Meter operator denies submitting a reading
**Attack vector:** Meter operator claims a reading was fabricated.  
**Impact:** Dispute over certificate legitimacy.  
**Mitigation:** The Ed25519 signature over `(meter_id, kwh_stroops, timestamp)` is stored in Supabase and the hash is anchored on-chain. The signature is non-repudiable as long as the meter private key is not shared.  
**Residual risk:** Low.

#### R2 — API denies anchoring a reading
**Attack vector:** API operator claims a reading was never anchored.  
**Impact:** Dispute over audit trail completeness.  
**Mitigation:** The Stellar ledger provides an immutable, publicly auditable record of every `anchor()` call. The transaction hash is returned to the caller and stored in Supabase.  
**Residual risk:** Low.

---

### 4.4 Information Disclosure

#### I1 — Minter secret key leakage
**Attack vector:** `MINTER_SECRET_KEY` accidentally committed to git or exposed in logs.  
**Impact:** Attacker can mint arbitrary certificates.  
**Mitigation:** Key stored in GitHub Actions secrets / Vercel environment variables (never committed). Gitleaks secret-scanning workflow blocks accidental exposure in CI.  
**Residual risk:** Medium — if the key leaks, `set_minter()` (admin-only) can rotate it.

#### I2 — Meter private key extraction
**Attack vector:** Physical attacker extracts the Ed25519 private key from meter hardware.  
**Impact:** Attacker can forge unlimited readings for that meter.  
**Mitigation (current):** Compromised meter can be deactivated in Supabase (`active = false`); API rejects readings from inactive meters.  
**Mitigation (future):** Hardware HSM / TPM integration (Level 2 roadmap).  
**Residual risk:** Medium — key extraction from software-only meters is feasible.

#### I3 — Cross-cooperative data access
**Attack vector:** A member or API caller belonging to cooperative A attempts to read or mutate meters, readings, or stats belonging to cooperative B — via the cooperative API routes (`/api/cooperative/me`, `/api/cooperative/stats`) or by querying Supabase directly.  
**Impact:** Disclosure of another cooperative's meter registry and reading payloads; potential tampering with foreign records; loss of tenant isolation.  
**Mitigation:** All cooperative-scoped records carry a `cooperative_id` column and every query is scoped by the authenticated caller's `cooperative_id` (derived server-side, never from client input). Supabase row-level security (RLS) policies enforce `cooperative_id = auth.jwt() -> 'cooperative_id'` on `meters`, `readings`, and related tables. The Supabase service-role key (which bypasses RLS) is used only in server-side code paths that explicitly re-apply cooperative scoping; it is never exposed to the client. Cooperative routes resolve membership from the session and return 403 for cross-cooperative requests.  
**Residual risk:** Low — isolation depends on RLS policies and service-role usage discipline remaining correct; any new table must ship with RLS enabled and a cooperative-scoped policy.

---

### 4.5 Denial of Service

#### D1 — API flooding
**Attack vector:** Attacker sends high-volume `POST /api/readings` requests to exhaust Vercel serverless concurrency or Stellar RPC rate limits.  
**Impact:** Legitimate meter readings are delayed or dropped.  
**Mitigation:** Vercel edge rate limiting; Stellar RPC has per-IP rate limits. Supabase row-level security prevents bulk inserts from unauthenticated callers.  
**Residual risk:** Medium — no explicit application-level rate limiting is currently implemented.

#### D2 — Supabase data deletion
**Attack vector:** Attacker with Supabase service-role key deletes reading records.  
**Impact:** Off-chain audit trail unavailable; on-chain hashes become unverifiable without the original payload.  
**Mitigation:** Supabase row-level security; regular backups (see `docs/BACKUP.md`).  
**Residual risk:** Medium for availability.

---

### 4.6 Elevation of Privilege

#### E1 — Governance Sybil attack
**Attack vector:** Attacker creates many Stellar addresses and votes multiple times on a proposal.  
**Impact:** Proposal outcome manipulated.  
**Mitigation:** `community_governance` enforces **token-weighted voting** — a voter's influence is proportional to the SPEC token balance held at vote time, so splitting tokens across many addresses yields no additional weight. A per-proposal **voter-index bitmap** records which addresses have already voted, rejecting duplicate votes on-chain. Quorum is percentage-based over total eligible voting weight, and per-voter weight is capped by the contract's weight parameters.  
**Residual risk:** Low–Medium — token-weighted voting raises the cost of Sybil attacks but remains vulnerable to large token accumulation (whale) and to vote-buying; monitor distribution of voting weight.

#### E2 — Replay attack on anchor
**Attack vector:** Network observer re-submits a previously valid signed reading to anchor it twice.  
**Impact:** Duplicate certificate minting.  
**Mitigation:** `audit_registry.anchor()` panics with `"reading already anchored"` on duplicate hashes. The hash includes `meter_id`, `kwh_stroops`, and `timestamp`, making each reading unique.  
**Residual risk:** Low.

#### E3 — Integer overflow in governance quorum
**Attack vector:** Proposer engineers a vote count such that `yes_votes * 100` overflows `u32`.  
**Impact:** Incorrect quorum calculation; proposal passes or fails incorrectly.  
**Mitigation:** Soroban SDK compiles with `overflow-checks = true` in release profile — overflow panics rather than wrapping.  
**Residual risk:** Low.

---

## 5. Attack Surface Summary

| Attack vector | Covered by |
|---|---|
| Compromised meter key | Ed25519 verification + meter deactivation (S1, I2) |
| Replay attack | Duplicate-hash rejection in audit_registry (E2) |
| Contract exploit (unauthorized mint) | `require_auth()` in energy_token (S2) |
| API abuse / flooding | Vercel rate limits + RLS (D1) |
| Minter key leakage | HSM non-extractable key + secret scanning + rotate-key (S2, I1) |
| Cross-cooperative access | `cooperative_id` scoping + RLS + service-role discipline (I3) |
| Governance manipulation | Token-weighted voting + voter-index bitmap + quorum (E1) |
| Storage expiry | TTL management (T2) — open risk before mainnet |
| Tampered third-party script (CDN compromise) | Subresource Integrity (SRI) hashes + CSP `require-sri-for` (T3) |

---

## 6. Out-of-Scope Threats

- Stellar network-level attacks (validator collusion, eclipse attacks)
- Vercel / hosting infrastructure compromise
- Browser-side attacks on the public verifier UI
- Supply-chain attacks on npm/cargo dependencies (SRI covers only browser-loaded third-party assets, see T3)

---

## 7. Review Sign-off

This threat model was reviewed against the current codebase (HSM signing, multi-cooperative data isolation, and governance Sybil mitigations) and is approved by:

| Contributor | Role | Date |
|---|---|---|
| _TBD_ | Security-aware contributor | 2026-06-12 |
| _TBD_ | Backend / contracts maintainer | 2026-06-12 |
