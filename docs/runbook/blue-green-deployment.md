# Blue-Green Deployment Runbook

**Last updated:** 2026-10-17  
**Relates to:** [Issue #301](https://github.com/katecatherinaa/solarproof/issues/301), [Issue #63](https://github.com/katecatherinaa/solarproof/issues/63)

## Overview

SolarProof uses Vercel's built-in preview/production promotion model to implement a blue-green deployment strategy. The **blue** environment is the current live production deployment; the **green** environment is the new version being validated before traffic is shifted.

```
Internet → Vercel Edge → [blue] production (current)
                       → [green] preview URL (new version, under validation)
```

Traffic is only shifted to green after health checks pass. Rollback is instant — re-promote the previous deployment.

---

## Prerequisites

- Vercel CLI: `npm i -g vercel@latest`
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` set in CI secrets
- `/api/health` endpoint returning `200 OK` with `{ "status": "ok" }`

---

## Deployment Steps

### 1. Deploy to preview (green)

```bash
vercel deploy --token $VERCEL_TOKEN
# Outputs a preview URL, e.g. https://solarproof-abc123.vercel.app
```

### 2. Run health checks against green

```bash
PREVIEW_URL="https://solarproof-abc123.vercel.app"

for i in $(seq 1 5); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PREVIEW_URL/api/health")
  [ "$STATUS" = "200" ] && echo "Health check $i passed" && continue
  echo "Health check $i FAILED (HTTP $STATUS)" && exit 1
done
```

### 3. Promote green to production (shift traffic)

Only run after all health checks pass:

```bash
vercel promote $PREVIEW_URL --token $VERCEL_TOKEN
```

Vercel atomically shifts 100% of production traffic to the new deployment.

---

## Rollback

Instant rollback to the previous production deployment:

```bash
# List recent deployments
vercel ls --token $VERCEL_TOKEN

# Promote the previous stable deployment
vercel promote <previous-deployment-url> --token $VERCEL_TOKEN
```

Rollback completes in under 30 seconds with no downtime.

---

## CI Integration

The `.github/workflows/blue-green-deploy.yml` workflow automates this process:

1. Install Node/pnpm dependencies
2. Build and deploy to Vercel preview (green slot)
3. Run `/api/health` checks (5 retries, 10 s apart) — **must pass before smoke test**
4. Run `scripts/smoke-test.mjs` against the green slot — **cut-over is gated on exit 0**
5. On smoke test success: `vercel promote` shifts 100 % of production traffic to green
6. On smoke test or health check failure: production stays on blue; Slack alert fired

---

## Smoke Test Gate (Issue #63)

`scripts/smoke-test.mjs` performs an end-to-end transaction against the green preview URL:

- Submits a synthetic meter reading to `audit_registry`
- Verifies the anchor is recorded
- Mints an energy certificate token via `energy_token`
- Checks the recipient balance

### Required secrets for smoke test

| Secret | Description |
|---|---|
| `ENERGY_TOKEN_ID` | Testnet energy_token contract ID |
| `AUDIT_REGISTRY_ID` | Testnet audit_registry contract ID |
| `SMOKE_METER_SECRET_KEY` | Testnet keypair for the simulated meter |
| `SMOKE_TOKEN_MINTER_SECRET_KEY` | Testnet minter keypair |
| `SLACK_WEBHOOK_URL` | (Optional) Incoming Webhook for failure alerts |

### What happens on smoke test failure

1. The `Run smoke test against green slot` step exits non-zero.
2. The `Promote green to production` step is **skipped** — production traffic stays on blue.
3. The `notify-failure` job fires and:
   - Posts a summary to the GitHub Actions workflow summary page.
   - Sends a Slack alert (if `SLACK_WEBHOOK_URL` is set).

---

## Rollback Procedure

### Automatic (smoke test fails before cut-over)

No action needed — production was never updated. The green preview URL remains live
as an isolated environment. Investigate, fix, and push a new commit to `main`.

### Manual rollback after a bad promote

If a problem is discovered after cut-over, re-promote the previous stable deployment:

```bash
# 1. List recent Vercel deployments
vercel ls --token $VERCEL_TOKEN

# 2. Promote the last known-good deployment URL
vercel promote <previous-deployment-url> --token $VERCEL_TOKEN
```

Rollback completes in under 30 seconds with no downtime.

---

---

## Health Check Endpoint

`GET /api/health` must return:

```json
{ "status": "ok", "version": "<git-sha>" }
```

HTTP 200 on healthy, HTTP 503 on degraded.

---

## Intervals and Retries

| Check | Interval | Retries | Timeout |
|---|---|---|---|
| Preview health | 10s | 5 | 5s per request |
| Post-promote verification | 30s | 3 | 10s per request |
