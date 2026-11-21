-- Migration 010: Public read access for the certificate verifier (#134)
--
-- The public /api/verify endpoint allows anyone (no auth) to look up a
-- certificate by ID, reading_hash, or mint_tx_hash. Since we are switching
-- that endpoint from the service-role key to the anon key, we need explicit
-- RLS policies granting anonymous SELECT on the relevant tables.
--
-- Only SELECT is allowed; INSERT/UPDATE/DELETE remain operator-only.

create policy "public: read certificates for verify"
  on certificates for select
  to anon
  using (true);

create policy "public: read readings for verify"
  on readings for select
  to anon
  using (true);

-- The public /explore page (#782) lists all certificates with cooperative
-- names, so anonymous visitors also need SELECT on cooperatives. This policy
-- covers the explorer's join against cooperatives (id, name). Writes remain
-- operator-only.
create policy "public: read cooperatives for explore"
  on cooperatives for select
  to anon
  using (true);

-- Public cooperative profile view (#792)
--
-- The public /cooperatives/[id] page shows transparency information about a
-- cooperative (name, location, production totals, active meters, certificates
-- issued). To let the anon key read this without exposing PII (admin_address,
-- operator email, etc.), we expose a security-definer view that selects only
-- the safe columns and aggregates the relevant metrics.
--
-- The view runs with the privileges of its owner (security definer semantics
-- for views via security_invoker = false), so it can read the underlying
-- tables even though anon has no direct SELECT grant on cooperatives.

create or replace view public_cooperative_profiles
  with (security_invoker = false)
as
select
  c.id,
  c.name,
  c.location,
  coalesce(r.total_kwh, 0)::numeric as total_kwh,
  coalesce(m.active_meters, 0)::bigint as active_meters,
  coalesce(cert.certificates_issued, 0)::bigint as certificates_issued
from cooperatives c
left join (
  select
    meter_id,
    sum(kwh) as total_kwh
  from readings
  group by meter_id
) r on r.meter_id = c.id
left join (
  select
    cooperative_id,
    count(*) filter (where active) as active_meters
  from meters
  group by cooperative_id
) m on m.cooperative_id = c.id
left join (
  select
    cooperative_id,
    count(*) as certificates_issued
  from certificates
  group by cooperative_id
) cert on cert.cooperative_id = c.id;

-- Grant anonymous read access to the public profile view only.
grant select on public_cooperative_profiles to anon;
grant select on public_cooperative_profiles to authenticated;
