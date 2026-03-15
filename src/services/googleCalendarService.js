/**
 * QUANTUM Google Calendar Service
 *
 * Creates, updates, and deletes Google Calendar events
 * when bookings are confirmed / cancelled.
 *
 * Each project has its own Google Calendar (stored in projects.google_calendar_id).
 * Each station in a ceremony can also have its own calendar (ceremony_stations.google_calendar_id).
 *
 * Auth: Service Account JSON in GOOGLE_SERVICE_ACCOUNT_JSON env var
 *       or individual fields GOOGLE_CLIENT_EMAIL / GOOGLE_SA_EMAIL + GOOGLE_PRIVATE_KEY / GOOGLE_SA_PRIVATE_KEY
 *
 * Scopes required: https://www.googleapis.com/auth/calendar
 */

const { logger } = require('./logger');

// Lazy-load googleapis to avoid startup crash if not configured
let google = null;
let calendar = null;
let jwtClient = null;

function getClient() {
  if (jwtClient) return jwtClient;

  try {
    if (!google) {
      google = require('googleapis').google;
    }

    const {
      GOOGLE_SERVICE_ACCOUNT_JSON,
      GOOGLE_CLIENT_EMAIL, GOOGLE_SA_EMAIL,
      GOOGLE_PRIVATE_KEY, GOOGLE_SA_PRIVATE_KEY
    } = process.env;

    const clientEmail = GOOGLE_CLIENT_EMAIL || GOOGLE_SA_EMAIL;
    const privateKey  = GOOGLE_PRIVATE_KEY  || GOOGLE_SA_PRIVATE_KEY;

    let credentials;
    if (GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (clientEmail && privateKey) {
      credentials = {
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, '\n')
      };
    } else {
      logger.warn('[GCal] No credentials configured. Set GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY on Railway');
      return null;
    }

    jwtClient = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );

    calendar = google.calendar({ version: 'v3', auth: jwtClient });
    logger.info(`[GCal] Client initialized for ${credentials.client_email}`);
    return jwtClient;
  } catch (err) {
    logger.warn('[GCal] Failed to initialize client:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// CALENDAR MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * Create a new Google Calendar.
 * The service account owns the calendar — must then share it with real users.
 *
 * @param {string} name       - Calendar display name
 * @param {string} [timezone] - Default 'Asia/Jerusalem'
 * @returns {string|null}     - New calendar ID (ends with @group.calendar.google.com)
 */
async function createCalendar(name, timezone = 'Asia/Jerusalem') {
  if (!getClient()) return null;
  try {
    const res = await calendar.calendars.insert({
      resource: { summary: name, timeZone: timezone }
    });
    logger.info(`[GCal] Calendar created: "${name}" → ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    logger.warn(`[GCal] createCalendar failed for "${name}":`, err.message);
    return null;
  }
}

/**
 * Share a Google Calendar with a user (reader or writer).
 *
 * @param {string} calendarId - Google Calendar ID
 * @param {string} email      - Email to share with
 * @param {string} [role]     - 'reader' | 'writer' | 'owner' (default: 'reader')
 * @returns {boolean}
 */
async function shareCalendar(calendarId, email, role = 'reader') {
  if (!getClient()) return false;
  try {
    await calendar.acl.insert({
      calendarId,
      resource: { role, scope: { type: 'user', value: email } }
    });
    logger.info(`[GCal] Calendar ${calendarId} shared with ${email} as ${role}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] shareCalendar failed for ${email}:`, err.message);
    return false;
  }
}

/**
 * Delete a Google Calendar entirely.
 *
 * @param {string} calendarId
 * @returns {boolean}
 */
async function deleteCalendar(calendarId) {
  if (!getClient() || !calendarId) return false;
  try {
    await calendar.calendars.delete({ calendarId });
    logger.info(`[GCal] Calendar deleted: ${calendarId}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] deleteCalendar failed for ${calendarId}:`, err.message);
    return false;
  }
}

/**
 * List all events in a calendar for a given day and delete them.
 * Used to "clear" a building calendar after a ceremony.
 *
 * @param {string} calendarId
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {number} count of deleted events
 */
async function clearCalendarDay(calendarId, date) {
  if (!getClient() || !calendarId) return 0;
  try {
    const timeMin = new Date(`${date}T00:00:00+03:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59+03:00`).toISOString();

    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 500
    });

    const events = res.data.items || [];
    let deleted = 0;
    for (const ev of events) {
      try {
        await calendar.events.delete({ calendarId, eventId: ev.id });
        deleted++;
      } catch (e) { /* skip */ }
    }
    logger.info(`[GCal] Cleared ${deleted} events from ${calendarId} on ${date}`);
    return deleted;
  } catch (err) {
    logger.warn(`[GCal] clearCalendarDay failed:`, err.message);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * Create a calendar event.
 *
 * @param {string} calendarId
 * @param {object} opts
 *   - title, startDatetime, durationMins, description, location, attendeeEmail
 * @returns {string|null} Google event ID
 */
async function createEvent(calendarId, { title, startDatetime, durationMins = 45, description = '', location = '', attendeeEmail = null }) {
  if (!getClient()) return null;
  if (!calendarId) return null;

  try {
    const start = new Date(startDatetime);
    const end = new Date(start.getTime() + durationMins * 60000);

    const event = {
      summary: title,
      description,
      location,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Jerusalem' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 1440 }
        ]
      }
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const res = await calendar.events.insert({
      calendarId,
      resource: event,
      sendUpdates: attendeeEmail ? 'all' : 'none'
    });

    logger.info(`[GCal] Event created: ${res.data.id} in calendar ${calendarId}`);
    return res.data.id;
  } catch (err) {
    logger.warn(`[GCal] createEvent failed for calendar ${calendarId}:`, err.message);
    return null;
  }
}

/**
 * Delete a calendar event.
 */
async function deleteEvent(calendarId, eventId) {
  if (!getClient() || !calendarId || !eventId) return false;
  try {
    await calendar.events.delete({ calendarId, eventId });
    logger.info(`[GCal] Event deleted: ${eventId} from calendar ${calendarId}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] deleteEvent failed:`, err.message);
    return false;
  }
}

/**
 * Update an existing calendar event.
 */
async function updateEvent(calendarId, eventId, updates) {
  if (!getClient() || !calendarId || !eventId) return false;
  try {
    const res = await calendar.events.patch({ calendarId, eventId, resource: updates });
    logger.info(`[GCal] Event updated: ${res.data.id}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] updateEvent failed:`, err.message);
    return false;
  }
}

/**
 * Test calendar connectivity.
 */
async function testCalendarAccess(calendarId) {
  if (!getClient()) return { ok: false, error: 'No credentials' };
  try {
    const res = await calendar.events.list({
      calendarId,
      maxResults: 1,
      timeMin: new Date().toISOString()
    });
    return { ok: true, calendarId, eventCount: res.data.items?.length || 0 };
  } catch (err) {
    return { ok: false, calendarId, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// CEREMONY & MEETING SLOT EVENTS
// ─────────────────────────────────────────────────────────────

/**
 * Create a booking event for a ceremony slot.
 * Uses station calendar → project calendar fallback.
 */
async function createCeremonySlotEvent(pool, slot, contactName, contactPhone) {
  if (!getClient()) return null;

  try {
    const res = await pool.query(
      `SELECT
         cst.google_calendar_id AS station_gcal,
         sc.location,
         sc.slot_duration_minutes AS duration,
         p.google_calendar_id AS project_gcal,
         p.name AS project_name,
         sc.ceremony_date,
         cst.station_number,
         cst.representative_name
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id = cst.id
       JOIN signing_ceremonies sc ON cs.ceremony_id = sc.id
       JOIN projects p ON sc.project_id = p.id
       WHERE cs.id = $1`,
      [slot.id]
    );

    if (!res.rows.length) return null;
    const row = res.rows[0];

    const calendarId = row.station_gcal || row.project_gcal;
    if (!calendarId) {
      logger.warn(`[GCal] No calendar configured for slot ${slot.id}`);
      return null;
    }

    const timeStr = (slot.slot_time || '').substring(0, 5);
    const startDatetime = `${slot.slot_date}T${timeStr}:00`;

    const eventId = await createEvent(calendarId, {
      title: `✍️ כנס חתימות - ${contactName} | ${row.project_name}`,
      startDatetime,
      durationMins: row.duration || 15,
      description: [
        `דייר: ${contactName}`,
        `טלפון: ${contactPhone}`,
        `פרויקט: ${row.project_name}`,
        `עמדה: ${row.station_number}`,
        row.representative_name ? `נציג: ${row.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: row.location || ''
    });

    return eventId;
  } catch (err) {
    logger.warn(`[GCal] createCeremonySlotEvent failed:`, err.message);
    return null;
  }
}

