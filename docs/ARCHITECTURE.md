# Architecture Diagram & Component Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SolarProof System                              │
└─────────────────────────────────────────────────────────────────────────────┘

  Smart Meter (Ed25519 keypair)
        │
        │  POST /api/readings  { meter_id, kwh, timestamp, signature_hex }
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                        SolarProof API  (Next.js 15)                     │
  │                                                                         │
  │  Route handlers (apps/web/src/app/api/)                                 │
  │  ┌───────────────┐  ┌──────────────────┐  ┌─────────────────────────┐  │
  │  │ POST /readings│  │ GET  /certificates│  │ GET  /api/health        │  │
  │  │               │  │                  │  │                         │  │
  │  │ 1. Verify     │  │ Filter by date,  │  │ Returns { status: ok }  │  │
  │  │    Ed25519 sig│  │ meter, page      │  │ Used by smoke tests     │  │
  │  │ 2. Anchor hash│  │ CSV export       │  └─────────────────────────┘  │
  │  │    on Stellar │  └──────────────────┘                               │
  │  │ 3. Mint token │  ┌──────────────────────────────┐                   │
  │  │ 4. Store cert │  │ POST /certificates/[id]/retire│                  │
  │  └───────────────┘  └──────────────────────────────┘                   │
  │                                                                         │
  │  Shared libraries (apps/web/src/lib/)                                   │
  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
  │  │ stellar.ts │  │supabase.ts │  │  crypto.ts │  │    cache.ts      │  │
  │  │            │  │            │  │            │  │                  │  │
  │  │ anchorRead.│  │ Service +  │  │ Ed25519    │  │ Redis-backed     │  │
  │  │ mintCerts  │  │ anon client│  │ reading    │  │ cert invalidation│  │
  │  │ retireCert │  │ (Supabase) │  │ hash       │  │                  │  │
  │  └────────────┘  └────────────┘  └────────────┘  └──────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
        │                               │
        │ Soroban SDK calls             │ SQL / RLS
        ▼                               ▼
  ┌──────────────────────────┐   ┌──────────────────────────────────────────┐
  │  Stellar Testnet          │   │              Supabase (Postgres)          │
  │                          │   │                                          │
  │  ┌─────────────────────┐ │   │  Tables:                                 │
  │  │   energy_token      │ │   │  • cooperatives  (id, name, admin_addr)  │
  │  │   (SEP-41 token)    │ │   │  • meters        (id, pubkey_hex, active)│
  │  │   1 token = 1 kWh   │ │   │  • readings      (id, kwh, anchored,     │
  │  └─────────────────────┘ │   │                   minted, tx hashes)     │
  │  ┌─────────────────────┐ │   │  • certificates  (id, kwh, retired,      │
  │  │   audit_registry    │ │   │                   anchor_tx, mint_tx,    │
  │  │   immutable anchors │ │   │                   ew_token_id)            │
  │  └─────────────────────┘ │   │  • cooperative_goals (id, cooperative_id,│
  │  ┌─────────────────────┐ │   │                   period, target_kwh)    │
  │  │community_governance │ │   │                                          │
  │  │proposals + voting   │ │   │  RLS: row-level security per cooperative │
  │  └─────────────────────┘ │   └──────────────────────────────────────────┘
  └──────────────────────────┘
        │
        │  Certificate created event
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │              Energy Web Origin Bridge (Node.js + ethers.js)             │
  │                                                                         │
  │  1. Receive new certificate (id, kwh, anchor_tx)                        │
  │  2. Issue ERC-1888 EAC token on Energy Web Chain                        │
  │     metadata: { solarproofCertId, solarproofAnchorTx, kwh }             │
  │  3. Store ERC-1888 token ID on certificate (ew_token_id)                │
  │  4. Retry with backoff on failure; idempotent per certificate           │
  └─────────────────────────────────────────────────────────────────────────┘
        │
        │  ERC-1888 mint
        ▼
  ┌──────────────────────────┐
  │   Energy Web Chain        │
  │   ERC-1888 EAC registry   │
  └──────────────────────────┘
        ▲
        │  Verify chain of custody
        │
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                       Public Verifier  /verify                          │
  │                                                                         │
  │  Input:  certificate ID or tx hash                                      │
  │  Output: meter reading → Ed25519 proof → ledger anchor → cert → retired │
  │  Also:   embed code generator for third-party sites                     │
  └─────────────────────────────────────────────────────────────────────────┘
        ▲
        │  iframe embed (no auth)
        │
  ┌─────────────────────────────────────────────────────────────────────────┐
  │              Embeddable Widget  /embed/certificate/[id]                 │
  │                                                                         │
  │  Shows: kWh, issued date, cooperative name, retired status, QR code     │
  │  Cache-friendly; sandbox iframe attributes enforced                     │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │              Mobile App  (React Native, apps/mobile/)                   │
  │                                                                         │
  │  Screens: login, meter list, meter detail, reading history              │
  │  Shared business logic from @solarproof/stellar                         │
  │  Push notifications: failed readings, certificate issuance              │
  │  Offline support: cached meter list readable without connectivity       │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### Frontend (`apps/web/src/app/`)

