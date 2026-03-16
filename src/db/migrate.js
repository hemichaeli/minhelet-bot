/**
 * Minhelet Bot — DB Migration Runner
 * Runs on startup to ensure all required columns exist.
 * Safe to run multiple times (uses IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS).
 */

const pool = require('./pool');
const { logger } = require('../services/logger');

async function runMigrations() {
  const client = await pool.connect();
  try {
    logger.info('[Migration] Running DB migrations...');

    // ── campaign_schedule_config: ensure table exists FIRST ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_schedule_config (
        id                        SERIAL PRIMARY KEY,
        zoho_campaign_id          VARCHAR(50) UNIQUE NOT NULL,
        project_id                VARCHAR(50),
        meeting_type              VARCHAR(50) DEFAULT 'consultation',
        available_windows         JSONB DEFAULT '[]',
        slot_duration_minutes     INTEGER DEFAULT 45,
        buffer_minutes            INTEGER DEFAULT 15,
        reminder_delay_hours      INTEGER DEFAULT 24,
        bot_followup_delay_hours  INTEGER DEFAULT 48,
        pre_meeting_reminder_hours INTEGER DEFAULT 24,
        morning_reminder_hours    INTEGER DEFAULT 2,
        wa_initial_template       TEXT DEFAULT '',
        wa_language               VARCHAR(5) DEFAULT 'he',
        show_rep_name             BOOLEAN DEFAULT TRUE,
        booking_link_expires_hours INTEGER DEFAULT 48,
        default_start_time        VARCHAR(5) DEFAULT '09:00',
        default_end_time          VARCHAR(5) DEFAULT '18:00',
        developer_name            TEXT,
        inforu_username           TEXT,
        inforu_password           TEXT,
        updated_at                TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── bot_sessions: ensure table exists FIRST ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id                    SERIAL PRIMARY KEY,
        phone                 VARCHAR(20) NOT NULL,
        zoho_contact_id       VARCHAR(50),
        zoho_campaign_id      VARCHAR(50),
        language              VARCHAR(5) DEFAULT 'he',
        state                 VARCHAR(50) DEFAULT 'waiting',
        context               JSONB DEFAULT '{}',
        building_address      TEXT,
        apartment_number      TEXT,
        booking_token         VARCHAR(64),
        campaign_buildings    TEXT[],
        campaign_status       VARCHAR(50),
        campaign_end_date     DATE,
        developer_name        TEXT,
        inforu_business_line  TEXT,
        last_message_at       TIMESTAMP DEFAULT NOW(),
        created_at            TIMESTAMP DEFAULT NOW(),
        UNIQUE (phone, zoho_campaign_id)
      )
    `);

    // ── reminder_queue: ensure table exists ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS reminder_queue (
        id                SERIAL PRIMARY KEY,
        phone             VARCHAR(20) NOT NULL,
        zoho_contact_id   VARCHAR(50),
        zoho_campaign_id  VARCHAR(50),
        reminder_type     VARCHAR(50) NOT NULL,
        scheduled_at      TIMESTAMP NOT NULL,
        sent_at           TIMESTAMP,
        payload           JSONB DEFAULT '{}',
        created_at        TIMESTAMP DEFAULT NOW(),
        UNIQUE (phone, zoho_campaign_id, reminder_type)
      )
    `);

    // ── meeting_slots: ensure table exists ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS meeting_slots (
        id                        SERIAL PRIMARY KEY,
        campaign_id               VARCHAR(50) NOT NULL,
        slot_datetime             TIMESTAMP NOT NULL,
        status                    VARCHAR(20) DEFAULT 'open',
        booked_by_phone           VARCHAR(20),
        booked_by_contact_id      VARCHAR(50),
        building_address          TEXT,
        visit_professional_id     VARCHAR(50),
        google_event_id           TEXT,
        zoho_event_id             TEXT,
        created_at                TIMESTAMP DEFAULT NOW(),
        updated_at                TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── campaign_schedule_config: add developer branding + INFORU credentials (idempotent) ──
    await client.query(`
      ALTER TABLE campaign_schedule_config
        ADD COLUMN IF NOT EXISTS developer_name     TEXT,
        ADD COLUMN IF NOT EXISTS inforu_username    TEXT,
        ADD COLUMN IF NOT EXISTS inforu_password    TEXT
    `);

    // ── bot_sessions: add developer_name + inforu_business_line if missing (idempotent) ──
    await client.query(`
      ALTER TABLE bot_sessions
        ADD COLUMN IF NOT EXISTS developer_name        TEXT,
        ADD COLUMN IF NOT EXISTS inforu_business_line  TEXT
    `);

    // ── activities system (migration 002+003) ──
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_type') THEN
          CREATE TYPE activity_type AS ENUM ('signing', 'appraisal', 'measurement', 'other');
        END IF;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'professional_type') THEN
          CREATE TYPE professional_type AS ENUM ('appraiser', 'surveyor', 'lawyer', 'other');
        END IF;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
          CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'arrived', 'no-show', 'rescheduled');
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type activity_type NOT NULL,
        google_calendar_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active' NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS professionals (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type professional_type NOT NULL,
        phone_number VARCHAR(50),
        email VARCHAR(255),
        dashboard_token VARCHAR(64) UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_assignments (
        id SERIAL PRIMARY KEY,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
        building_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(activity_id, professional_id, building_id)
      )
    `);
    // appointments: add extra columns
    await client.query(`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS building_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS apartment_number VARCHAR(50),
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='appointments' AND column_name='status'
        ) THEN
          ALTER TABLE appointments ADD COLUMN status appointment_status DEFAULT 'pending';
        END IF;
      END $$
    `);
    // Generate dashboard tokens for existing professionals without one
    await client.query(`
      UPDATE professionals
      SET dashboard_token = encode(gen_random_bytes(20), 'hex')
      WHERE dashboard_token IS NULL
    `);

    logger.info('[Migration] All migrations completed successfully.');
  } catch (err) {
    logger.error('[Migration] Migration failed:', err.message);
    // Don't throw — allow server to start even if migration fails
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