/**
 * Create a booking event for a regular meeting slot.
 */
async function createMeetingSlotEvent(pool, slot, contactName, contactPhone) {
  if (!getClient()) return null;

  try {
    const res = await pool.query(
      `SELECT p.google_calendar_id, p.name AS project_name
       FROM meeting_slots ms
       LEFT JOIN projects p ON ms.project_id = p.id
       WHERE ms.id = $1`,
      [slot.id]
    );

    const row = res.rows[0];
    const calendarId = row?.google_calendar_id;
    if (!calendarId) {
      logger.warn(`[GCal] No project calendar for meeting slot ${slot.id}`);
      return null;
    }

    const MEETING_TYPE_LABELS = {
      consultation: 'פגישת ייעוץ',
      physical: 'פגישה פיזית',
      appraiser: 'ביקור שמאי',
      surveyor: 'ביקור מודד',
      signing_ceremony: 'כנס חתימות'
    };
    const typeLabel = MEETING_TYPE_LABELS[slot.meeting_type] || 'פגישה';

    const eventId = await createEvent(calendarId, {
      title: `📅 ${typeLabel} - ${contactName} | QUANTUM`,
      startDatetime: slot.slot_datetime,
      durationMins: slot.duration_minutes || 45,
      description: [
        `לקוח: ${contactName}`,
        `טלפון: ${contactPhone}`,
        slot.representative_name ? `נציג: ${slot.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: ''
    });

    return eventId;
  } catch (err) {
    logger.warn(`[GCal] createMeetingSlotEvent failed:`, err.message);
    return null;
  }
}

/**
 * Check if calendar service is configured.
 */
function isConfigured() {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_CLIENT_EMAIL ||
    process.env.GOOGLE_SA_EMAIL
  );
}

module.exports = {
  createEvent,
  deleteEvent,
  updateEvent,
  createCalendar,
  shareCalendar,
  deleteCalendar,
  clearCalendarDay,
  createCeremonySlotEvent,
  createMeetingSlotEvent,
  testCalendarAccess,
  isConfigured
};
