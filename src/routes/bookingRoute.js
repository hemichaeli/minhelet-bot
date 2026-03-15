/**
 * QUANTUM Visual Booking Route v6.7
 *
 * v6.2: Fix clicks not working — data-slot-id + JSON slot map
 * v6.3: Responsive desktop layout — two columns, bigger slots, sidebar confirm panel
 * v6.4: Remove AT TIME ZONE (wrong direction)
 * v6.5: Tried AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem' — wrong (added 2h instead)
 * v6.6: CORRECT FIX — slot_datetime (TIMESTAMP WITHOUT TZ) stores Israel wall-clock time.
 *       Just use TO_CHAR with no timezone conversion at all.
 *       09:40 stored = 09:40 displayed. No conversion needed.
 * v6.7: Short calendar links - /cal/g /cal/o /cal/i for Google, Outlook, iOS
 *
 * GET  /booking/:token          - Visual calendar HTML
 * GET  /booking/:token/slots    - JSON slot data
 * POST /booking/:token/confirm  - Confirm booking + create Google + Zoho Calendar events
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const inforuService = require('../services/inforuService');
const { logger } = require('../services/logger');
const crypto = require('crypto');

let gcal;
try { gcal = require('../services/googleCalendarService'); } catch (e) {}
let zcal;
try { zcal = require('../services/zohoCalendarService'); } catch (e) {}

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://pinuy-binuy-analyzer-production.up.railway.app';

const DAY_NAMES_HE = ['\u05e8\u05d0\u05e9\u05d5\u05df','\u05e9\u05e0\u05d9','\u05e9\u05dc\u05d9\u05e9\u05d9','\u05e8\u05d1\u05d9\u05e2\u05d9','\u05d7\u05de\u05d9\u05e9\u05d9','\u05e9\u05d9\u05e9\u05d9','\u05e9\u05d1\u05ea'];
const DAY_NAMES_RU = ['\u0412\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435','\u041f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a','\u0412\u0442\u043e\u0440\u043d\u0438\u043a','\u0421\u0440\u0435\u0434\u0430','\u0427\u0435\u0442\u0432\u0435\u0440\u0433','\u041f\u044f\u0442\u043d\u0438\u0446\u0430','\u0421\u0443\u0431\u0431\u043e\u0442\u0430'];

function generateToken() { return crypto.randomBytes(16).toString('hex'); }

async function ensureBookingToken(phone, campaignId) {
  const res = await pool.query(
    `SELECT booking_token FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id IS NOT DISTINCT FROM $2`,
    [phone, campaignId]
  );
  if (res.rows[0]?.booking_token) return res.rows[0].booking_token;
  const token = generateToken();
  await pool.query(
    `UPDATE bot_sessions SET booking_token=$1 WHERE phone=$2 AND zoho_campaign_id IS NOT DISTINCT FROM $3`,
    [token, phone, campaignId]
  );
  return token;
}
module.exports.ensureBookingToken = ensureBookingToken;
module.exports.BASE_URL = BASE_URL;

// ══════════════════════════════════════════════════════════════
// SMART SLOT CLUSTERING
// ══════════════════════════════════════════════════════════════

async function scoreSlotsByProximity(slots, campaignId, contactStreet) {
  if (!slots.length) return slots;
  const confirmedRes = await pool.query(
    `SELECT slot_datetime, contact_street FROM meeting_slots
     WHERE campaign_id=$1 AND status IN ('confirmed','reserved') AND slot_datetime > NOW() - INTERVAL '1 hour'
     ORDER BY slot_datetime`,
    [campaignId]
  );
  const confirmed = confirmedRes.rows;
  const WINDOW_SAME_STREET = 90 * 60 * 1000;
  const WINDOW_ANY = 60 * 60 * 1000;
  const ISOLATION_GAP = 90 * 60 * 1000;
  for (const slot of slots) {
    let score = 0;
    const slotMs = new Date(slot.slot_datetime).getTime();
    for (const c of confirmed) {
      const cMs = new Date(c.slot_datetime).getTime();
      const diff = Math.abs(slotMs - cMs);
      if (diff <= WINDOW_SAME_STREET && contactStreet && c.contact_street === contactStreet) score += 5;
      else if (diff <= WINDOW_ANY) score += 1;
    }
    const before = confirmed.filter(c => new Date(c.slot_datetime).getTime() < slotMs);
    const after  = confirmed.filter(c => new Date(c.slot_datetime).getTime() > slotMs);
    const nearestBefore = before.length ? slotMs - new Date(before[before.length - 1].slot_datetime).getTime() : Infinity;
    const nearestAfter  = after.length  ? new Date(after[0].slot_datetime).getTime() - slotMs : Infinity;
    if (nearestBefore > ISOLATION_GAP && nearestAfter > ISOLATION_GAP) score -= 3;
    slot.cluster_score = score;
  }
  slots.sort((a, b) => {
    if (b.cluster_score !== a.cluster_score) return b.cluster_score - a.cluster_score;
    return new Date(a.slot_datetime) - new Date(b.slot_datetime);
  });
  if (slots.length > 0) slots[0].is_recommended = true;
  return slots;
}

// ══════════════════════════════════════════════════════════════
// SLOT FETCHERS
// ══════════════════════════════════════════════════════════════

async function getMeetingSlots(campaignId, contactStreet) {
  const res = await pool.query(
    `SELECT id, slot_datetime,
            TO_CHAR(slot_datetime,'YYYY-MM-DD') AS slot_date,
            TO_CHAR(slot_datetime,'HH24:MI') AS time_str,
            EXTRACT(DOW FROM slot_datetime)::int AS dow,
            representative_name
     FROM meeting_slots
     WHERE campaign_id=$1 AND status='open' AND slot_datetime > NOW()
     ORDER BY slot_datetime LIMIT 60`,
    [campaignId]
  );
  if (!res.rows.length) return [];
  let slots = res.rows.map(s => ({ ...s, booking_type: 'meeting', capacity: 1, open_count: 1, cluster_score: 0, is_recommended: false }));
  slots = await scoreSlotsByProximity(slots, campaignId, contactStreet || null);
  return slots;
}

async function getCeremonySlots(ceremonyId, buildingId) {
  let query, params;
  if (buildingId) {
    query = `
      SELECT cs.slot_time AS time_str, cs.slot_date,
        COUNT(*) FILTER (WHERE cs.status = 'open') AS open_count,
        COUNT(*) AS total_count,
        EXTRACT(DOW FROM cs.slot_date)::int AS dow,
        cb.building_label, cst.building_id
      FROM ceremony_slots cs
      JOIN ceremony_stations cst ON cs.station_id = cst.id
      JOIN ceremony_buildings cb ON cst.building_id = cb.id
      WHERE cs.ceremony_id=$1 AND cst.building_id=$2 AND cst.is_active=true AND cs.status='open'
      GROUP BY cs.slot_time, cs.slot_date, cb.building_label, cst.building_id
      HAVING COUNT(*) FILTER (WHERE cs.status = 'open') > 0
      ORDER BY cs.slot_time`;
    params = [ceremonyId, buildingId];
  } else {
    query = `
      SELECT cs.slot_time AS time_str, cs.slot_date,
        COUNT(*) FILTER (WHERE cs.status = 'open') AS open_count,
        COUNT(*) AS total_count,
        EXTRACT(DOW FROM cs.slot_date)::int AS dow,
        null AS building_label, null AS building_id
      FROM ceremony_slots cs
      JOIN ceremony_stations cst ON cs.station_id = cst.id
      WHERE cs.ceremony_id=$1 AND cst.is_active=true AND cs.status='open'
      GROUP BY cs.slot_time, cs.slot_date
      HAVING COUNT(*) FILTER (WHERE cs.status = 'open') > 0
      ORDER BY cs.slot_time`;
    params = [ceremonyId];
  }
  const res = await pool.query(query, params);
  const bId = buildingId || 0;
  return res.rows.map(row => ({
    id: `ceremony:${ceremonyId}:${bId}:${row.time_str.substring(0,5)}`,
    booking_type: 'ceremony',
    ceremony_id: ceremonyId,
    building_id: buildingId || null,
    building_label: row.building_label,
    slot_date: row.slot_date,
    time_str: row.time_str.substring(0, 5),
    dow: parseInt(row.dow),
    open_count: parseInt(row.open_count),
    total_count: parseInt(row.total_count),
    capacity: parseInt(row.total_count),
    cluster_score: 0,
    is_recommended: false,
    representative_name: null
  }));
}

function groupByDate(slots, lang = 'he') {
  const groups = {};
  const dayNames = lang === 'ru' ? DAY_NAMES_RU : DAY_NAMES_HE;
  for (const slot of slots) {
    const key = slot.slot_date;
    if (!groups[key]) {
      const d = new Date(`${slot.slot_date}T${slot.time_str}`);
      const dayNum = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      groups[key] = { date: key, label: dayNames[slot.dow] || '', dayNum, slots: [] };
    }
    groups[key].slots.push(slot);
  }
  const sorted = Object.values(groups).sort((a, b) => a.date.localeCompare(b.date));
  for (const g of sorted) g.slots.sort((a, b) => a.time_str.localeCompare(b.time_str));
  return sorted;
}

// ══════════════════════════════════════════════════════════════
// GET /booking/:token
// ══════════════════════════════════════════════════════════════
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const sessionRes = await pool.query(
      `SELECT bs.*, csc.meeting_type, csc.show_rep_name, csc.booking_link_expires_hours
       FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [token]
    );
    if (!sessionRes.rows.length) {
      return res.status(404).type('html').send(errorPage('\u05d4\u05e7\u05d9\u05e9\u05d5\u05e8 \u05dc\u05d0 \u05e0\u05de\u05e6\u05d0', 'The link is invalid or expired.'));
    }
    const session = sessionRes.rows[0];
    const lang = session.language || 'he';
    if (session.booking_completed_at || session.state === 'confirmed') {
      const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
      return res.type('html').send(alreadyBookedPage(lang, ctx.confirmedSlot || {}));
    }
    const expiresHours = session.booking_link_expires_hours || 48;
    if (Date.now() - new Date(session.created_at).getTime() > expiresHours * 3600000) {
      return res.type('html').send(errorPage('\u05d4\u05e7\u05d9\u05e9\u05d5\u05e8 \u05e4\u05d2 \u05ea\u05d5\u05e7\u05e3', 'This booking link has expired. Please contact QUANTUM.'));
    }
    const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
    const isCeremony = session.meeting_type === 'signing_ceremony';
    const config = { show_rep_name: session.show_rep_name !== false };
    let slots = [], buildingLabel = null;
    if (isCeremony) {
      const ceremonyId = ctx.ceremony?.id;
      const buildingId = session.ceremony_building_id || null;
      if (ceremonyId) {
        slots = await getCeremonySlots(ceremonyId, buildingId);
        buildingLabel = slots[0]?.building_label || null;
      }
    } else {
      slots = await getMeetingSlots(session.zoho_campaign_id, session.contact_street || null);
    }
    let smartPicks = null;
    if (!isCeremony && slots.length >= 2) {
      const recommended = slots.find(s => s.is_recommended) || slots[0];
      const earliest = [...slots].sort((a, b) => new Date(a.slot_datetime).getTime() - new Date(b.slot_datetime).getTime())[0];
      const latest   = [...slots].sort((a, b) => new Date(b.slot_datetime).getTime() - new Date(a.slot_datetime).getTime())[0];
      const seen = new Set();
      smartPicks = [recommended, earliest, latest].filter(s => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    }
    const grouped = groupByDate(slots, lang);
    res.type('html').send(calendarPage(token, ctx.contactName || '', lang, config, grouped, isCeremony, buildingLabel, smartPicks, slots));
  } catch (err) {
    logger.error('[BookingRoute] GET error:', err);
    res.status(500).type('html').send(errorPage('\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d8\u05db\u05e0\u05d9\u05ea', 'Technical error. Please try again.'));
  }
});

// ══════════════════════════════════════════════════════════════
// GET /booking/:token/slots (JSON)
// ══════════════════════════════════════════════════════════════
router.get('/:token/slots', async (req, res) => {
  try {
    const sessionRes = await pool.query(
      `SELECT bs.zoho_campaign_id, bs.language, bs.context, bs.ceremony_building_id, bs.contact_street, csc.meeting_type
       FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [req.params.token]
    );
    if (!sessionRes.rows.length) return res.status(404).json({ error: 'Invalid token' });
    const { zoho_campaign_id, language, context, ceremony_building_id, contact_street, meeting_type } = sessionRes.rows[0];
    const ctx = typeof context === 'string' ? JSON.parse(context) : (context || {});
    const isCeremony = meeting_type === 'signing_ceremony';
    const slots = isCeremony
      ? await getCeremonySlots(ctx.ceremony?.id, ceremony_building_id)
      : await getMeetingSlots(zoho_campaign_id, contact_street || null);
    res.json({ slots, lang: language, isCeremony });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /booking/:token/confirm
// ══════════════════════════════════════════════════════════════
router.post('/:token/confirm', async (req, res) => {
  try {
    const { token } = req.params;
    const { slotId } = req.body;
    if (!slotId) return res.status(400).json({ error: 'slotId required' });
    const sessionRes = await pool.query(
      `SELECT bs.*, csc.meeting_type FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [token]
    );
    if (!sessionRes.rows.length) return res.status(404).json({ error: 'Invalid token' });
    const session = sessionRes.rows[0];
    const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
    const lang = session.language || 'he';
    let dateStr, timeStr, repName, slotDatetime;

    if (String(slotId).startsWith('ceremony:')) {
      const parts = String(slotId).split(':');
      const ceremonyId = parts[1];
      const buildingId = parseInt(parts[2]) || null;
      const timeStr_ = parts.slice(3).join(':');
      const buildingFilter = buildingId ? `AND cst.building_id=${buildingId}` : '';
      const lockRes = await pool.query(
        `UPDATE ceremony_slots SET status='confirmed', confirmed_at=NOW(), reserved_at=NOW(),
           contact_phone=$1, zoho_contact_id=$2, contact_name=$3
         WHERE id = (
           SELECT cs.id FROM ceremony_slots cs
           JOIN ceremony_stations cst ON cs.station_id = cst.id
           WHERE cs.ceremony_id=$4 AND cs.status='open' AND cst.is_active=true
             AND TO_CHAR(cs.slot_time,'HH24:MI') = $5 ${buildingFilter}
           ORDER BY cs.id LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING *, TO_CHAR(slot_date,'DD/MM/YYYY') AS date_str_fmt`,
        [session.phone, session.zoho_contact_id, ctx.contactName || '', ceremonyId, timeStr_]
      );
      if (!lockRes.rows.length) return res.status(409).json({ error: 'slot_taken' });
      const slot = lockRes.rows[0];
      const d = new Date(`${slot.slot_date}T${timeStr_}`);
      dateStr = d.toLocaleDateString('he-IL', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem' });
      timeStr = timeStr_;
      repName = null;
      slotDatetime = `${slot.slot_date}T${timeStr_}:00`;
      if (gcal?.createCeremonySlotEvent) gcal.createCeremonySlotEvent(pool, slot, ctx.contactName || '', session.phone).then(id => id && pool.query(`UPDATE ceremony_slots SET google_event_id=$1 WHERE id=$2`, [id, slot.id]).catch(() => {})).catch(e => logger.warn('[BookingRoute] GCal ceremony failed:', e.message));
      if (zcal?.createCeremonySlotEvent) zcal.createCeremonySlotEvent(pool, slot, ctx.contactName || '', session.phone).then(uid => uid && pool.query(`UPDATE ceremony_slots SET zoho_event_id=$1 WHERE id=$2`, [uid, slot.id]).catch(() => {})).catch(e => logger.warn('[BookingRoute] ZohoCal ceremony failed:', e.message));
    } else {
      const lockRes = await pool.query(
        `UPDATE meeting_slots SET status='confirmed', reserved_at=NOW(),
           contact_phone=$1, zoho_contact_id=$2, contact_name=$3, contact_address=$4, contact_street=$5
         WHERE id=$6 AND status='open' RETURNING *`,
        [session.phone, session.zoho_contact_id, ctx.contactName || '', session.contact_address || null, session.contact_street || null, slotId]
      );
      if (!lockRes.rows.length) return res.status(409).json({ error: 'slot_taken' });
      const slot = lockRes.rows[0];
      const slotDt = new Date(slot.slot_datetime);
      dateStr = `${String(slotDt.getUTCDate()).padStart(2,'0')}/${String(slotDt.getUTCMonth()+1).padStart(2,'0')}/${slotDt.getUTCFullYear()}`;
      timeStr = `${String(slotDt.getUTCHours()).padStart(2,'0')}:${String(slotDt.getUTCMinutes()).padStart(2,'0')}`;
      repName = slot.representative_name;
      slotDatetime = slot.slot_datetime;
      if (gcal?.createMeetingSlotEvent) gcal.createMeetingSlotEvent(pool, slot, ctx.contactName || '', session.phone).then(id => id && pool.query(`UPDATE meeting_slots SET google_event_id=$1 WHERE id=$2`, [id, slot.id]).catch(() => {})).catch(e => logger.warn('[BookingRoute] GCal meeting failed:', e.message));
      if (zcal?.createMeetingSlotEvent) zcal.createMeetingSlotEvent(pool, slot, ctx.contactName || '', session.phone).then(uid => uid && pool.query(`UPDATE meeting_slots SET zoho_event_id=$1 WHERE id=$2`, [uid, slot.id]).catch(() => {})).catch(e => logger.warn('[BookingRoute] ZohoCal meeting failed:', e.message));
    }

    ctx.confirmedSlot = { dateStr, timeStr, time: timeStr, date_str: dateStr, rep_name: repName || '' };
    await pool.query(`UPDATE bot_sessions SET state='confirmed', context=$1, booking_completed_at=NOW() WHERE booking_token=$2`, [JSON.stringify(ctx), token]);

    // Short calendar links via /cal/g /cal/o /cal/i
    const slotIdEnc = Buffer.from(String(slotId)).toString('base64url');
    const calBase = `${BASE_URL}/cal`;
    const calLinks = { g: `${calBase}/g/${slotIdEnc}`, o: `${calBase}/o/${slotIdEnc}`, i: `${calBase}/i/${slotIdEnc}` };

    const repLine = repName ? `\n\u{1F464} ${lang === 'ru' ? '\u041f\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u0435\u043b\u044c' : '\u05e0\u05e6\u05d9\u05d2'}: ${repName}` : '';
    const calLines = lang === 'ru'
      ? `\n\n\uD83D\uDCC6 \u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0432 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c:\n\uD83D\uDD35 Google: ${calLinks.g}\n\uD83D\uDD37 Outlook: ${calLinks.o}\n\uD83C\uDF4E iOS: ${calLinks.i}`
      : `\n\n\uD83D\uDCC6 \u05d4\u05d5\u05e1\u05e3 \u05dc\u05d9\u05d5\u05de\u05df:\n\uD83D\uDD35 Google: ${calLinks.g}\n\uD83D\uDD37 Outlook: ${calLinks.o}\n\uD83C\uDF4E iOS: ${calLinks.i}`;
    const waMsg = lang === 'ru'
      ? `\u2705 *\u0412\u0441\u0442\u0440\u0435\u0447\u0430 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0430!*\n\n\uD83D\uDCC5 ${dateStr}\n\u23F0 ${timeStr}${repLine}\n\n\u041d\u0430\u043f\u043e\u043c\u043d\u0438\u043c \u0437\u0430 \u0441\u0443\u0442\u043a\u0438. \u0414\u043e \u0432\u0441\u0442\u0440\u0435\u0447\u0438! \uD83D\uDC4B${calLines}`
      : `\u2705 *\u05d4\u05e4\u05d2\u05d9\u05e9\u05d4 \u05d0\u05d5\u05e9\u05e8\u05d4!*\n\n\uD83D\uDCC5 ${dateStr}\n\u23F0 ${timeStr}${repLine}\n\n\u05ea\u05e7\u05d1\u05dc/\u05d9 \u05ea\u05d6\u05db\u05d5\u05e8\u05ea \u05d9\u05d5\u05dd \u05dc\u05e4\u05e0\u05d9. \u05dc\u05d4\u05ea\u05e8\u05d0\u05d5\u05ea! \uD83D\uDC4B${calLines}`;

    inforuService.sendWhatsAppChat(session.phone, waMsg).catch(e => logger.warn('[BookingRoute] WA send failed:', e.message));
    res.json({ success: true, dateStr, timeStr, repName, calLinks });
  } catch (err) {
    logger.error('[BookingRoute] confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ══════════════════════════════════════════════════════════════

function errorPage(titleHe, msgEn) {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QUANTUM</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;margin:0}
.box{background:#111827;border:1px solid #1e293b;border-radius:16px;padding:40px;max-width:320px}
.logo{color:#60a5fa;font-size:11px;letter-spacing:4px;margin-bottom:16px}
h2{color:#f87171;font-size:18px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}</style>
</head><body><div class="box"><div class="logo">&#x26A1; QUANTUM</div><h2>${titleHe}</h2><p>${msgEn}</p></div></body></html>`;
}

function alreadyBookedPage(lang, slot) {
  const isRu = lang === 'ru';
  const title = isRu ? '\u2705 \u0412\u0441\u0442\u0440\u0435\u0447\u0430 \u0443\u0436\u0435 \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0430' : '\u2705 \u05d4\u05e4\u05d2\u05d9\u05e9\u05d4 \u05db\u05d1\u05e8 \u05e0\u05e7\u05d1\u05e2\u05d4';
  const msg = isRu
    ? `\u0412\u044b \u0443\u0436\u0435 \u0437\u0430\u043f\u0438\u0441\u0430\u043d\u044b \u043d\u0430 ${slot.dateStr || slot.date_str || ''} \u0432 ${slot.timeStr || slot.time || ''}`
    : `\u05db\u05d1\u05e8 \u05e0\u05e7\u05d1\u05e2\u05ea\u05dd \u05dc-${slot.dateStr || slot.date_str || ''} \u05d1\u05e9\u05e2\u05d4 ${slot.timeStr || slot.time || ''}`;
  return `<!DOCTYPE html><html dir="${isRu ? 'ltr' : 'rtl'}" lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QUANTUM</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;margin:0}
.box{background:#111827;border:1px solid #064e3b;border-radius:16px;padding:40px;max-width:320px}
.logo{color:#60a5fa;font-size:11px;letter-spacing:4px;margin-bottom:16px}
h2{color:#34d399;font-size:18px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}</style>
</head><body><div class="box"><div class="logo">&#x26A1; QUANTUM</div><h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

function calendarPage(token, name, lang, config, grouped, isCeremony, buildingLabel, smartPicks, allSlots) {
  const isRu = lang === 'ru';
  const dir = isRu ? 'ltr' : 'rtl';

  const T = {
    he: {
      heading: isCeremony ? '\u05d1\u05d7\u05e8/\u05d9 \u05e9\u05e2\u05d4 \u05dc\u05db\u05e0\u05e1 \u05d4\u05d7\u05ea\u05d9\u05de\u05d5\u05ea' : '\u05d1\u05d7\u05e8/\u05d9 \u05de\u05d5\u05e2\u05d3 \u05e0\u05d5\u05d7',
      building: buildingLabel ? `\u05d1\u05e0\u05d9\u05d9\u05df: ${buildingLabel}` : '',
      subheading: name ? `\u05e9\u05dc\u05d5\u05dd ${name} \uD83D\uDC4B` : '\u05e9\u05dc\u05d5\u05dd \uD83D\uDC4B',
      confirm: '\u05d0\u05d9\u05e9\u05d5\u05e8',
      noSlots: '\u05d0\u05d9\u05df \u05de\u05d5\u05e2\u05d3\u05d9\u05dd \u05e4\u05e0\u05d5\u05d9\u05d9\u05dd \u05db\u05e8\u05d2\u05e2. \u05e0\u05d9\u05e6\u05d5\u05e8 \u05d0\u05d9\u05ea\u05da \u05e7\u05e9\u05e8 \u05d1\u05d4\u05e7\u05d3\u05dd.',
      success_title: '\u2705 \u05d4\u05e4\u05d2\u05d9\u05e9\u05d4 \u05e0\u05e7\u05d1\u05e2\u05d4!',
      success_sub: isCeremony ? '\u05ea\u05e7\u05d1\u05dc/\u05d9 \u05d0\u05d9\u05e9\u05d5\u05e8 \u05d1-WhatsApp.' : '\u05ea\u05e7\u05d1\u05dc/\u05d9 \u05d0\u05d9\u05e9\u05d5\u05e8 \u05d1-WhatsApp \u05d5\u05ea\u05d6\u05db\u05d5\u05e8\u05ea \u05d9\u05d5\u05dd \u05dc\u05e4\u05e0\u05d9.',
      recommended: '\u2B50 \u05de\u05d5\u05de\u05dc\u05e5',
      earliest: '\u23F0 \u05de\u05d5\u05e7\u05d3\u05dd',
      latest: '\uD83C\uDF19 \u05de\u05d0\u05d5\u05d7\u05e8',
      show_all: '\u05d4\u05e6\u05d2 \u05d0\u05ea \u05db\u05dc \u05d4\u05de\u05d5\u05e2\u05d3\u05d9\u05dd',
      hide_all: '\u05d4\u05e1\u05ea\u05e8',
      cancel: '\u05d1\u05d7\u05e8/\u05d9 \u05de\u05d5\u05e2\u05d3 \u05d0\u05d7\u05e8',
      rep_label: '\u05e0\u05e6\u05d9\u05d2',
      smart_heading: '\u05de\u05d5\u05e2\u05d3\u05d9\u05dd \u05de\u05d5\u05de\u05dc\u05e6\u05d9\u05dd',
      gcal: '\u05d4\u05d5\u05e1\u05e3 \u05dc\u05d9\u05d5\u05de\u05df',
      spots_one: '\u05de\u05e7\u05d5\u05dd \u05d0\u05d7\u05d3 \u05e4\u05e0\u05d5\u05d9',
      spots_many: '\u05de\u05e7\u05d5\u05de\u05d5\u05ea \u05e4\u05e0\u05d5\u05d9\u05d9\u05dd',
      no_selection: '\u05d1\u05d7\u05e8/\u05d9 \u05de\u05d5\u05e2\u05d3 \u05d5\u05dc\u05d7\u05e5 \u05d0\u05d9\u05e9\u05d5\u05e8',
    },
    ru: {
      heading: isCeremony ? '\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0440\u0435\u043c\u044f \u0434\u043b\u044f \u0446\u0435\u0440\u0435\u043c\u043e\u043d\u0438\u0438' : '\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0434\u043e\u0431\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f',
      building: buildingLabel ? `\u0417\u0434\u0430\u043d\u0438\u0435: ${buildingLabel}` : '',
      subheading: name ? `\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, ${name} \uD83D\uDC4B` : '\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435 \uD83D\uDC4B',
      confirm: '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c',
      noSlots: '\u041d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b\u0445 \u0441\u043b\u043e\u0442\u043e\u0432. \u041c\u044b \u0441\u0432\u044f\u0436\u0435\u043c\u0441\u044f \u0441 \u0432\u0430\u043c\u0438.',
      success_title: '\u2705 \u0412\u0441\u0442\u0440\u0435\u0447\u0430 \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0430!',
      success_sub: isCeremony ? '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435 \u043f\u0440\u0438\u0434\u0451\u0442 \u0432 WhatsApp.' : '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435 \u043f\u0440\u0438\u0434\u0451\u0442 \u0432 WhatsApp. \u041d\u0430\u043f\u043e\u043c\u043d\u0438\u043c \u0437\u0430 \u0441\u0443\u0442\u043a\u0438.',
      recommended: '\u2B50 \u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u043c',
      earliest: '\u23F0 \u0420\u0430\u043d\u044c\u0448\u0435',
      latest: '\uD83C\uDF19 \u041f\u043e\u0437\u0436\u0435',
      show_all: '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0432\u0441\u0435 \u0441\u043b\u043e\u0442\u044b',
      hide_all: '\u0421\u043a\u0440\u044b\u0442\u044c',
      cancel: '\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u0434\u0440\u0443\u0433\u043e\u0435 \u0432\u0440\u0435\u043c\u044f',
      rep_label: '\u041f\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u0435\u043b\u044c',
      smart_heading: '\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u043c\u044b\u0435',
      gcal: '\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0432 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c',
      spots_one: '1 \u043c\u0435\u0441\u0442\u043e',
      spots_many: '\u043c\u0435\u0441\u0442\u0430',
      no_selection: '\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0440\u0435\u043c\u044f \u0438 \u043d\u0430\u0436\u043c\u0438\u0442\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c',
    },
  }[lang] || {};

  const slotDataMap = {};
  for (const s of (allSlots || [])) {
    const dateObj = new Date(`${s.slot_date}T${s.time_str}`);
    const dayLabel = (isRu ? DAY_NAMES_RU : DAY_NAMES_HE)[s.dow] || '';
    const dayNum = `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}`;
    slotDataMap[String(s.id)] = { dateLabel: `${dayLabel} ${dayNum}`, time: s.time_str, rep: s.representative_name || '' };
  }
  if (smartPicks) {
    for (const s of smartPicks) {
      if (!slotDataMap[String(s.id)]) {
        const dateObj = new Date(`${s.slot_date}T${s.time_str}`);
        const dayLabel = (isRu ? DAY_NAMES_RU : DAY_NAMES_HE)[s.dow] || '';
        const dayNum = `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}`;
        slotDataMap[String(s.id)] = { dateLabel: `${dayLabel} ${dayNum}`, time: s.time_str, rep: s.representative_name || '' };
      }
    }
  }

  let smartHtml = '';
  if (!isCeremony && smartPicks && smartPicks.length > 0) {
    const LABELS = [T.recommended, T.earliest, T.latest];
    smartHtml = `<div class="smart-section">
      <div class="section-label">&#x2728; ${T.smart_heading}</div>
      <div class="smart-row">`;
    smartPicks.forEach((slot, i) => {
      const dateObj = new Date(`${slot.slot_date}T${slot.time_str}`);
      const dayLabel = (isRu ? DAY_NAMES_RU : DAY_NAMES_HE)[slot.dow] || '';
      const dayNum = `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}`;
      smartHtml += `<button class="smart-btn" data-slot-id="${slot.id}">
        <span class="smart-label">${LABELS[i] || ''}</span>
        <span class="smart-time">${slot.time_str}</span>
        <span class="smart-date">${dayLabel} ${dayNum}</span>
        ${config.show_rep_name && slot.representative_name ? `<span class="smart-rep">${slot.representative_name}</span>` : ''}
      </button>`;
    });
    smartHtml += `</div></div>`;
  }

  let slotsHtml = '';
  if (!grouped.length) {
    slotsHtml = `<div class="no-slots">${T.noSlots}</div>`;
  } else {
    for (const group of grouped) {
      slotsHtml += `<div class="day-group">
        <div class="day-label">
          <span class="day-name">${group.label}</span>
          <span class="day-date">${group.dayNum}</span>
        </div>
        <div class="slots-row">`;
      for (const slot of group.slots) {
        const openCount = parseInt(slot.open_count) || 0;
        const capacityBadge = isCeremony && openCount ? `<span class="cap-badge">${openCount === 1 ? T.spots_one : openCount + ' ' + T.spots_many}</span>` : '';
        const recClass = slot.is_recommended ? ' recommended' : '';
        const disabledAttr = openCount === 0 ? 'disabled' : '';
        slotsHtml += `<button class="slot-btn${recClass}" data-slot-id="${slot.id}" ${disabledAttr}>
          <span class="slot-time">${slot.time_str}</span>
          ${capacityBadge}
          ${!isCeremony && config.show_rep_name && slot.representative_name ? `<span class="rep-name">${slot.representative_name}</span>` : ''}
        </button>`;
      }
      slotsHtml += `</div></div>`;
    }
  }

  const buildingHtml = T.building ? `<div class="building-tag">&#x1F4CD; ${T.building}</div>` : '';
  const hasSmartAndSlots = !isCeremony && smartPicks && smartPicks.length > 0 && grouped.length > 0;
  const allSlotsSection = hasSmartAndSlots
    ? `<div class="all-toggle" id="allToggle">&#x25BC; ${T.show_all}</div>
       <div id="allSlots" style="display:none">${slotsHtml}</div>`
    : slotsHtml;

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>QUANTUM</title>
<style>
  :root{--blue:#3b82f6;--blue-dark:#1d4ed8;--green:#10b981;--amber:#f59e0b;--dark:#07080f;--card:#0f1623;--card2:#111827;--border:#1e293b;--text:#e2e8f0;--muted:#64748b;--sidebar:320px}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:var(--dark);color:var(--text);min-height:100vh;direction:${dir}}
  .page-header{background:linear-gradient(160deg,#0d1f3c 0%,#061120 100%);border-bottom:1px solid #1e3a5f66;padding:0}
  .header-inner{max-width:1200px;margin:0 auto;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .header-brand{display:flex;align-items:center;gap:12px}
  .logo-mark{font-size:22px;line-height:1}
  .logo-text{font-size:10px;letter-spacing:5px;color:#60a5fa;text-transform:uppercase;font-weight:700}
  .header-info{text-align:${isRu ? 'left' : 'right'}}
  .header-title{font-size:18px;font-weight:800;color:#f1f5f9}
  .header-sub{font-size:13px;color:#94a3b8;margin-top:2px}
  .building-tag{display:inline-block;margin-top:5px;background:#1e3a5f;color:#93c5fd;border:1px solid #3b82f660;border-radius:8px;padding:2px 10px;font-size:12px;font-weight:600}
  .page-body{max-width:1200px;margin:0 auto;padding:24px 24px 40px}
  .layout{display:block}
  .main-col{min-width:0}
  .sidebar-col{display:none}
  .section-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px}
  .smart-section{margin-bottom:28px}
  .smart-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px}
  .smart-btn{background:linear-gradient(160deg,#131d2e,#0a1120);border:1.5px solid var(--blue);border-radius:16px;padding:16px 12px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;touch-action:manipulation;transition:all .15s;-webkit-appearance:none;text-align:center}
  .smart-btn:hover,.smart-btn:active{border-color:#60a5fa;background:#132040;transform:translateY(-1px)}
  .smart-btn.selected{background:#132040;border-color:#93c5fd;box-shadow:0 0 0 3px #3b82f630}
  .smart-label{font-size:10px;font-weight:800;color:var(--blue);letter-spacing:.5px;pointer-events:none}
  .smart-time{font-size:26px;font-weight:900;color:var(--text);line-height:1;pointer-events:none}
  .smart-date{font-size:12px;color:var(--muted);pointer-events:none;margin-top:2px}
  .smart-rep{font-size:10px;color:#475569;pointer-events:none}
  .all-toggle{text-align:center;padding:12px 16px;color:var(--blue);font-size:14px;cursor:pointer;border:1px dashed var(--border);border-radius:12px;margin-bottom:20px;user-select:none;font-weight:600}
  .all-toggle:hover{background:#0f1623;border-color:var(--blue)}
  .day-group{margin-bottom:28px}
  .day-label{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .day-name{font-size:15px;font-weight:800;color:var(--blue)}
  .day-date{font-size:13px;color:var(--muted);font-weight:500}
  .slots-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:8px}
  .slot-btn{position:relative;background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:12px 8px;cursor:pointer;transition:border-color .12s,background .12s,box-shadow .12s,transform .1s;display:flex;flex-direction:column;align-items:center;gap:4px;touch-action:manipulation;-webkit-appearance:none}
  .slot-btn:hover,.slot-btn:active{border-color:var(--blue);background:#0f1e35;transform:translateY(-1px)}
  .slot-btn.selected{border-color:var(--blue);background:#0f1e35;box-shadow:0 0 0 3px #3b82f625}
  .slot-btn.recommended{border-color:var(--amber);background:#130f02}
  .slot-btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
  .slot-time{font-size:15px;font-weight:800;color:var(--text);pointer-events:none;line-height:1}
  .rep-name{font-size:9px;color:var(--muted);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;text-align:center}
  .cap-badge{font-size:9px;font-weight:600;color:#6ee7b7;pointer-events:none}
  .no-slots{text-align:center;color:var(--muted);padding:60px 20px;font-size:15px}
  .confirm-panel{position:fixed;bottom:0;left:0;right:0;background:linear-gradient(180deg,#0c1525,#08101e);border-top:1px solid #2563eb88;padding:16px 20px 32px;transform:translateY(110%);transition:transform .3s cubic-bezier(.4,0,.2,1);z-index:100;backdrop-filter:blur(12px)}
  .confirm-panel.open{transform:translateY(0)}
  .selected-time{font-size:22px;font-weight:900;margin-bottom:3px;color:#f1f5f9}
  .selected-rep{font-size:13px;color:var(--muted);margin-bottom:14px;min-height:18px}
  .confirm-btn{width:100%;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:14px;padding:16px;font-size:17px;font-weight:800;cursor:pointer;-webkit-appearance:none;letter-spacing:.3px;transition:opacity .15s}
  .confirm-btn:hover{opacity:.92}
  .confirm-btn:disabled{background:#1e293b;color:#475569;cursor:not-allowed}
  .cancel-link{display:block;text-align:center;margin-top:12px;color:var(--muted);font-size:13px;cursor:pointer;padding:4px}
  .sidebar-confirm{display:none}
  .success-screen{display:none;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:40px 24px}
  .success-screen.show{display:flex}
  .success-icon{font-size:72px;margin-bottom:24px}
  .success-title{font-size:24px;font-weight:900;color:var(--green);margin-bottom:10px}
  .success-detail{font-size:17px;font-weight:700;margin-bottom:8px}
  .success-sub{font-size:14px;color:var(--muted);margin-bottom:28px}
  .gcal-btn{display:inline-block;background:#0f1e35;color:#93c5fd;border:1.5px solid #3b82f6;border-radius:14px;padding:14px 24px;font-size:14px;text-decoration:none;font-weight:700;width:100%;text-align:center}
  .toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-80px);background:#7f1d1d;color:#fca5a5;padding:10px 20px;border-radius:10px;font-size:14px;transition:transform .25s;z-index:200;max-width:320px;text-align:center;font-weight:600}
  .toast.show{transform:translateX(-50%) translateY(0)}
  .loading-overlay{display:none;position:fixed;inset:0;background:#07080fcc;z-index:150;align-items:center;justify-content:center}
  .loading-overlay.show{display:flex}
  .spinner{width:44px;height:44px;border:3px solid #1e293b;border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (min-width:768px) {
    .header-title{font-size:21px}
    .layout{display:grid;grid-template-columns:1fr var(--sidebar);gap:32px;align-items:start}
    .main-col{min-width:0}
    .sidebar-col{display:block;position:sticky;top:24px}
    .slots-row{grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px}
    .slot-btn{padding:14px 10px;border-radius:14px}
    .slot-time{font-size:17px}
    .rep-name{font-size:10px;max-width:100px}
    .smart-time{font-size:30px}
    .smart-date{font-size:13px}
    .confirm-panel{display:none !important}
    .sidebar-confirm{display:block;background:linear-gradient(160deg,#0d1f3c,#08101e);border:1.5px solid #2563eb66;border-radius:20px;padding:24px;margin-bottom:20px}
    .sidebar-confirm.has-selection{border-color:#3b82f6;box-shadow:0 0 0 1px #3b82f620}
    .sidebar-no-sel{color:var(--muted);font-size:14px;text-align:center;padding:8px 0}
    .sidebar-time{font-size:28px;font-weight:900;color:#f1f5f9;margin-bottom:4px}
    .sidebar-rep{font-size:13px;color:var(--muted);margin-bottom:18px;min-height:16px}
    .sidebar-confirm-btn{width:100%;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:800;cursor:pointer;-webkit-appearance:none;transition:opacity .15s;display:none}
    .sidebar-confirm-btn.visible{display:block}
    .sidebar-confirm-btn:hover{opacity:.9}
    .sidebar-confirm-btn:disabled{background:#1e293b;color:#475569;cursor:not-allowed}
    .sidebar-cancel-link{display:none;text-align:center;margin-top:10px;color:var(--muted);font-size:13px;cursor:pointer;padding:4px}
    .sidebar-cancel-link.visible{display:block}
    .sidebar-brand{background:linear-gradient(160deg,#0a1120,#060d18);border:1px solid var(--border);border-radius:16px;padding:20px;text-align:center}
    .sidebar-brand-logo{font-size:11px;letter-spacing:4px;color:#60a5fa;text-transform:uppercase;font-weight:700;margin-bottom:8px}
    .sidebar-brand-tagline{font-size:12px;color:#475569;line-height:1.5}
    .page-body{padding:28px 28px 60px}
    .all-toggle{padding:14px 20px}
  }
  @media (min-width:1100px) {
    --sidebar: 340px;
    .slots-row{grid-template-columns:repeat(auto-fill,minmax(100px,1fr))}
    .slot-time{font-size:18px}
  }
</style>
</head>
<body>
<div class="page-header">
  <div class="header-inner">
    <div class="header-brand">
      <span class="logo-mark">&#x26A1;</span>
      <span class="logo-text">QUANTUM</span>
    </div>
    <div class="header-info">
      <div class="header-title">${T.heading}</div>
      <div class="header-sub">${T.subheading}</div>
      ${buildingHtml}
    </div>
  </div>
</div>
<div id="mainView">
  <div class="page-body">
    <div class="layout">
      <div class="main-col">
        ${smartHtml}
        ${allSlotsSection}
      </div>
      <div class="sidebar-col">
        <div class="sidebar-confirm" id="sidebarConfirm">
          <div class="section-label">&#x2713; ${T.confirm}</div>
          <div class="sidebar-no-sel" id="sidebarNoSel">${T.no_selection}</div>
          <div class="sidebar-time" id="sidebarTime" style="display:none"></div>
          <div class="sidebar-rep" id="sidebarRep" style="display:none"></div>
          <button class="sidebar-confirm-btn" id="sidebarConfirmBtn">${T.confirm}</button>
          <span class="sidebar-cancel-link" id="sidebarCancelBtn">&#x21A9; ${T.cancel}</span>
        </div>
        <div class="sidebar-brand">
          <div class="sidebar-brand-logo">&#x26A1; QUANTUM</div>
          <div class="sidebar-brand-tagline">${lang === 'ru' ? '\u0411\u0443\u0442\u0438\u043a\u043e\u0432\u043e\u0435 \u0430\u0433\u0435\u043d\u0442\u0441\u0442\u0432\u043e \u043d\u0435\u0434\u0432\u0438\u0436\u0438\u043c\u043e\u0441\u0442\u0438' : '\u05ea\u05d9\u05d5\u05d5\u05db \u05e0\u05d3\u05dc\u05df \u05de\u05d5\u05d1\u05d7\u05e8 \u05d1\u05e4\u05d9\u05e0\u05d5\u05d9-\u05d1\u05d9\u05e0\u05d5\u05d9'}</div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="confirm-panel" id="confirmPanel">
  <div class="selected-time" id="selectedLabel"></div>
  <div class="selected-rep" id="selectedRep"></div>
  <button class="confirm-btn" id="confirmBtn">${T.confirm}</button>
  <span class="cancel-link" id="cancelBtn">&#x21A9; ${T.cancel}</span>
</div>
<div class="success-screen" id="successScreen">
  <div class="success-icon">&#x1F389;</div>
  <div class="success-title">${T.success_title}</div>
  <div class="success-detail" id="successDetail"></div>
  <div class="success-sub">${T.success_sub}</div>
  <div id="calBtns" style="display:none;flex-direction:column;gap:10px;width:100%;max-width:280px;align-items:center;">
    <a class="gcal-btn" id="calGoogle" href="#" target="_blank">&#x1F535; Google Calendar</a>
    <a class="gcal-btn" id="calOutlook" href="#" target="_blank">&#x1F537; Outlook Calendar</a>
    <a class="gcal-btn" id="calIos" href="#" target="_blank">&#x1F34E; Apple / iOS</a>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="loading-overlay" id="loader"><div class="spinner"></div></div>
<script>
var TOKEN = ${JSON.stringify(token)};
var SHOW_REP = ${config.show_rep_name ? 'true' : 'false'};
var REP_LABEL = ${JSON.stringify(T.rep_label || '')};
var SLOT_TAKEN_MSG = ${JSON.stringify(lang === 'ru' ? '\u042d\u0442\u043e \u0432\u0440\u0435\u043c\u044f \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442\u043e \u2014 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043e\u0435.' : '\u05d4\u05de\u05d5\u05e2\u05d3 \u05db\u05d1\u05e8 \u05e0\u05ea\u05e4\u05e1 \u2014 \u05d0\u05e0\u05d0 \u05d1\u05d7\u05e8/\u05d9 \u05de\u05d5\u05e2\u05d3 \u05d0\u05d7\u05e8.')};
var SHOW_ALL_TXT = '\\u25BC ${T.show_all}';
var HIDE_ALL_TXT = '\\u25B2 ${T.hide_all}';
var SLOT_DATA = ${JSON.stringify(slotDataMap)};
var selectedSlotId = null;
var allVisible = false;
document.addEventListener('click', function(e) {
  var slotBtn = e.target.closest('[data-slot-id]');
  if (slotBtn && !slotBtn.disabled) { selectSlot(slotBtn, slotBtn.getAttribute('data-slot-id')); return; }
  var el = e.target;
  if (el.id === 'confirmBtn' || el.closest('#confirmBtn') || el.id === 'sidebarConfirmBtn' || el.closest('#sidebarConfirmBtn')) { confirmBooking(); return; }
  if (el.id === 'cancelBtn' || el.closest('#cancelBtn') || el.id === 'sidebarCancelBtn' || el.closest('#sidebarCancelBtn')) { cancelSelection(); return; }
  if (el.id === 'allToggle' || el.closest('#allToggle')) { toggleAllSlots(); return; }
});
function selectSlot(btn, id) {
  document.querySelectorAll('[data-slot-id]').forEach(function(b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
  selectedSlotId = id;
  var data = SLOT_DATA[String(id)] || {};
  var label = (data.dateLabel || '') + '  \u23F0 ' + (data.time || '');
  var rep = (SHOW_REP && data.rep) ? REP_LABEL + ': ' + data.rep : '';
  document.getElementById('selectedLabel').textContent = label;
  document.getElementById('selectedRep').textContent = rep;
  document.getElementById('confirmPanel').classList.add('open');
  var sidebarNoSel = document.getElementById('sidebarNoSel');
  var sidebarTime = document.getElementById('sidebarTime');
  var sidebarRep = document.getElementById('sidebarRep');
  var sidebarConfirmBtn = document.getElementById('sidebarConfirmBtn');
  var sidebarCancelBtn = document.getElementById('sidebarCancelBtn');
  var sidebarConfirm = document.getElementById('sidebarConfirm');
  if (sidebarNoSel) sidebarNoSel.style.display = 'none';
  if (sidebarTime) { sidebarTime.textContent = label; sidebarTime.style.display = 'block'; }
  if (sidebarRep) { sidebarRep.textContent = rep; sidebarRep.style.display = rep ? 'block' : 'none'; }
  if (sidebarConfirmBtn) sidebarConfirmBtn.classList.add('visible');
  if (sidebarCancelBtn) sidebarCancelBtn.classList.add('visible');
  if (sidebarConfirm) sidebarConfirm.classList.add('has-selection');
}
function cancelSelection() {
  document.querySelectorAll('[data-slot-id]').forEach(function(b) { b.classList.remove('selected'); });
  selectedSlotId = null;
  document.getElementById('confirmPanel').classList.remove('open');
  var sidebarNoSel = document.getElementById('sidebarNoSel');
  var sidebarTime = document.getElementById('sidebarTime');
  var sidebarRep = document.getElementById('sidebarRep');
  var sidebarConfirmBtn = document.getElementById('sidebarConfirmBtn');
  var sidebarCancelBtn = document.getElementById('sidebarCancelBtn');
  var sidebarConfirm = document.getElementById('sidebarConfirm');
  if (sidebarNoSel) sidebarNoSel.style.display = 'block';
  if (sidebarTime) sidebarTime.style.display = 'none';
  if (sidebarRep) sidebarRep.style.display = 'none';
  if (sidebarConfirmBtn) sidebarConfirmBtn.classList.remove('visible');
  if (sidebarCancelBtn) sidebarCancelBtn.classList.remove('visible');
  if (sidebarConfirm) sidebarConfirm.classList.remove('has-selection');
}
function toggleAllSlots() {
  allVisible = !allVisible;
  document.getElementById('allSlots').style.display = allVisible ? 'block' : 'none';
  document.getElementById('allToggle').textContent = allVisible ? HIDE_ALL_TXT : SHOW_ALL_TXT;
}
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 3500);
}
async function confirmBooking() {
  if (!selectedSlotId) return;
  var confirmBtns = [document.getElementById('confirmBtn'), document.getElementById('sidebarConfirmBtn')];
  confirmBtns.forEach(function(b) { if (b) b.disabled = true; });
  document.getElementById('loader').classList.add('show');
  try {
    var res = await fetch('/booking/' + TOKEN + '/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: selectedSlotId })
    });
    var data = await res.json();
    document.getElementById('loader').classList.remove('show');
    if (res.status === 409 || data.error === 'slot_taken') {
      showToast(SLOT_TAKEN_MSG);
      setTimeout(function() { location.reload(); }, 1500);
      return;
    }
    if (data.success) {
      document.getElementById('mainView').style.display = 'none';
      document.getElementById('confirmPanel').classList.remove('open');
      document.getElementById('successDetail').textContent = data.dateStr + '  \u23F0 ' + data.timeStr;
      if (data.calLinks) { document.getElementById('calGoogle').href = data.calLinks.g; document.getElementById('calOutlook').href = data.calLinks.o; document.getElementById('calIos').href = data.calLinks.i; document.getElementById('calBtns').style.display = 'flex'; }
      document.getElementById('successScreen').classList.add('show');
    } else {
      showToast('\u05e9\u05d2\u05d9\u05d0\u05d4 \u2014 \u05d0\u05e0\u05d0 \u05e0\u05e1\u05d4/\u05d9 \u05e9\u05d5\u05d1');
      confirmBtns.forEach(function(b) { if (b) b.disabled = false; });
    }
  } catch (err) {
    document.getElementById('loader').classList.remove('show');
    showToast('\u05e9\u05d2\u05d9\u05d0\u05ea \u05d7\u05d9\u05d1\u05d5\u05e8 \u2014 \u05d0\u05e0\u05d0 \u05e0\u05e1\u05d4/\u05d9 \u05e9\u05d5\u05d1');
    confirmBtns.forEach(function(b) { if (b) b.disabled = false; });
  }
}
</script>
</body>
</html>`;
}

module.exports = router;
