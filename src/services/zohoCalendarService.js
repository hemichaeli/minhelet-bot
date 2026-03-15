/**
 * QUANTUM Zoho Calendar Service
 *
 * Creates and deletes Zoho Calendar events when bookings are confirmed / cancelled.
 * Uses the same ZOHO_REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET as CRM.
 *
 * Zoho Calendar API: https://www.zoho.com/calendar/help/api/
 * Scopes needed: ZohoCalendar.calendar.ALL, ZohoCalendar.event.ALL
 *
 * Env vars (already set for CRM):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *
 * Projects DB table: projects
 *   - zoho_calendar_id  VARCHAR  (Zoho Calendar UID)
 */

const axios = require('axios');
const pool  = require('../db/pool');
const { logger } = require('./logger');

const TOKEN_URL     = 'https://accounts.zoho.com/oauth/v2/token';
const CALENDAR_BASE = 'https://calendar.zoho.com/api/v1';

// ── Token cache ───────────────────────────────────────────────
let _accessToken = null;
let _tokenExpiry  = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 60000) return _accessToken;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    logger.warn('[ZohoCal] Missing OAuth credentials');
    return null;
  }

  try {
    const resp = await axios.post(TOKEN_URL, null, {
      params: {
        refresh_token: ZOHO_REFRESH_TOKEN,
        client_id:     ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        grant_type:    'refresh_token'
      },
      timeout: 10000
    });

    if (!resp.data.access_token) {
      logger.warn('[ZohoCal] Token refresh failed:', resp.data);
      return null;
    }

    _accessToken = resp.data.access_token;
    _tokenExpiry  = Date.now() + (resp.data.expires_in || 3600) * 1000;
    logger.info('[ZohoCal] Access token refreshed');
    return _accessToken;
  } catch (err) {
    logger.warn('[ZohoCal] Token refresh error:', err.message);
    return null;
  }
}

// ── Core: Create event ────────────────────────────────────────
/**
 * @param {string} calendarId   Zoho Calendar UID
 * @param {object} opts
 *   - title         {string}
 *   - startDatetime {string}  ISO "2026-04-15T10:00:00"
 *   - durationMins  {number}  default 45
 *   - description   {string}
 *   - location      {string}
 * @returns {string|null} Zoho event UID
 */
async function createEvent(calendarId, { title, startDatetime, durationMins = 45, description = '', location = '' }) {
  const token = await getAccessToken();
  if (!token || !calendarId) return null;

  try {
    const start = new Date(startDatetime);
    const end   = new Date(start.getTime() + durationMins * 60000);

    // Zoho format: yyyyMMddTHHmmssZ
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const eventData = {
      title,
      dateandtime: {
        start:    fmt(start),
        end:      fmt(end),
        timezone: 'Asia/Jerusalem'
      },
      description,
      location
    };

    // Zoho Calendar API requires form-encoded body with eventdata as JSON string
    const params = new URLSearchParams();
    params.append('eventdata', JSON.stringify(eventData));

    const resp = await axios.post(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      params.toString(),
      {
        headers: {
          Authorization:  `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const uid = resp.data?.events?.[0]?.uid;
    if (uid) {
      logger.info(`[ZohoCal] Event created: ${uid} in calendar ${calendarId}`);
      return uid;
    }
    logger.warn('[ZohoCal] createEvent: no UID in response', resp.data);
    return null;
  } catch (err) {
    logger.warn(`[ZohoCal] createEvent failed:`, err.message, err.response?.data);
    return null;
  }
}

// ── Core: Delete event ────────────────────────────────────────
async function deleteEvent(calendarId, eventUid) {
  const token = await getAccessToken();
  if (!token || !calendarId || !eventUid) return false;

  try {
    await axios.delete(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventUid)}`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000
      }
    );
    logger.info(`[ZohoCal] Event deleted: ${eventUid}`);
    return true;
  } catch (err) {
    logger.warn(`[ZohoCal] deleteEvent failed:`, err.message);
    return false;
  }
}

// ── Meeting slot event ────────────────────────────────────────
async function createMeetingSlotEvent(pool, slot, contactName, contactPhone) {
  try {
    const res = await pool.query(
      `SELECT p.zoho_calendar_id, p.name AS project_name
       FROM meeting_slots ms
       LEFT JOIN projects p ON ms.project_id = p.id
       WHERE ms.id = $1`,
      [slot.id]
    );

    const row = res.rows[0];
    if (!row?.zoho_calendar_id) {
      logger.info(`[ZohoCal] No zoho_calendar_id for meeting slot ${slot.id}`);
      return null;
    }

    const MEETING_TYPE_LABELS = {
      consultation:     'פגישת ייעוץ',
      physical:         'פגישה פיזית',
      appraiser:        'ביקור שמאי',
      surveyor:         'ביקור מודד',
      signing_ceremony: 'כנס חתימות'
    };
    const typeLabel = MEETING_TYPE_LABELS[slot.meeting_type] || 'פגישה';

    return await createEvent(row.zoho_calendar_id, {
      title:         `📅 ${typeLabel} - ${contactName} | QUANTUM`,
      startDatetime: slot.slot_datetime,
      durationMins:  slot.duration_minutes || 45,
      description:   [
        `לקוח: ${contactName}`,
        `טלפון: ${contactPhone}`,
        slot.representative_name ? `נציג: ${slot.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: ''
    });
  } catch (err) {
    logger.warn('[ZohoCal] createMeetingSlotEvent failed:', err.message);
    return null;
  }
}

// ── Ceremony slot event ───────────────────────────────────────
async function createCeremonySlotEvent(pool, slot, contactName, contactPhone) {
  try {
    const res = await pool.query(
      `SELECT
         cst.google_calendar_id AS station_gcal,
         sc.location,
         sc.slot_duration_minutes AS duration,
         p.zoho_calendar_id,
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

    if (!row.zoho_calendar_id) {
      logger.info(`[ZohoCal] No zoho_calendar_id for ceremony slot ${slot.id}`);
      return null;
    }

    const timeStr       = (slot.slot_time || '').substring(0, 5);
    const startDatetime = `${slot.slot_date}T${timeStr}:00`;

    return await createEvent(row.zoho_calendar_id, {
      title:        `✍️ כנס חתימות - ${contactName} | ${row.project_name}`,
      startDatetime,
      durationMins: row.duration || 15,
      description:  [
        `דייר: ${contactName}`,
        `טלפון: ${contactPhone}`,
        `פרויקט: ${row.project_name}`,
        `עמדה: ${row.station_number}`,
        row.representative_name ? `נציג: ${row.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: row.location || ''
    });
  } catch (err) {
    logger.warn('[ZohoCal] createCeremonySlotEvent failed:', err.message);
    return null;
  }
}

// ── Test connectivity ─────────────────────────────────────────
// Fetches events without any extra query params (Zoho rejects unknown params)
async function testCalendarAccess(calendarId) {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'No access token' };

  try {
    const resp = await axios.get(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 10000
      }
    );
    return { ok: true, calendarId, eventCount: resp.data?.events?.length || 0 };
  } catch (err) {
    return { ok: false, calendarId, error: err.response?.data || err.message };
  }
}

// ── List available Zoho Calendars ─────────────────────────────
async function listCalendars() {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'No access token' };

  try {
    const resp = await axios.get(`${CALENDAR_BASE}/calendars`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: 10000
    });
    return { ok: true, calendars: resp.data?.calendars || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isConfigured() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN);
}

module.exports = {
  createEvent,
  deleteEvent,
  createMeetingSlotEvent,
  createCeremonySlotEvent,
  testCalendarAccess,
  listCalendars,
  isConfigured
};
