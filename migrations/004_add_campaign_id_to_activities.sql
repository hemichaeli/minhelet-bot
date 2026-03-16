-- Migration 004: Add campaign_id to activities table
-- This links each activity to a Zoho campaign (campaign = activity)

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS campaign_id TEXT;

CREATE INDEX IF NOT EXISTS idx_activities_campaign_id ON activities(campaign_id);

-- Also ensure activity_assignments allows __unassigned__ placeholder
-- (building_id is already TEXT so no change needed)
