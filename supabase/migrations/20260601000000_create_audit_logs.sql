-- audit_logs: append-only audit trail for sensitive operations
-- Retention: minimum 2 years (enforced via Supabase retention policy or pg_cron)

create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  timestamp   timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  resource    text not null,
  resource_id text,
  ip          text,
  metadata    jsonb
);

-- Append-only: revoke UPDATE and DELETE from all roles
revoke update on public.audit_logs from anon, authenticated, service_role;
revoke delete on public.audit_logs from anon, authenticated, service_role;

-- Only service_role may insert
revoke insert on public.audit_logs from anon, authenticated;
grant insert on public.audit_logs to service_role;
grant select on public.audit_logs to service_role;

-- Index for time-range queries
create index if not exists audit_logs_timestamp_idx on public.audit_logs (timestamp desc);
create index if not exists audit_logs_actor_idx on public.audit_logs (actor);
create index if not exists audit_logs_action_idx on public.audit_logs (action);

-- ---------------------------------------------------------------------------
-- Hash-chaining for tamper detection
-- Each row stores content_hash = SHA-256 over its canonical content and
-- prev_hash = SHA-256 of the previous row's content (in timestamp, id order).
-- The first row's prev_hash is the 64-zero genesis value.
-- ---------------------------------------------------------------------------

alter table public.audit_logs add column if not exists prev_hash text;
alter table public.audit_logs add column if not exists content_hash text;

-- Index supporting ordered chain traversal / verification
create index if not exists audit_logs_timestamp_id_idx on public.audit_logs (timestamp, id);

-- Backfill existing rows in (timestamp, id) order, computing SHA-256 over
-- canonical row content and chaining each row to its predecessor.
do $$
declare
  r          record;
  v_prev     text := repeat('0', 64);
  v_content  text;
  v_hash     text;
begin
  for r in
    select id, timestamp, actor, action, resource, resource_id, ip, metadata
    from public.audit_logs
    order by timestamp asc, id asc
  loop
    v_content :=
      coalesce(r.id::text, '') || '|' ||
      coalesce(to_char(r.timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') || '|' ||
      coalesce(r.actor, '') || '|' ||
      coalesce(r.action, '') || '|' ||
      coalesce(r.resource, '') || '|' ||
      coalesce(r.resource_id, '') || '|' ||
      coalesce(r.ip, '') || '|' ||
      coalesce(r.metadata::text, '');

    v_hash := encode(digest(v_content, 'sha256'), 'hex');

    update public.audit_logs
      set prev_hash = v_prev,
          content_hash = v_hash
      where id = r.id;

    v_prev := v_hash;
  end loop;
end $$;

-- Ensure the pgcrypto extension is available for digest()
create extension if not exists pgcrypto;