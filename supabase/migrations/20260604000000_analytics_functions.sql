-- Migration: Analytics functions for energy cooperatives
-- Closes #350

-- 1. Trend data (kWh, issued, retired) over time
create or replace function get_cooperative_trends(
  target_cooperative_id uuid,
  start_date timestamptz,
  end_date timestamptz,
  granularity text default 'day'
)
returns table (
  bucket timestamptz,
  kwh numeric,
  certs_issued bigint,
  certs_retired bigint
)
language plpgsql
security definer
as $$
begin
  return query
  with time_buckets as (
    -- Ensure we have a row for every bucket in the range (optional but good for charts)
    -- Actually, simpler to just group what we have
    select date_trunc(granularity, r.timestamp) as bucket, sum(r.kwh) as kwh
    from readings r
    join meters m on m.id = r.meter_id
    where m.cooperative_id = target_cooperative_id
      and r.timestamp >= start_date
      and r.timestamp <= end_date
      and r.anchored = true
    group by 1
  ),
  issued_buckets as (
    select date_trunc(granularity, c.issued_at) as bucket, count(*) as count
    from certificates c
    where c.cooperative_id = target_cooperative_id
      and c.issued_at >= start_date
      and c.issued_at <= end_date
    group by 1
  ),
  retired_buckets as (
    select date_trunc(granularity, c.retired_at) as bucket, count(*) as count
    from certificates c
    where c.cooperative_id = target_cooperative_id
      and c.retired_at >= start_date
      and c.retired_at <= end_date
      and c.retired = true
    group by 1
  )
  select
    coalesce(t.bucket, i.bucket, r.bucket) as bucket,
    coalesce(t.kwh, 0) as kwh,
    coalesce(i.count, 0) as certs_issued,
    coalesce(r.count, 0) as certs_retired
  from time_buckets t
  full outer join issued_buckets i on t.bucket = i.bucket
  full outer join retired_buckets r on coalesce(t.bucket, i.bucket) = r.bucket
  order by 1;
end;
$$;

-- 2. Per-meter breakdown within date range
create or replace function get_cooperative_meter_stats(
  target_cooperative_id uuid,
  start_date timestamptz,
  end_date timestamptz
)
returns table (
  meter_id uuid,
  meter_name text,
  total_kwh numeric,
  reading_count bigint,
  certs_generated bigint
)
language plpgsql
security definer
as $$
begin
  return query
  select
    m.id as meter_id,
    m.name as meter_name,
    coalesce(sum(r.kwh), 0) as total_kwh,
    count(r.id) as reading_count,
    count(c.id) as certs_generated
  from meters m
  left join readings r on r.meter_id = m.id
    and r.timestamp >= start_date
    and r.timestamp <= end_date
    and r.anchored = true
  left join certificates c on c.reading_id = r.id
  where m.cooperative_id = target_cooperative_id
  group by m.id, m.name
  order by total_kwh desc;
end;
$$;

-- 3. Per-meter kWh series for stacked bar chart (kWh per meter per period)
create or replace function get_cooperative_meter_kwh_series(
  target_cooperative_id uuid,
  start_date timestamptz,
  end_date timestamptz,
  granularity text default 'day'
)
returns table (
  bucket timestamptz,
  meter_id uuid,
  meter_name text,
  kwh numeric
)
language plpgsql
security definer
as $$
begin
  return query
  select
    date_trunc(granularity, r.timestamp) as bucket,
    m.id as meter_id,
    m.name as meter_name,
    coalesce(sum(r.kwh), 0) as kwh
  from readings r
  join meters m on m.id = r.meter_id
  where m.cooperative_id = target_cooperative_id
    and r.timestamp >= start_date
    and r.timestamp <= end_date
    and r.anchored = true
  group by 1, m.id, m.name
  order by 1, m.name;
end;
$$;
