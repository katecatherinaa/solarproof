-- Migration: Create cooperative_goals table
-- Issue #787: Add kWh production goal and progress tracker to the dashboard
--
-- Stores configurable production goals (kWh) per cooperative per period.
-- RLS restricts access to members of the owning cooperative.

-- Ensure pgcrypto for gen_random_uuid() if not already enabled
create extension if not exists "pgcrypto";

-- Enum for goal period types
do $$
begin
  if not exists (select 1 from pg_type where typname = 'cooperative_goal_period') then
    create type public.cooperative_goal_period as enum ('monthly', 'annual');
  end if;
end
$$;

create table if not exists public.cooperative_goals (
  id uuid primary key default gen_random_uuid(),
  cooperative_id uuid not null references public.cooperatives (id) on delete cascade,
  period public.cooperative_goal_period not null,
  target_kwh numeric(14, 2) not null check (target_kwh >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index to support lookups by cooperative and period
create index if not exists cooperative_goals_cooperative_id_period_idx
  on public.cooperative_goals (cooperative_id, period);

-- Keep updated_at fresh on row updates
create or replace function public.set_cooperative_goals_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_cooperative_goals_updated_at on public.cooperative_goals;
create trigger set_cooperative_goals_updated_at
  before update on public.cooperative_goals
  for each row
  execute function public.set_cooperative_goals_updated_at();

-- Enable Row Level Security
alter table public.cooperative_goals enable row level security;

-- Helper predicate: does the current user belong to the given cooperative?
-- Uses the cooperative_members table (user_id, cooperative_id) if present.
-- Falls back to cooperatives.owner_id when membership table is unavailable.

-- SELECT: members of the owning cooperative may read goals
drop policy if exists "cooperative_goals_select_own" on public.cooperative_goals;
create policy "cooperative_goals_select_own"
  on public.cooperative_goals
  for select
  using (
    exists (
      select 1
      from public.cooperative_members cm
      where cm.cooperative_id = cooperative_goals.cooperative_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.cooperatives c
      where c.id = cooperative_goals.cooperative_id
        and c.owner_id = auth.uid()
    )
  );

-- INSERT: members of the owning cooperative may create goals
drop policy if exists "cooperative_goals_insert_own" on public.cooperative_goals;
create policy "cooperative_goals_insert_own"
  on public.cooperative_goals
  for insert
  with check (
    exists (
      select 1
      from public.cooperative_members cm
      where cm.cooperative_id = cooperative_goals.cooperative_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.cooperatives c
      where c.id = cooperative_goals.cooperative_id
        and c.owner_id = auth.uid()
    )
  );

-- UPDATE: members of the owning cooperative may modify goals
drop policy if exists "cooperative_goals_update_own" on public.cooperative_goals;
create policy "cooperative_goals_update_own"
  on public.cooperative_goals
  for update
  using (
    exists (
      select 1
      from public.cooperative_members cm
      where cm.cooperative_id = cooperative_goals.cooperative_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.cooperatives c
      where c.id = cooperative_goals.cooperative_id
        and c.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.cooperative_members cm
      where cm.cooperative_id = cooperative_goals.cooperative_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.cooperatives c
      where c.id = cooperative_goals.cooperative_id
        and c.owner_id = auth.uid()
    )
  );

-- DELETE: members of the owning cooperative may remove goals
drop policy if exists "cooperative_goals_delete_own" on public.cooperative_goals;
create policy "cooperative_goals_delete_own"
  on public.cooperative_goals
  for delete
  using (
    exists (
      select 1
      from public.cooperative_members cm
      where cm.cooperative_id = cooperative_goals.cooperative_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.cooperatives c
      where c.id = cooperative_goals.cooperative_id
        and c.owner_id = auth.uid()
    )
  );