# SolarProof

> End-to-end cryptographic proof of renewable energy — from physical meter to on-chain certificate.

[![CI](https://github.com/katecatherinaa/solarproof/actions/workflows/ci.yml/badge.svg)](https://github.com/katecatherinaa/solarproof/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/katecatherinaa/solarproof/branch/main/graph/badge.svg)](https://codecov.io/gh/katecatherinaa/solarproof)
[![License](https://img.shields.io/badge/License-Apache%202.0-green)](LICENSE)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue?logo=stellar)](https://stellar.org)
[![Tests](https://img.shields.io/badge/Tests-passing-brightgreen)](#)
[![Uptime](https://img.shields.io/badge/Status-status.solarproof.app-brightgreen)](https://status.solarproof.app)

**SolarProof** closes the gap between physical energy generation and verifiable on-chain certification. Every kilowatt-hour is signed at the meter, anchored to Stellar, and publicly auditable — no trust required.

---

## The problem

Existing renewable energy certificate systems (I-REC, TIGR, Energy Web) have a critical weakness: **there is no cryptographic link between the physical meter reading and the on-chain certificate**. Anyone can mint a certificate. Nobody can prove it corresponds to real generation.

SolarProof fixes this with three guarantees:

1. **Signed at source** — each meter reading is Ed25519-signed by the device before leaving the hardware
2. **Anchored on-chain** — the signed reading hash is recorded on Stellar alongside the minted certificate
3. **Publicly verifiable** — any regulator, buyer, or auditor can verify the full chain: `meter → signature → ledger → certificate → retirement`

---

## Architecture

```
Smart Meter (Ed25519 keypair)
        │  POST /api/readings  { kwh, timestamp, signature }
        ▼
SolarProof API (Next.js)
        │  1. Verify Ed25519 signature
        │  2. Anchor reading hash to Stellar (audit_registry contract)
        │  3. Mint energy_token (1 token = 1 kWh)
        │  4. If mint fails → tracer-sim auto-diagnosis
        ▼
Stellar Testnet (Soroban)
        ├── energy_token        — SEP-41 certificate token
        ├── audit_registry      — immutable signed-reading anchors
        └── community_governance — cooperative proposals + voting
        ▼
Public Verifier  (https://solarproof.vercel.app/verify)
        │  Input: certificate ID or tx hash
        │  Output: full chain of custody
        └── meter reading → Ed25519 proof → ledger anchor → certificate → retirement
```

---

## What makes it unique

| Feature | SolarProof | I-REC | Energy Web |
|---|---|---|---|
| Cryptographic meter proof | ✅ Ed25519 | ❌ | ❌ |
| On-chain audit anchor | ✅ Soroban | ❌ | Partial |
| Auto-debugging failed mints | ✅ tracer-sim | ❌ | ❌ |
| Public verifier (no login) | ✅ | ❌ | ❌ |
| Open source | ✅ Apache-2.0 | ❌ | Partial |

---

## Smart Contracts (Soroban)

Deployed on Stellar Testnet:

| Contract | Purpose |
|---|---|
| `energy_token` | SEP-41 certificate token (1 token = 1 kWh) |
| `audit_registry` | Immutable anchor of signed meter readings |
| `community_governance` | Cooperative governance (proposals + voting) |

Built with **Soroban SDK 23.1.0** and **OpenZeppelin Stellar v0.5.1**.

---

## Quick Start

> **New to the project?** See the [Developer Onboarding Guide](docs/ONBOARDING.md) for a step-by-step walkthrough from prerequisites to a live meter reading simulation.

### Prerequisites

- Node.js v22+
- pnpm v10+
- Rust + Cargo
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)

### Install

```bash
git clone https://github.com/katecatherinaa/solarproof.git
cd solarproof
pnpm install
```

### Run

```bash
pnpm dev        # Next.js on http://localhost:3000
```

### Contracts

```bash
cd apps/contracts
stellar contract build
cargo test
```

### Docker (recommended for local development)

Spin up the full stack — Next.js, Supabase, and Redis — with a single command:

```bash
cp apps/web/.env.example .env.local   # fill in your values
docker compose up
```

The web app will be available at http://localhost:3000.

All three services include health checks:

| Service | Health check | Endpoint / command |
|---|---|---|
| `web` | HTTP poll | `GET /api/health` every 30s |
| `supabase-db` | pg_isready | `pg_isready -U postgres` every 10s |
| `redis` | CLI ping | `redis-cli ping` every 10s |

The `web` service waits for both `supabase-db` and `redis` to be healthy before starting (`depends_on: condition: service_healthy`).

Data is persisted in named Docker volumes (`supabase_data`, `redis_data`) so it survives container restarts.

To stop and remove containers (volumes are kept):

```bash
docker compose down
```

**Minimum host requirements for Docker Compose:**

| Resource | Minimum |
|---|---|
| RAM | 2 GB available to Docker |
| CPU | 2 cores |
| Disk | 4 GB free |

Resource limits per service (defined in `docker-compose.yml`):

| Service | Memory limit | CPU limit |
|---|---|---|
| `web` | 1 GB | 1.0 core |
| `supabase-db` | 512 MB | 0.5 core |
| `redis` | 128 MB | 0.25 core |

### Simulate a meter reading

```bash
# Generate a meter keypair
node scripts/gen-meter-key.mjs

# Send a signed reading
node scripts/send-reading.mjs --kwh 12.5 --key ./meter-key.json
```

> **Building real hardware?** See the [Hardware Meter Integration Guide](docs/HARDWARE_METER_INTEGRATION_GUIDE.md) for the full onboarding quick-start, Ed25519 signing protocol, API specification, and meter certification checklist.

### API Documentation

An interactive API playground (Redoc / Swagger UI) is rendered from [`openapi.yaml`](openapi.yaml) at **`/api/docs/ui`** — available in local development and staging (not gated in production).

- Local: http://localhost:3000/api/docs/ui
- Staging: https://staging.solarproof.app/api/docs/ui

Try-it-out is enabled with pre-filled example values, so you can explore and test endpoints without Postman. See also [docs/API.md](docs/API.md).

---
=======

## Monorepo Structure

```
solarproof/
├── apps/
│   ├── contracts/
│   │   ├── energy_token/
│   │   ├── audit_registry/
│   │   └── community_governance/
│   └── web/                    # Next.js dashboard + API + public verifier
├── packages/
│   └── stellar/                # Shared Stellar utilities
├── scripts/                    # Meter simulation scripts
├── docs/
└── .github/
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | Stellar (Soroban) |
| Smart Contracts | Rust + OpenZeppelin Stellar v0.5.1 |
| Frontend | Next.js 15 + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Wallet | Freighter + Stellar Wallets Kit |
| Backend | Next.js API Routes + Supabase |
| Signing | Ed25519 (meter devices) |
| Debugging | tracer-sim (Soroban replay) |
| Deployment | Vercel |
| Monorepo | Turborepo + pnpm |

---

## Product Levels

| Level | What | Status |
|---|---|---|
| 1 | Signed meter readings + on-chain anchoring | ✅ Current |
| 2 | Hardware HSM integration (YubiKey / TPM) | ✅ Completed |
| 3 | I-REC / Energy Web / TIGR bridge (#609) | 🔮 Future |

---

## Status & Uptime Monitoring

Production endpoint health is tracked at **[status.solarproof.app](https://status.solarproof.app)**, powered by [Upptime](https://upptime.js.org) via the `katecatherinaa/solarproof-status` repository.

Monitored endpoints (1-minute check interval, 99.5% SLA):

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Application health |
| `GET /verify` | Public verifier page |
| `POST /api/readings` | Meter reading ingest |

Alerts are sent to Slack on any outage. For incident response, see the [incident runbook](docs/runbooks/incident-response.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs target `develop`.

See [CHANGELOG.md](CHANGELOG.md) for a history of notable changes.

---

## License

Apache-2.0 — See [LICENSE](LICENSE).

---

*Built on Stellar · SolarProof Contributors 2026*

## Handsoff notes

<!-- handsoff-issue-129 -->
- #129: [Product] Meter health monitoring — alert on readings gap
