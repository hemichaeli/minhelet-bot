-- Up Migration: add dashboard_token to professionals, building_id to appointments
ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS dashboard_token VARCHAR(64) UNIQUE;

-- Add building_id to appointments if not already present
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS building_id VARCHAR(255);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS apartment_number VARCHAR(50);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Generate tokens for existing professionals
UPDATE professionals
SET dashboard_token = encode(gen_random_bytes(20), 'hex')
WHERE dashboard_token IS NULL;

-- Down Migration
ALTER TABLE professionals DROP COLUMN IF EXISTS dashboard_token;
ALTER TABLE appointments DROP COLUMN IF EXISTS building_id;
ALTER TABLE appointments DROP COLUMN IF EXISTS apartment_number;
ALTER TABLE appointments DROP COLUMN IF EXISTS notes;
ALTER TABLE appointments DROP COLUMN IF EXISTS updated_at;
