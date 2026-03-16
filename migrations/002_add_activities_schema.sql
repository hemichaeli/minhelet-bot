-- Up Migration

CREATE TYPE activity_type AS ENUM ('signing', 'appraisal', 'measurement', 'other');
CREATE TYPE professional_type AS ENUM ('appraiser', 'surveyor', 'lawyer', 'other');
CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'arrived', 'no-show', 'rescheduled');

CREATE TABLE activities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type activity_type NOT NULL,
    google_calendar_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE professionals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type professional_type NOT NULL,
    phone_number VARCHAR(50),
    email VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE activity_assignments (
    id SERIAL PRIMARY KEY,
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
    building_id VARCHAR(255) NOT NULL, -- Assuming building_id is a string from Zoho
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(activity_id, professional_id, building_id)
);

ALTER TABLE appointments
ADD COLUMN status appointment_status DEFAULT 'pending';

-- Down Migration

ALTER TABLE appointments
DROP COLUMN status;

DROP TABLE activity_assignments;
DROP TABLE professionals;
DROP TABLE activities;

DROP TYPE appointment_status;
DROP TYPE professional_type;
DROP TYPE activity_type;
