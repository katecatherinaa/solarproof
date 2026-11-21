-- Token revocation list
-- Stores JTI (JWT ID) of revoked access tokens so compromised tokens can be
-- rejected before their 15-minute expiry window closes.
create table if not exists public.revoked_tokens (
  jti        text        primary key,
  revoked_at timestamptz not null default now(),
  -- Automatically purge rows after the max access-token lifetime (15 min)
  expires_at timestamptz not null
);

-- Index for fast lookup on every authenticated request
create index if not exists revoked_tokens_expires_at_idx on public.revoked_tokens (expires_at);

-- RLS: only service-role can insert/delete; no row is readable by end users
alter table public.revoked_tokens enable row level security;

create policy "service role only" on public.revoked_tokens
  using (false);  -- deny all; service role bypasses RLS

-- Scheduled cleanup: remove expired entries (run via pg_cron or Supabase scheduled functions)
-- Example: select cron.schedule('purge-revoked-tokens', '*/15 * * * *',
--   $$delete from public.revoked_tokens where expires_at < now()$$);


-- Refresh token rotation & reuse detection
-- Stores hashed refresh tokens so that every refresh call can invalidate the
-- previous token (rotation) and detect reuse of an already-used token. When a
-- used token is presented again, the entire session family is revoked.
create table if not exists public.refresh_tokens (
  -- SHA-256 hash of the raw refresh token (never store the raw value)
  token_hash        text        primary key,
  -- Identifier grouping all tokens descended from a single login session
  session_family_id uuid        not null,
  -- The token that was rotated to produce this one (null for the first token)
  parent_token_id   text,
  -- Owner of the session
  user_id           uuid        not null,
  -- Set when this token has been consumed by a rotation
  used_at           timestamptz,
  -- Set when this token (or its whole family) has been revoked
  revoked_at        timestamptz,
  -- Absolute expiry of the refresh token
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);

-- Fast lookup of all tokens in a session family (for family-wide revocation)
create index if not exists refresh_tokens_session_family_id_idx
  on public.refresh_tokens (session_family_id);

-- Index to support scheduled cleanup of expired tokens
create index if not exists refresh_tokens_expires_at_idx
  on public.refresh_tokens (expires_at);

-- RLS: only service-role can read/write; no row is accessible to end users
alter table public.refresh_tokens enable row level security;

create policy "service role only" on public.refresh_tokens
  using (false);  -- deny all; service role bypasses RLS

-- Scheduled cleanup: remove expired entries (run via pg_cron or Supabase scheduled functions)
-- Example: select cron.schedule('purge-refresh-tokens', '*/15 * * * *',
--   $$delete from public.refresh_tokens where expires_at < now()$$);