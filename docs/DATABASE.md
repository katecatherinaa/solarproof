# Database Schema

## Migration 001

```sql
create table cooperatives (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_address text not null,
  created_at timestamptz not null default now()
);

create table meters (
  id uuid primary key default gen_random_uuid(),
  cooperative_id uuid not null references cooperatives(id) on delete cascade,
  serial_number text not null unique,
  pubkey_hex text not null,   -- Ed25519 public key (64 hex chars = 32 bytes)
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table readings (
  id uuid primary key default gen_random_uuid(),
  meter_id uuid not null references meters(id) on delete cascade,
  kwh numeric(12,4) not null check (kwh > 0),
  timestamp timestamptz not null,
  reading_hash text not null unique,   -- SHA-256 hex
  signature_hex text not null,         -- Ed25519 signature hex (128 chars)
  anchor_tx_hash text,
  mint_tx_hash text,
  anchored boolean not null default false,
  minted boolean not null default false
);

create table certificates (
  id uuid primary key default gen_random_uuid(),
  cooperative_id uuid not null references cooperatives(id) on delete cascade,
  reading_id uuid not null references readings(id),
  reading_hash text not null,
  anchor_tx_hash text not null,
  mint_tx_hash text not null unique,
  kwh numeric(12,4) not null,
  issued_at timestamptz not null default now(),
  retired boolean not null default false,
  retired_at timestamptz,
  retired_by text
);
```

## Migration 002 — indexes

```sql
create index on meters(cooperative_id);
create index on readings(meter_id);
create index on readings(reading_hash);
create index on certificates(cooperative_id);
create index on certificates(reading_hash);
create index on certificates(mint_tx_hash);
```

## Connection Pooling (PgBouncer)

Direct Supabase connections from Next.js serverless functions exhaust the
database connection limit under load. All server-side database access must go
through PgBouncer (Supabase's built-in pooler) instead of the direct connection.

### Pooled connection string

Use the pooler host/port (port `6543`, transaction mode) for application
traffic, and keep the direct connection (port `5432`) only for migrations:

```bash
# Application (serverless functions) — pooled, transaction mode
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Migrations / admin tasks only — direct connection
DIRECT_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

Notes:

- `pgbouncer=true` tells Prisma to disable prepared statements, which are not
  supported in transaction pooling mode.
- `connection_limit=1` keeps each serverless instance to a single pooled
  connection; PgBouncer multiplexes many instances over a small server-side
  pool.
- Never use the direct `5432` URL from serverless functions.

### Tuning the pool size

Size the server-side pool for the expected serverless concurrency:

```
pool_size = expected_concurrent_requests / number_of_function_instances
```

Example: 500 concurrent users spread over ~50 warm function instances gives
`pool_size = 500 / 50 = 10` server-side connections per pool. Configure this
via the Supabase pooler settings (`default_pool_size`, `max_client_conn`) or
the `PGBOUNCER_POOL_SIZE` environment variable used by the deployment.

| Setting              | Value | Rationale                                   |
| -------------------- | ----- | ------------------------------------------- |
| `pool_mode`          | transaction | Best multiplexing for short serverless queries |
| `default_pool_size`  | 10    | 500 concurrency / 50 instances              |
| `max_client_conn`    | 1000  | Headroom above peak instance count          |
| `connection_limit`   | 1     | Per serverless instance                     |

### Health check: pool saturation

`/api/health` reports pool saturation so alerts can fire before exhaustion:

```json
{
  "status": "ok",
  "db": {
    "pool": {
      "active": 7,
      "idle": 3,
      "waiting": 0,
      "max": 10,
      "saturation": 0.7
    }
  }
}
```

`saturation = active / max`. Values above `0.8` should raise a warning and
above `0.95` should be treated as unhealthy.

### Load test (500 concurrent users)

Verify there are no connection errors under 500 concurrent users:

```bash
# Against a staging deployment using the pooled connection string
k6 run --vus 500 --duration 2m scripts/loadtest/connections.js
```

The test fails if any request returns a connection/pool error
(`too many connections`, `connection pool timeout`, `ECONNRESET`). Confirm the
health endpoint's `db.pool.waiting` stays at `0` and `saturation` stays below
`0.95` throughout the run.
