-- Migration: Add certificate expiry / validity period
-- Issue: #784 [Product] Add certificate expiry / validity period to the data model and UI
--
-- Adds an optional, nullable `expires_at` column to the certificates table.
-- Expiry is optional and jurisdiction-dependent: some jurisdictions require
-- energy certificates to expire after a fixed period (e.g. 1 year), while
-- others do not impose any expiry. A NULL value means the certificate does
-- not expire.
--
-- Also adds an index on `expires_at` to support expiry filtering (e.g.
-- listing expired or soon-to-expire certificates).

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

COMMENT ON COLUMN certificates.expires_at IS
  'Optional certificate expiry timestamp. NULL means the certificate does not expire. Expiry is jurisdiction-dependent (e.g. some jurisdictions require certificates to expire after a fixed period such as 1 year).';

CREATE INDEX IF NOT EXISTS idx_certificates_expires_at
  ON certificates (expires_at);