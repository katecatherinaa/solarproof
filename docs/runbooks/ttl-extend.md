# Runbook: Soroban TTL Auto-Extension Job

## Purpose

Soroban persistent ledger entries (audit_registry, energy_token) expire if their TTL is not extended. This job bumps TTLs before they reach the 7-day warning threshold, ensuring anchored proofs and energy certificates remain accessible.

## Schedule

The job runs daily via **Supabase pg_cron** (or Vercel Cron as an alternative):

```sql
-- Supabase pg_cron (run in SQL editor or migration)
select cron.schedule(
  'ttl-extend-daily',
  '0 4 * * *',  -- 04:00 UTC daily
  $$
    select net.http_post(
      url := 'https://<your-api>/api/jobs/ttl-extend',
      headers := '{"x-cron-secret": "<CRON_SECRET>"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);
```

Alternative — **Vercel Cron** (add to `vercel.json`):

```json
{
  "crons": [
    {
      "path": "/api/jobs/ttl-extend",
      "schedule": "0 4 * * *"
    }
  ]
}
```

> The endpoint requires the `x-cron-secret` header to match `CRON_SECRET` env var. Set this secret in Vercel and in the cron caller.

## Threshold Logic

| Constant | Value | Meaning |
|---|---|---|
| `WARNING_LEDGERS` | 120,960 | ~7 days at 5 s/ledger |
| `EXTEND_TO_LEDGERS` | 518,400 | ~30 days — bump target |

Any contract instance whose `liveUntilLedgerSeq` is within 120,960 ledgers of the current sequence will be extended.

## Contracts Monitored

- `NEXT_PUBLIC_AUDIT_REGISTRY_ID` (`audit_registry`)
- `NEXT_PUBLIC_ENERGY_TOKEN_ID` (`energy_token`)

## Failure Handling

- Each contract is processed independently; a failure on one does not block the other.
- Errors are logged via the structured logger and captured in **Sentry** with tag `job: ttl-extend`.
- The response body includes per-contract status; HTTP 207 indicates partial failure.

## Manually Triggering

```bash
curl -X POST https://<your-api>/api/jobs/ttl-extend \
  -H "x-cron-secret: <CRON_SECRET>"
```

Or via the Stellar CLI directly:

```bash
stellar contract extend-footprint-ttl \
  --id <CONTRACT_ID> \
  --ledgers-to-extend 518400 \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org
```

## Alerting

Sentry will fire an alert when the job fails for a contract. Ensure the `ttl-extend` alert rule is configured in your Sentry project with a notification channel (Slack / PagerDuty).