| Route | Component | Description |
|---|---|---|
| `/` | `page.tsx` | Landing page / product overview |
| `/dashboard` | `dashboard/page.tsx` | Operator metrics: kWh totals, certificate counts, charts, recent readings, production goal tracker |
| `/certificates` | `certificates/page.tsx` | Certificate history with date/meter filters and CSV export |
| `/verify` | `verify/page.tsx` | Public chain-of-custody verifier (no login required); includes embed code generator |
| `/embed/certificate/[id]` | `embed/certificate/[id]/page.tsx` | Iframe-embeddable certificate verification widget (no auth, cache-friendly) |

### API Routes (`apps/web/src/app/api/`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness probe used by smoke tests and uptime monitoring |
| `/api/readings` | POST | Accept signed meter reading; verify Ed25519, anchor on Stellar, mint token |
| `/api/certificates` | GET | List certificates with filtering (date, meter) and CSV export |
| `/api/certificates/[id]/retire` | POST | Retire a certificate via the energy_token contract |
| `/api/verify` | GET | Resolve a certificate ID or tx hash to its full audit chain |
| `/api/goals` | GET/POST | Read and configure cooperative production goals (kWh per period) |

### Smart Contracts (`apps/contracts/`)

| Contract | Language | Purpose |
|---|---|---|
| `energy_token` | Rust / Soroban | SEP-41 token — 1 token = 1 kWh; supports mint and retire |
| `audit_registry` | Rust / Soroban | Immutable store of signed meter reading hashes |
| `community_governance` | Rust / Soroban | Cooperative proposals and on-chain voting |

### Shared Packages (`packages/stellar/`)

| Export | Purpose |
|---|---|
| `kwhToStroops(kwh)` | Unit conversion: kWh → Stellar stroops (contract amount) |

The `@solarproof/stellar` package is also consumed by the React Native mobile
app (`apps/mobile/`) so that unit conversion and Stellar-related business logic
stay in sync across web and mobile clients.

### Mobile App (`apps/mobile/`)

A React Native application for field meter operators, published to the App
Store and Google Play.

| Screen | Description |
|---|---|
| Login | Authenticates the operator against Supabase |
| Meter list | Lists meters for the operator's cooperative; cached for offline reading |
| Meter detail | Shows meter status and metadata |
| Reading history | Paginated reading history per meter |

- **Shared logic**: reuses business logic from `@solarproof/stellar`.
- **Push notifications**: delivered for failed readings and certificate issuance.
- **Offline support**: the meter list is cached locally and remains readable
  without connectivity.

### Production Goals (`cooperative_goals`)

Cooperatives can configure a kWh production target per period. The dashboard
renders a progress bar comparing actual vs target kWh and raises an alert when
production falls below 80% of the target pace. Goal data is stored in the
Supabase `cooperative_goals` table (see the Supabase tables above).

### Embeddable Certificate Widget (`/embed/certificate/[id]`)

A standalone, iframe-embeddable page that third-party sites (buyers, auditors)
can embed to display a "verified green energy" badge linking back to SolarProof.

