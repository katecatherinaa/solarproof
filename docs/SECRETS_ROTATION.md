# Secrets & Key Rotation Procedures (#527)

This document outlines recommended procedures and tooling for rotating GitHub secrets, Stellar keys, and service role credentials safely without downtime.

Acceptance Criteria
- Rotation steps are documented
- Secrets can be rotated without downtime
- Compromised credential handling is defined

1. Goals

- Minimize service downtime during rotation.
- Ensure there is an auditable, repeatable process for rotating credentials.
- Provide a clear incident response for compromised credentials.

2. Scope

- GitHub repository secrets (Actions, Environments)
- Stellar keypairs used for contracts and service accounts
- Cloud/service role credentials (CI/CD runners, hosted services)

3. High-level Rotation Steps

- Prepare: identify secret owners, usage locations, and dependent services. Record current versions in a secure audit log.
- Staged rollout: create a new credential alongside the existing one and deploy config that accepts either key (dual-authorization) where possible.
- Switch: update consumers to use the new credential and verify functionality.
- Revoke: remove old credential once verification and cool-down windows complete.

4. GitHub Secrets

- Use GitHub Environments for environment-specific secrets and restrict access via required reviewers.
- To rotate:
  1. Add new secret value under a temporary key name (e.g., `MY_SERVICE_KEY_v2`).
  2. Update workflows or services to read the new key name (support both during rollout).
  3. After verification, rename or remove the old key and set the canonical key name to the new value.

5. Stellar Keys

- Use a key management system (HashiCorp Vault, AWS Secrets Manager) to store Stellar seed phrases.
- To rotate service keys:
  1. Generate new keypair and store seed securely.
  2. Update contract owners or service account associations to include the new public key where necessary.
  3. Update consumers incrementally to use new signing keys (dual-signing where possible).
  4. Revoke old seed access.

6. Service Role Credentials

- Where supported, use short-lived credentials (STS) and rotating tokens via a secrets manager.
- Document the rotation schedule and automate via CI jobs that update secrets and trigger a verification pipeline.

6.1 `SUPABASE_SERVICE_ROLE_KEY` — 90-day rotation

The `SUPABASE_SERVICE_ROLE_KEY` is a long-lived credential that bypasses Row Level Security (RLS). It must be rotated every **90 days** (or immediately on suspected compromise, see §7) and scoped to the minimum permissions required by the backend service. See `docs/SECRETS.md` for where this key is stored and consumed.

**Rotation procedure (no downtime):**

1. **Create the new key** — in the Supabase dashboard, generate a new service role key (or a scoped API key with the minimum required permissions). Store it in the secrets manager under a temporary name (e.g., `SUPABASE_SERVICE_ROLE_KEY_v2`). Do not overwrite the current key yet.
2. **Dual-accept window** — deploy configuration so consumers accept both the old and new keys (e.g., the backend reads `SUPABASE_SERVICE_ROLE_KEY` and falls back to `SUPABASE_SERVICE_ROLE_KEY_v2`, or the secrets manager serves both versions). Verify the new key works end-to-end before proceeding.
3. **Switch consumers** — update all consumers (CI/CD workflows, hosted services, backend jobs) to use the new key as the canonical `SUPABASE_SERVICE_ROLE_KEY`. Confirm health checks and integration tests pass.
4. **Revoke the old key** — after a cool-down window (minimum 24 hours) with no errors, revoke the old key in Supabase and remove it from the secrets manager and GitHub secrets.
5. **Record the rotation** — write an audit log entry (see below) and update the `updated_at` timestamp used by the reminder workflow.

**Testing the procedure:**

- Run the rotation in a staging environment first using the same steps above.
- Confirm the dual-accept window works by exercising a request with each key version.
- Run the verification pipeline (`.github/workflows/secrets-rotation-reminder.yml` with `dry_run=true`, plus the standard CI suite) to confirm consumers resolve the new key.
- Verify the old key is rejected after revocation (expect `401`/`403` from Supabase).

**Expiry alerting:**

- The `.github/workflows/secrets-rotation-reminder.yml` job compares the key's `updated_at` against the 90-day max age and opens a GitHub issue when it is exceeded.
- An additional warning issue is created when the key is within **14 days** of its 90-day expiry, so rotation can be scheduled before it lapses.
- Alerts are routed to the `backend-team` owner listed in §8.

**Audit log:**

- Every rotation must create an audit log entry recording: the secret name, the rotation timestamp, the operator, the old key version (never the key value), and the new key version.
- Audit entries are retained per the incident/audit policy and referenced in the rotation issue.
=======

7. Compromised Credential Handling

- Immediate actions:
  - Revoke the compromised credential immediately.
  - Audit recent logs and rotate any related keys.
  - Create incident ticket and notify stakeholders.
- Post-incident:
  - Rotate all related credentials.
  - Review and improve access controls.

8. Rotation Schedule (per secret type)

| Secret | Max Age | Owner | Procedure |
|--------|---------|-------|-----------|
| `SUPABASE_SERVICE_ROLE_KEY` | 90 days | backend-team | §6.1 Service Role Credentials |
| `MINTER_SECRET_KEY` | 180 days | contracts-team | §5 Stellar Keys |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 365 days | backend-team | §4 GitHub Secrets |
| `STELLAR_TESTNET_SECRET_KEY` | 180 days | contracts-team | §5 Stellar Keys |
| `VERCEL_TOKEN` | 90 days | devops-team | §6 Service Role Credentials |
| `TURBO_TOKEN` | 90 days | devops-team | §6 Service Role Credentials |

9. Automation — Rotation Reminder CI Job

The workflow `.github/workflows/secrets-rotation-reminder.yml` runs automatically on the 1st of every month at 09:00 UTC and can also be triggered manually via `workflow_dispatch`.

**What it does:**
- Reads secret `updated_at` timestamps from the GitHub API.
- Compares each secret's age against the rotation schedule above.
- Creates a GitHub issue for every secret that exceeds its max age (skips if an open issue already exists for that secret).
- Supports a `dry_run` input to report without creating issues.

**Trigger manually:**
```bash
gh workflow run secrets-rotation-reminder.yml --field dry_run=true
```

**Gitleaks:**
The `secret-scanning.yml` workflow runs Gitleaks on every push and pull request to `main`/`develop` and on a weekly schedule. The `.gitleaks.toml` configuration file in the repo root controls which patterns are scanned.

10. References
- See `docs/DEPLOYMENT.md` and repository CI config for current secret usage patterns.
- Secret storage and consumption map: `docs/SECRETS.md`
- Automation workflow: `.github/workflows/secrets-rotation-reminder.yml`
- Secret scanning workflow: `.github/workflows/secret-scanning.yml`

Link to issue: #527 | #72
