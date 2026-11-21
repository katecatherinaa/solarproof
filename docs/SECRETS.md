# Secrets Management

This document describes how SolarProof manages secrets across all environments.

## Principle

No secrets are committed to the repository. Three tiers:

| Environment | Where secrets live |
|---|---|
| Local development | `apps/web/.env.local` (gitignored) |
| CI/CD (GitHub Actions) | GitHub Actions secrets |
| Production / Staging | Vercel environment variables |

---

## Required secrets

| Variable | Description | Environments |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | All |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public anon key | All |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side only) | All |
| `MINTER_SECRET_KEY` | Stellar secret key for the minter account | Local, CI, Staging |
| `MINTER_SECRET_ARN` | AWS Secrets Manager ARN for minter key | Production |
| `MINTER_PREVIOUS_SECRET_ARN` | ARN for previous key during rotation window | Production |
| `REDIS_URL` | Redis connection URL for job queue | All |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL for caching layer | Staging, Production |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token | Staging, Production |
| `NEXT_PUBLIC_ENERGY_TOKEN_ID` | Deployed energy_token contract ID | All |
| `NEXT_PUBLIC_AUDIT_REGISTRY_ID` | Deployed audit_registry contract ID | All |
| `NEXT_PUBLIC_COMMUNITY_GOVERNANCE_ID` | Deployed community_governance contract ID | All |
| `INTERNAL_BRIDGE_SECRET` | Shared secret for zero-trust auth between Next.js and the bridge service (sent as `X-Internal-Secret`) | All |
| `INTERNAL_BRIDGE_SECRET_ARN` | AWS Secrets Manager ARN for the bridge secret | Production |
| `INTERNAL_BRIDGE_PREVIOUS_SECRET_ARN` | ARN for previous bridge secret during rotation window | Production |

---

## Local development

1. Copy the template: `cp apps/web/.env.example apps/web/.env.local`
2. Fill in your values — never commit `.env.local`
3. `.env.local` and `.env.*.local` are listed in `.gitignore`

---

## GitHub Actions (CI/CD)

All secrets are stored in the repository's **Settings → Secrets and variables → Actions**.

Secrets used in CI (`.github/workflows/ci.yml`):

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
MINTER_SECRET_KEY
INTERNAL_BRIDGE_SECRET
TURBO_TOKEN
TURBO_TEAM
```

Staging-specific secrets (environment: `staging`):

```
STAGING_SUPABASE_URL
STAGING_SUPABASE_ANON_KEY
STAGING_SUPABASE_SERVICE_ROLE_KEY
STAGING_MINTER_SECRET_KEY
STAGING_ENERGY_TOKEN_ID
STAGING_AUDIT_REGISTRY_ID
STAGING_COMMUNITY_GOVERNANCE_ID
STAGING_INTERNAL_BRIDGE_SECRET
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID_STAGING
```

---

## Production (Vercel)

Set the following in the Vercel project's **Settings → Environment Variables** for the `production` environment:

- All `NEXT_PUBLIC_*` variables
- `SUPABASE_SERVICE_ROLE_KEY`
- `MINTER_SECRET_ARN` (points to AWS Secrets Manager; `MINTER_SECRET_KEY` is not used in production)
- `MINTER_PREVIOUS_SECRET_ARN` (set during the 24-hour key-rotation grace window)
- `INTERNAL_BRIDGE_SECRET_ARN` (points to AWS Secrets Manager; `INTERNAL_BRIDGE_SECRET` is not used in production)
- `INTERNAL_BRIDGE_PREVIOUS_SECRET_ARN` (set during the 24-hour bridge-secret rotation grace window)
- `AWS_REGION`
- `REDIS_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `LOGTAIL_SOURCE_TOKEN`
- `CORS_ALLOWED_ORIGINS`

Production never uses a plaintext `MINTER_SECRET_KEY`. The key is fetched at runtime from AWS Secrets Manager via `MINTER_SECRET_ARN` (see `src/lib/secrets.ts`).

The bridge service requires the `X-Internal-Secret` header on every request, including internal routes. Next.js injects `INTERNAL_BRIDGE_SECRET` on all outbound bridge calls; the bridge validates it in constant time and rejects requests with a missing or mismatched secret. In production the secret is fetched at runtime from AWS Secrets Manager via `INTERNAL_BRIDGE_SECRET_ARN`.

---

## Key rotation

1. Generate a new Stellar keypair for the minter account.
2. Store the new key as a new secret version in AWS Secrets Manager.
3. Update `MINTER_SECRET_ARN` in Vercel to point to the new ARN.
4. Set `MINTER_PREVIOUS_SECRET_ARN` to the old ARN for 24 hours (allows in-flight transactions to complete).
5. After 24 hours, clear `MINTER_PREVIOUS_SECRET_ARN`.

### Bridge internal secret rotation

The `INTERNAL_BRIDGE_SECRET` follows the same rotation process:

1. Generate a new random secret (e.g. `openssl rand -hex 32`).
2. Store the new secret as a new secret version in AWS Secrets Manager.
3. Update `INTERNAL_BRIDGE_SECRET_ARN` in Vercel to point to the new ARN.
4. Set `INTERNAL_BRIDGE_PREVIOUS_SECRET_ARN` to the old ARN for 24 hours (the bridge accepts either the current or previous secret during this window so in-flight calls succeed).
5. After 24 hours, clear `INTERNAL_BRIDGE_PREVIOUS_SECRET_ARN`.

---

## Secret scanning

GitHub secret scanning is enabled on this repository. Pre-commit hooks run [gitleaks](https://github.com/gitleaks/gitleaks) to catch accidental secret commits before they reach the remote. See `.gitleaks.toml` and `.pre-commit-config.yaml`.