- Displays: kWh, issued date, cooperative name, retired status, and a QR code.
- No authentication required; responses are cache-friendly.
- Sandbox iframe attributes are enforced.
- The `/verify` page provides an embed code generator that produces the iframe
  snippet for a given certificate.

### Internationalization

The web app supports multiple locales via message catalogs in `messages/`
(`en.json`, `fr.json`, `es.json`). Supported locales are declared in
`SUPPORTED_LOCALES`, and the language switcher exposes each option (e.g.
"Español" for Spanish). Date and number formatting uses the matching BCP-47
locale (e.g. `es-ES` for Spanish). The `i18n:check` CI job validates that every
locale catalog contains all translation keys.

### Infrastructure

| Component | Technology | Role |
|---|---|---|
| Hosting | Vercel | Next.js serverless deployment |
| Database | Supabase (Postgres) | Persistent store for readings, meters, certificates, cooperative goals |
| Blockchain | Stellar Testnet | On-chain anchoring and certificate tokens |
| Bridge | Energy Web Origin bridge (Node.js + ethers.js) | Issues ERC-1888 EAC tokens on Energy Web Chain for each new certificate |
| Mobile | React Native | Field operator app (App Store + Google Play) |
| Monorepo | Turborepo + pnpm | Build orchestration and workspace management |
| CI | GitHub Actions | Lint, type-check, build, i18n:check, Rust fmt/clippy/test |
| Monitoring | Sentry | Runtime error tracking (client + server + edge) |
| Analytics | Vercel Analytics + Speed Insights | Frontend performance and usage |

### Energy Web Origin Bridge (`services/ew-origin-bridge/`)

A standalone Node.js microservice (ethers.js) that mirrors each new SolarProof
certificate as an ERC-1888 EAC token on Energy Web Chain. It consumes certificate
creation events, embeds the SolarProof Stellar anchor tx hash in the token
metadata, and writes the resulting ERC-1888 token ID back onto the certificate
record. Failures are retried with backoff; issuance is idempotent per certificate.

See [ADR-008: Energy Web Origin Bridge](./adr/008-energy-web-origin-bridge.md)
and [IREC / Energy Web Interop](./IREC_ENERGYWEB_INTEROP.md) for details.

---

## Data Flow — Meter Reading to Certificate

```
1. Meter generates Ed25519 keypair (scripts/gen-meter-key.mjs)
2. Meter signs: sign({ meter_id, kwh_in_stroops, timestamp })
3. POST /api/readings with { meter_id, kwh, timestamp, signature_hex }
4. API verifies signature against meter.pubkey_hex from Supabase
5. API computes reading hash = SHA-256(meter_id ‖ kwh_stroops ‖ timestamp)
6. API calls audit_registry.anchor(reading_hash) on Stellar → anchor_tx_hash
7. API calls energy_token.mint(recipient, kwh_stroops) → mint_tx_hash
8. API inserts certificate row in Supabase
9. Energy Web Origin bridge issues ERC-1888 EAC token on Energy Web Chain,
   embedding anchor_tx_hash in token metadata → ew_token_id
10. Bridge stores ew_token_id on the certificate row
11. Operator views certificate on /certificates (web) or mobile reading history
12. Auditor verifies full chain on /verify or via an embedded widget
```

---

## Security Boundaries

- **Meter → API**: Ed25519 signature verification; invalid signatures rejected with 401
- **API → Supabase**: Service role key used server-side only; never exposed to client
- **API → Stellar**: Minter secret key stored as server-side env var (`MINTER_SECRET_KEY`)
- **Bridge → Energy Web Chain**: Bridge signer key stored as server-side env var only; never exposed to client or logs
- **Client → Supabase**: Anon key with row-level security policies per cooperative
- **Public Verifier**: Read-only, no authentication required
- **Embed Widget**: No authentication required; sandbox iframe attributes enforced; cache-friendly responses contain only public certificate data
- **Mobile App**: Authenticates via Supabase; cached data stored locally on device for offline access

See [ADR-008: Energy Web Origin Bridge](./adr/008-energy-web-origin-bridge.md)
for the bridge's token metadata schema, retry/idempotency model, and security
considerations.