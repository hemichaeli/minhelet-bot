/**
 * QUANTUM Scheduling Routes v4
 *
 * GET  /api/scheduling/admin                                - Campaign Admin Panel (UI)
 * POST /api/scheduling/demo-link                            - Generate real booking URL for demo/testing
 * POST /api/scheduling/webhook                              - Inforu WA webhook
 * GET  /api/scheduling/campaign/:id                        - Get campaign config
 * PUT  /api/scheduling/campaign/:id                        - Save campaign config
 * POST /api/scheduling/campaign/:id/generate-slots         - Auto-generate meeting_slots from config
 * DELETE /api/scheduling/campaign/:id/slots                - Delete open slots in date range
 * GET  /api/scheduling/campaign/:id/slots/preview          - Preview slots without saving
 * POST /api/scheduling/broadcast                           - Send initial WA to campaign contacts
 * POST /api/scheduling/ceremony                            - Create ceremony
 * POST /api/scheduling/ceremony/:id/assign                 - Assign contacts to buildings
 * GET  /api/scheduling/ceremony/:id/buildings              - List buildings + station counts
 * GET  /api/scheduling/ceremony/:id/slots                  - Get ceremony slot grid
 * GET  /api/scheduling/campaign/:id/stats                  - Basic booking stats
 * GET  /api/scheduling/campaign/:id/report                 - Full campaign report (HTML+JSON)
 * POST /api/scheduling/optimization/run                    - Manual trigger for optimization engine
 * GET  /api/scheduling/optimization/status                 - Reschedule request stats
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../db/pool');
const botEngine = require('../services/botEngine');
const inforuService = require('../services/inforuService');
let zohoSchedulingService;
try { zohoSchedulingService = require('../services/zohoSchedulingService'); } catch (e) { /* optional */ }
let optimizationService;
try { optimizationService = require('../services/optimizationService'); } catch (e) { /* optional */ }

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── ZOHO CRM WIDGET ────────────────────────────────────────────
router.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/zoho-scheduling-widget.html'));
});

// ── CAMPAIGN ADMIN PANEL ───────────────────────────────────────
router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/campaign-admin.html'));
});

// ── DEMO BOOKING LINK ──────────────────────────────────────────
// POST /api/scheduling/demo-link
// Body: { campaignId, phone, name, language }
// Creates (or reuses) a bot_session + booking_token → returns a real booking URL
router.post('/demo-link', async (req, res) => {
  try {
    const { campaignId, phone, name, language } = req.body;
    if (!campaignId || !phone) return res.status(400).json({ error: 'campaignId and phone required' });
    const crypto = require('crypto');
    const newToken = crypto.randomBytes(16).toString('hex');
    const context = JSON.stringify({ contactName: name || phone });
    await pool.query(
      `INSERT INTO bot_sessions (phone, zoho_campaign_id, state, language, context, booking_token, created_at, last_message_at)
       VALUES ($1,$2,'awaiting_booking',$3,$4,$5,NOW(),NOW())
       ON CONFLICT (phone, zoho_campaign_id) DO UPDATE SET
         booking_token = COALESCE(NULLIF(bot_sessions.booking_token,''), EXCLUDED.booking_token),
         context = CASE WHEN bot_sessions.context::text='{}' THEN EXCLUDED.context ELSE bot_sessions.context END,
         language = EXCLUDED.language,
         last_message_at = NOW()`,
      [phone, campaignId, language || 'he', context, newToken]
    );
    const row = await pool.query(
      `SELECT booking_token FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id=$2`,
      [phone, campaignId]
    );
    const token = row.rows[0]?.booking_token;
    res.json({ success: true, booking_url: `${BASE_URL}/booking/${token}`, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CAMPAIGN CONTACTS ──────────────────────────────────────────
router.get('/campaign/:id/contacts', async (req, res) => {
  const campaignId = req.params.id;
  try {
    if (zohoSchedulingService?.getCampaignContacts) {
      try {
        const contacts = await zohoSchedulingService.getCampaignContacts(campaignId);
        if (contacts.length > 0) return res.json({ success: true, source: 'zoho', contacts });
      } catch (zohoErr) { /* fall through */ }
    }
    const { rows } = await pool.query(
      `SELECT bs.phone, bs.context->>'contactName' AS name, bs.context->>'contactId' AS id,
              bs.language, bs.state AS status, bs.last_message_at
       FROM bot_sessions bs WHERE bs.zoho_campaign_id=$1 ORDER BY bs.last_message_at DESC`,
      [campaignId]
    );
    res.json({ success: true, source: 'db', contacts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── WEBHOOK ────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  try {
    const { From, Body, CampaignId } = req.body;
    if (!From || !Body) return res.sendStatus(200);

    if (optimizationService?.handleRescheduleReply) {
      try {
        const handled = await optimizationService.handleRescheduleReply(From, Body);
        if (handled) return res.sendStatus(200);
      } catch (optErr) {
        console.warn('[Webhook] Optimization reply check failed:', optErr.message);
      }
    }

    let campaignId = CampaignId;
    if (!campaignId) {
      const sess = await pool.query(
        `SELECT zoho_campaign_id FROM bot_sessions WHERE phone=$1 ORDER BY last_message_at DESC LIMIT 1`,
        [From]
      );
      campaignId = sess.rows[0]?.zoho_campaign_id;
    }

    if (!campaignId) {
      console.warn(`[Webhook] No campaign found for phone ${From}`);
      return res.sendStatus(200);
    }

    const reply = await botEngine.handleIncoming(From, Body, campaignId);
    if (reply) await inforuService.sendWhatsApp(From, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.sendStatus(500);
  }
});

// ── OPTIMIZATION ENGINE API ────────────────────────────────────
router.post('/optimization/run', async (req, res) => {
  if (!optimizationService) return res.status(503).json({ error: 'Optimization service not available' });
  try {
    const { campaignId } = req.body;
    const result = campaignId
      ? await optimizationService.sendRescheduleOffers(campaignId)
      : await optimizationService.runOptimizationForAllCampaigns();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/optimization/status', async (req, res) => {
  try {
    const { campaignId } = req.query;
    const whereClause = campaignId ? `WHERE campaign_id=$1` : '';
    const params = campaignId ? [campaignId] : [];
    const result = await pool.query(
      `SELECT status, COUNT(*) AS total, AVG(gap_saved_minutes) AS avg_gap_saved
       FROM reschedule_requests ${whereClause} GROUP BY status ORDER BY total DESC`, params
    );
    const pending = await pool.query(
      `SELECT rr.*, ms.slot_datetime AS proposed_dt FROM reschedule_requests rr
       JOIN meeting_slots ms ON ms.id = rr.proposed_slot_id
       WHERE rr.status='pending' ORDER BY rr.created_at DESC LIMIT 20`, []
    );
    res.json({ summary: result.rows, pending: pending.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// CAMPAIGN CONFIG — GET + PUT
// ══════════════════════════════════════════════════════════════

router.get('/campaign/:campaignId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT csc.*, p.name AS project_name, p.google_calendar_id, p.zoho_calendar_id
       FROM campaign_schedule_config csc
       LEFT JOIN projects p ON csc.project_id = p.id
       WHERE csc.zoho_campaign_id=$1`,
      [req.params.campaignId]
    );
    if (!result.rows.length) return res.json({ config: null, message: 'No config found' });
    res.json({ config: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/campaign/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      project_id, meeting_type, available_windows, slot_duration_minutes, buffer_minutes,
      reminder_delay_hours, bot_followup_delay_hours, pre_meeting_reminder_hours, morning_reminder_hours,
      wa_initial_template, wa_language, show_rep_name, booking_link_expires_hours,
      default_start_time, default_end_time, generate_days_ahead
    } = req.body;

    const windows = available_windows && available_windows.length > 0
      ? available_windows
      : [
          { day: 0, start: default_start_time || '09:00', end: default_end_time || '18:00' },
          { day: 1, start: default_start_time || '09:00', end: default_end_time || '18:00' },
          { day: 2, start: default_start_time || '09:00', end: default_end_time || '18:00' },
          { day: 3, start: default_start_time || '09:00', end: default_end_time || '18:00' },
          { day: 4, start: default_start_time || '09:00', end: default_end_time || '18:00' }
        ];

    await pool.query(
      `INSERT INTO campaign_schedule_config
         (zoho_campaign_id, project_id, meeting_type, available_windows,
          slot_duration_minutes, buffer_minutes,
          reminder_delay_hours, bot_followup_delay_hours,
          pre_meeting_reminder_hours, morning_reminder_hours,
          wa_initial_template, wa_language,
          show_rep_name, booking_link_expires_hours,
          default_start_time, default_end_time, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (zoho_campaign_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, meeting_type = EXCLUDED.meeting_type,
         available_windows = EXCLUDED.available_windows,
         slot_duration_minutes = EXCLUDED.slot_duration_minutes,
         buffer_minutes = EXCLUDED.buffer_minutes,
         reminder_delay_hours = EXCLUDED.reminder_delay_hours,
         bot_followup_delay_hours = EXCLUDED.bot_followup_delay_hours,
         pre_meeting_reminder_hours = EXCLUDED.pre_meeting_reminder_hours,
         morning_reminder_hours = EXCLUDED.morning_reminder_hours,
         wa_initial_template = EXCLUDED.wa_initial_template,
         wa_language = EXCLUDED.wa_language,
         show_rep_name = EXCLUDED.show_rep_name,
         booking_link_expires_hours = EXCLUDED.booking_link_expires_hours,
         default_start_time = EXCLUDED.default_start_time,
         default_end_time = EXCLUDED.default_end_time,
         updated_at = NOW()`,
      [
        campaignId, project_id || null, meeting_type || 'consultation', JSON.stringify(windows),
        slot_duration_minutes || 45, buffer_minutes || 15,
        reminder_delay_hours || 24, bot_followup_delay_hours || 48,
        pre_meeting_reminder_hours || 24, morning_reminder_hours || 2,
        wa_initial_template || '', wa_language || 'he',
        show_rep_name !== false, booking_link_expires_hours || 48,
        default_start_time || '09:00', default_end_time || '18:00'
      ]
    );

    res.json({ success: true, available_windows: windows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SLOT GENERATION
// ══════════════════════════════════════════════════════════════

function buildSlotDatetimes(windows, fromDate, toDate, slotMin, bufferMin) {
  const step = slotMin + bufferMin;
  const slots = [];
  const windowMap = {};
  for (const w of windows) {
    const d = parseInt(w.day);
    if (!windowMap[d]) windowMap[d] = [];
    const [sh, sm] = (w.start || '09:00').split(':').map(Number);
    const [eh, em] = (w.end   || '18:00').split(':').map(Number);
    windowMap[d].push({ startMins: sh * 60 + sm, endMins: eh * 60 + em });
  }
  const cur = new Date(fromDate); cur.setHours(0, 0, 0, 0);
  const end = new Date(toDate);   end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const dow = cur.getDay();
    for (const win of (windowMap[dow] || [])) {
      for (let m = win.startMins; m + slotMin <= win.endMins; m += step) {
        const dt = new Date(cur);
        dt.setHours(Math.floor(m / 60), m % 60, 0, 0);
        if (dt > new Date()) slots.push(new Date(dt));
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return slots;
}

function buildRepCycle(representatives) {
  if (!representatives || !representatives.length) return [];
  const cycle = [];
  for (const r of representatives) {
    const w = parseInt(r.weight) || 1;
    for (let i = 0; i < w; i++) cycle.push(r.name);
  }
  return cycle;
}

router.post('/campaign/:campaignId/generate-slots', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const configRes = await pool.query(
      `SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [campaignId]
    );
    if (!configRes.rows.length) return res.status(404).json({ error: 'Campaign config not found. Create config first via PUT.' });
    const cfg = configRes.rows[0];
    const { from_date, to_date, representatives: repsOverride, dry_run = false } = req.body;

    const daysAhead = cfg.generate_days_ahead || 30;
    const fromDate = from_date ? new Date(from_date) : new Date();
    const toDate   = to_date   ? new Date(to_date)   : new Date(Date.now() + daysAhead * 86400000);
    const windows  = cfg.available_windows?.length ? cfg.available_windows : [0,1,2,3,4].map(d => ({ day: d, start: '09:00', end: '18:00' }));
    const slotMin   = parseInt(cfg.slot_duration_minutes) || 45;
    const bufferMin = parseInt(cfg.buffer_minutes) || 15;
    const datetimes = buildSlotDatetimes(windows, fromDate, toDate, slotMin, bufferMin);
    const reps = buildRepCycle(repsOverride || []);
    const projectId = cfg.project_id || null;

    const preview = datetimes.map((dt, i) => ({
      slot_datetime: dt.toISOString(),
      duration_minutes: slotMin,
      representative_name: reps.length ? reps[i % reps.length] : null,
      campaign_id: campaignId, project_id: projectId
    }));

    if (dry_run) {
      return res.json({
        dry_run: true, total: preview.length,
        from: fromDate.toISOString().substring(0, 10),
        to: toDate.toISOString().substring(0, 10),
        slot_duration_minutes: slotMin, buffer_minutes: bufferMin,
        windows_used: windows, preview: preview.slice(0, 20),
        note: preview.length > 20 ? `...and ${preview.length - 20} more` : null
      });
    }

    let inserted = 0, skipped = 0;
    for (const slot of preview) {
      const repId = slot.representative_name ? `${campaignId}:${slot.representative_name}` : null;
      try {
        await pool.query(
          `INSERT INTO meeting_slots
             (campaign_id, project_id, meeting_type, slot_datetime, duration_minutes,
              representative_id, representative_name, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open')
           ON CONFLICT (campaign_id, representative_id, slot_datetime) DO NOTHING`,
          [campaignId, projectId, cfg.meeting_type || 'consultation', slot.slot_datetime, slotMin, repId, slot.representative_name]
        );
        inserted++;
      } catch (e) { skipped++; }
    }

    res.json({
      success: true, inserted, skipped, total: preview.length,
      from: fromDate.toISOString().substring(0, 10),
      to: toDate.toISOString().substring(0, 10),
      slot_duration_minutes: slotMin, buffer_minutes: bufferMin, windows_used: windows,
      message: `נוצרו ${inserted} slots עבור קמפיין ${campaignId}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/campaign/:campaignId/slots/preview', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { from, to } = req.query;
    const configRes = await pool.query(`SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [campaignId]);
    if (!configRes.rows.length) return res.status(404).json({ error: 'No config' });
    const cfg = configRes.rows[0];
    const daysAhead = cfg.generate_days_ahead || 30;
    const fromDate = from ? new Date(from) : new Date();
    const toDate   = to   ? new Date(to)   : new Date(Date.now() + daysAhead * 86400000);
    const windows  = cfg.available_windows?.length ? cfg.available_windows : [0,1,2,3,4].map(d => ({ day: d, start: '09:00', end: '18:00' }));
    const slotMin   = parseInt(cfg.slot_duration_minutes) || 45;
    const bufferMin = parseInt(cfg.buffer_minutes) || 15;
    const datetimes = buildSlotDatetimes(windows, fromDate, toDate, slotMin, bufferMin);
    res.json({
      total: datetimes.length, slot_duration_minutes: slotMin, buffer_minutes: bufferMin,
      windows_used: windows,
      from: fromDate.toISOString().substring(0, 10),
      to: toDate.toISOString().substring(0, 10),
      slots: datetimes.slice(0, 50).map(d => d.toISOString())
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/campaign/:campaignId/slots', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required (?from=YYYY-MM-DD&to=YYYY-MM-DD)' });
    const result = await pool.query(
      `DELETE FROM meeting_slots WHERE campaign_id=$1 AND status='open' AND slot_datetime::date BETWEEN $2::date AND $3::date RETURNING id`,
      [campaignId, from, to]
    );
    res.json({ success: true, deleted: result.rowCount, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BROADCAST ─────────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { campaignId, contacts } = req.body;
    const config = await pool.query(`SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [campaignId]);
    if (!config.rows.length) return res.status(400).json({ error: 'Campaign config not found' });
    const cfg = config.rows[0];
    let sent = 0, failed = 0;
    for (const contact of contacts) {
      try {
        const lang = contact.language || cfg.wa_language || 'he';
        await inforuService.sendWhatsApp(contact.phone, buildInitialMessage(contact, cfg, lang));
        sent++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[Broadcast] Failed for ${contact.phone}:`, e.message);
        failed++;
      }
    }
    res.json({ sent, failed, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildInitialMessage(contact, cfg, lang) {
  const template = cfg.wa_initial_template;
  if (template) return template.replace('{name}', contact.name).replace('{campaign}', cfg.zoho_campaign_id);
  const types = {
    he: { consultation:'פגישת ייעוץ', appraiser:'ביקור שמאי', signing_ceremony:'כנס חתימות', physical:'פגישה פיזית', surveyor:'ביקור מודד' },
    ru: { consultation:'консультация', appraiser:'визит оценщика', signing_ceremony:'церемония подписания', physical:'встреча в офисе', surveyor:'визит геодезиста' }
  };
  const typeLabel = (types[lang] || types.he)[cfg.meeting_type] || cfg.meeting_type;
  if (lang === 'ru') return `Здравствуйте, ${contact.name} 👋\n\nQUANTUM на связи.\n\nГотовы назначить *${typeLabel}* для вашей квартиры.\n\nНажмите *1* и мы запишем вас прямо сейчас.`;
  return `שלום ${contact.name} 👋\n\nQUANTUM כאן.\n\nאנחנו מוכנים לתאם *${typeLabel}* עבור דירתך.\n\nענה/י *1* ונתאם עכשיו.`;
}

// ══════════════════════════════════════════════════════════════
// CEREMONY MANAGEMENT
// ══════════════════════════════════════════════════════════════

router.post('/ceremony', async (req, res) => {
  try {
    const {
      project_id, zoho_campaign_id, name,
      ceremony_date, start_time, end_time,
      slot_duration_minutes, break_duration_minutes,
      location, buildings
    } = req.body;

    const cermRes = await pool.query(
      `INSERT INTO signing_ceremonies
         (project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
          slot_duration_minutes, break_duration_minutes, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
       slot_duration_minutes || 15, break_duration_minutes || 0, location]
    );
    const ceremonyId = cermRes.rows[0].id;
    const buildingResults = [];

    for (const [idx, bld] of (buildings || []).entries()) {
      const stationCount = parseInt(bld.station_count) || 1;
      const bldRes = await pool.query(
        `INSERT INTO ceremony_buildings (ceremony_id, building_address, building_label, display_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [ceremonyId, bld.address, bld.label || bld.address, bld.display_order ?? idx]
      );
      const buildingId = bldRes.rows[0].id;
      let slotsCreated = 0;

      for (let n = 1; n <= stationCount; n++) {
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations (building_id, station_number, representative_name, representative_role, is_active)
           VALUES ($1,$2,$3,'עורך דין',true) RETURNING id`,
          [buildingId, n, `עמדה ${n}`]
        );
        slotsCreated += await generateCeremonySlots(
          ceremonyId, stRes.rows[0].id, ceremony_date, start_time, end_time,
          slot_duration_minutes || 15, break_duration_minutes || 0
        );
      }
      buildingResults.push({ buildingId, address: bld.address, label: bld.label || bld.address, station_count: stationCount, slots_created: slotsCreated });
    }

    res.json({ success: true, ceremonyId, buildings: buildingResults });
  } catch (err) {
    console.error('[Ceremony POST] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function generateCeremonySlots(ceremonyId, stationId, date, startTime, endTime, slotMin, breakMin) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;
  const step = slotMin + breakMin;
  let count = 0;
  for (let m = startMins; m + slotMin <= endMins; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    await pool.query(
      `INSERT INTO ceremony_slots (station_id, ceremony_id, slot_time, slot_date, duration_minutes)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [stationId, ceremonyId, `${hh}:${mm}`, date, slotMin]
    );
    count++;
  }
  return count;
}

router.post('/ceremony/:id/assign', async (req, res) => {
  try {
    const ceremonyId = parseInt(req.params.id);
    const { assignments, zoho_campaign_id } = req.body;
    if (!assignments?.length) return res.status(400).json({ error: 'assignments[] required' });

    let addressToId = {};
    if (assignments.some(a => !a.building_id && a.building_address)) {
      const bldRes = await pool.query(`SELECT id, building_address FROM ceremony_buildings WHERE ceremony_id=$1`, [ceremonyId]);
      for (const row of bldRes.rows) addressToId[row.building_address] = row.id;
    }

    let assigned = 0, skipped = 0;
    for (const a of assignments) {
      const buildingId = a.building_id || addressToId[a.building_address];
      const campaignId = zoho_campaign_id || a.zoho_campaign_id;
      if (!buildingId || !campaignId) { skipped++; continue; }
      await pool.query(
        `INSERT INTO bot_sessions (phone, zoho_campaign_id, ceremony_building_id, state, context)
         VALUES ($1,$2,$3,'confirm_identity','{}')
         ON CONFLICT (phone, zoho_campaign_id) DO UPDATE SET ceremony_building_id=EXCLUDED.ceremony_building_id`,
        [a.phone, campaignId, buildingId]
      );
      assigned++;
    }
    res.json({ success: true, assigned, skipped, total: assignments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ceremony/:id/buildings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cb.id, cb.building_address, cb.building_label, cb.display_order,
              COUNT(DISTINCT cst.id) AS station_count,
              COUNT(cs.id) AS total_slots,
              COUNT(cs.id) FILTER (WHERE cs.status='open') AS open_slots,
              COUNT(cs.id) FILTER (WHERE cs.status='confirmed') AS confirmed_slots
       FROM ceremony_buildings cb
       LEFT JOIN ceremony_stations cst ON cst.building_id=cb.id AND cst.is_active=true
       LEFT JOIN ceremony_slots cs ON cs.station_id=cst.id
       WHERE cb.ceremony_id=$1
       GROUP BY cb.id, cb.building_address, cb.building_label, cb.display_order
       ORDER BY cb.display_order, cb.id`,
      [req.params.id]
    );
    res.json({ buildings: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/ceremony/:id/buildings/:buildingId', async (req, res) => {
  try {
    const ceremonyId = parseInt(req.params.id);
    const buildingId = parseInt(req.params.buildingId);
    const { station_count } = req.body;
    if (!station_count || station_count < 1) return res.status(400).json({ error: 'station_count must be >= 1' });

    const cermRes = await pool.query(
      `SELECT ceremony_date, start_time, end_time, slot_duration_minutes, break_duration_minutes FROM signing_ceremonies WHERE id=$1`, [ceremonyId]
    );
    if (!cermRes.rows.length) return res.status(404).json({ error: 'Ceremony not found' });
    const { ceremony_date, start_time, end_time, slot_duration_minutes, break_duration_minutes } = cermRes.rows[0];

    const currentRes = await pool.query(
      `SELECT id, station_number FROM ceremony_stations WHERE building_id=$1 AND is_active=true ORDER BY station_number`, [buildingId]
    );
    const currentCount = currentRes.rows.length;

    if (station_count > currentCount) {
      for (let n = currentCount + 1; n <= station_count; n++) {
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations (building_id, station_number, representative_name, representative_role, is_active)
           VALUES ($1,$2,$3,'עורך דין',true) RETURNING id`,
          [buildingId, n, `עמדה ${n}`]
        );
        await generateCeremonySlots(ceremonyId, stRes.rows[0].id, ceremony_date, start_time.substring(0,5), end_time.substring(0,5), slot_duration_minutes, break_duration_minutes);
      }
    } else if (station_count < currentCount) {
      for (const st of currentRes.rows.slice(station_count)) {
        const hasConfirmed = await pool.query(`SELECT 1 FROM ceremony_slots WHERE station_id=$1 AND status='confirmed' LIMIT 1`, [st.id]);
        if (!hasConfirmed.rows.length) await pool.query(`UPDATE ceremony_stations SET is_active=false WHERE id=$1`, [st.id]);
      }
    }

    res.json({ success: true, station_count, previous: currentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ceremony/:id/slots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cb.building_address, cb.building_label, cst.station_number, cst.representative_name,
              cs.id AS slot_id, cs.slot_time, cs.slot_date, cs.status, cs.contact_name, cs.contact_phone
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id=cst.id
       JOIN ceremony_buildings cb ON cst.building_id=cb.id
       WHERE cs.ceremony_id=$1
       ORDER BY cb.display_order, cst.station_number, cs.slot_time`,
      [req.params.id]
    );
    res.json({ slots: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STATS ──────────────────────────────────────────────────────
router.get('/campaign/:campaignId/stats', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const [botStats, reminderStats, slotStats, optimStats] = await Promise.all([
      pool.query(`SELECT state, COUNT(*) FROM bot_sessions WHERE zoho_campaign_id=$1 GROUP BY state`, [campaignId]),
      pool.query(`SELECT reminder_type, status, COUNT(*) FROM reminder_queue WHERE zoho_campaign_id=$1 GROUP BY reminder_type, status`, [campaignId]),
      pool.query(`SELECT status, COUNT(*) FROM meeting_slots WHERE campaign_id=$1 GROUP BY status`, [campaignId]),
      pool.query(`SELECT status, COUNT(*), AVG(gap_saved_minutes) AS avg_gap FROM reschedule_requests WHERE campaign_id=$1 GROUP BY status`, [campaignId])
    ]);
    res.json({ botSessions: botStats.rows, reminders: reminderStats.rows, meetingSlots: slotStats.rows, optimization: optimStats.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FULL CAMPAIGN REPORT ──────────────────────────────────────
router.get('/campaign/:campaignId/report', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const format = req.query.format || 'html';
    const configRes = await pool.query(
      `SELECT csc.*, p.name AS project_name FROM campaign_schedule_config csc LEFT JOIN projects p ON csc.project_id=p.id WHERE csc.zoho_campaign_id=$1`, [campaignId]
    );
    const config = configRes.rows[0] || {};

    const [sessionsRes, confirmedRes, slotsRes, timelineRes, repsRes, optimRes] = await Promise.all([
      pool.query(`SELECT state, COUNT(*) AS total, COUNT(CASE WHEN language='ru' THEN 1 END) AS russian, COUNT(CASE WHEN language='he' THEN 1 END) AS hebrew FROM bot_sessions WHERE zoho_campaign_id=$1 GROUP BY state ORDER BY total DESC`, [campaignId]),
      pool.query(`SELECT bs.phone, bs.language, bs.context->>'contactName' AS name, ms.slot_datetime, TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','DD/MM/YYYY') AS date_str, TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time_str, ms.representative_name AS rep FROM bot_sessions bs JOIN meeting_slots ms ON ms.contact_phone=bs.phone AND ms.campaign_id=bs.zoho_campaign_id WHERE bs.zoho_campaign_id=$1 AND bs.state='confirmed' ORDER BY ms.slot_datetime`, [campaignId]),
      pool.query(`SELECT COUNT(*) AS total_slots, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed, COUNT(CASE WHEN status='open' THEN 1 END) AS open, COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled FROM meeting_slots WHERE campaign_id=$1`, [campaignId]),
      pool.query(`SELECT DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem') AS day, TO_CHAR(DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem'),'DD/MM') AS label, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed FROM meeting_slots WHERE campaign_id=$1 GROUP BY day, label ORDER BY day`, [campaignId]),
      pool.query(`SELECT representative_name AS rep, COUNT(*) AS total, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed FROM meeting_slots WHERE campaign_id=$1 GROUP BY representative_name ORDER BY confirmed DESC`, [campaignId]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='accepted') AS swapped, COUNT(*) FILTER (WHERE status='declined') AS declined, COUNT(*) FILTER (WHERE status='pending') AS pending, ROUND(AVG(gap_saved_minutes) FILTER (WHERE status='accepted')) AS avg_gap_saved FROM reschedule_requests WHERE campaign_id=$1`, [campaignId])
    ]);

    const optim = optimRes.rows[0] || {};
    const sessions = sessionsRes.rows;
    const totalSent = sessions.reduce((a, b) => a + parseInt(b.total), 0);
    const totalAnswered = sessions.filter(s => s.state !== 'confirm_identity').reduce((a, b) => a + parseInt(b.total), 0);
    const totalConfirmed = parseInt(sessions.find(s => s.state === 'confirmed')?.total || 0);
    const totalDeclined  = parseInt(sessions.find(s => s.state === 'closed' || s.state === 'ceremony_declined')?.total || 0);
    const slots = slotsRes.rows[0] || {};
    const slotUtil = slots.total_slots > 0 ? Math.round((slots.confirmed / slots.total_slots) * 100) : 0;
    const responseRate   = totalSent     > 0 ? Math.round((totalAnswered   / totalSent)     * 100) : 0;
    const conversionRate = totalAnswered > 0 ? Math.round((totalConfirmed  / totalAnswered)  * 100) : 0;

    const data = {
      campaignId, projectName: config.project_name || campaignId, meetingType: config.meeting_type || 'meeting',
      generatedAt: new Date().toISOString(),
      summary: { totalSent, totalAnswered, totalConfirmed, totalDeclined, responseRate, conversionRate, slotUtil, totalSlots: parseInt(slots.total_slots || 0), openSlots: parseInt(slots.open || 0) },
      optimization: optim, funnel: sessions, confirmedMeetings: confirmedRes.rows, timeline: timelineRes.rows, reps: repsRes.rows
    };

    if (format === 'json') return res.json(data);

    const confirmedRows  = confirmedRes.rows.map(m => `<tr><td>${m.name||m.phone}</td><td>${m.phone}</td><td>${m.date_str}</td><td>${m.time_str}</td><td>${m.rep||'-'}</td><td>${m.language==='ru'?'🇷🇺':'🇮🇱'}</td></tr>`).join('');
    const timelineBars   = timelineRes.rows.map(t => { const pct=Math.min(100,Math.round((t.confirmed/Math.max(1,totalConfirmed))*100)); return `<div style="margin:4px 0;display:flex;align-items:center;gap:8px"><span style="width:40px;font-size:12px;color:#666">${t.label}</span><div style="background:#d1fae5;width:${pct}%;max-width:200px;height:18px;border-radius:3px;display:flex;align-items:center;padding:0 6px;font-size:11px">${t.confirmed}</div></div>`; }).join('');
    const repRows        = repsRes.rows.map(r => `<tr><td>${r.rep}</td><td>${r.total}</td><td>${r.confirmed}</td><td>${r.total>0?Math.round(r.confirmed/r.total*100):0}%</td></tr>`).join('');

    res.type('text/html').send(`<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>דוח קמפיין QUANTUM - ${data.projectName}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#0a0a0f;color:#e2e8f0;direction:rtl}.header{background:linear-gradient(135deg,#1e3a5f,#0d1b2e);padding:32px 24px;border-bottom:1px solid #1e40af44}.logo{font-size:13px;letter-spacing:4px;color:#60a5fa;text-transform:uppercase;margin-bottom:8px}h1{font-size:22px;color:#f1f5f9;font-weight:700}.meta{font-size:12px;color:#94a3b8;margin-top:6px}.container{max-width:960px;margin:0 auto;padding:24px 16px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}.kpi{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center}.kpi-val{font-size:28px;font-weight:800}.kpi-val.green{color:#34d399}.kpi-val.blue{color:#60a5fa}.kpi-val.yellow{color:#fbbf24}.kpi-val.red{color:#f87171}.kpi-label{font-size:11px;color:#64748b;margin-top:4px}.section{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:16px 0}.section h2{font-size:14px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px;border-bottom:1px solid #1e293b;padding-bottom:10px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:right;padding:8px 10px;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:1px;background:#0f172a}td{padding:9px 10px;border-bottom:1px solid #1e293b}tr:last-child td{border-bottom:none}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}.badge-green{background:#064e3b;color:#34d399}.badge-blue{background:#1e3a5f;color:#60a5fa}</style>
</head><body>
<div class="header"><div class="logo">⚡ QUANTUM Intelligence</div><h1>דוח קמפיין: ${data.projectName}</h1><div class="meta">סוג: ${data.meetingType} | נוצר: ${new Date(data.generatedAt).toLocaleString('he-IL')} | <a href="?format=json" style="color:#60a5fa">JSON</a></div></div>
<div class="container">
<div class="kpis">
  <div class="kpi"><div class="kpi-val blue">${data.summary.totalSent}</div><div class="kpi-label">נשלחו</div></div>
  <div class="kpi"><div class="kpi-val yellow">${data.summary.totalAnswered}</div><div class="kpi-label">ענו</div></div>
  <div class="kpi"><div class="kpi-val green">${data.summary.totalConfirmed}</div><div class="kpi-label">נקבעו</div></div>
  <div class="kpi"><div class="kpi-val red">${data.summary.totalDeclined}</div><div class="kpi-label">סירבו</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.responseRate>=60?'green':'yellow'}">${data.summary.responseRate}%</div><div class="kpi-label">מענה</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.conversionRate>=50?'green':'yellow'}">${data.summary.conversionRate}%</div><div class="kpi-label">המרה</div></div>
  <div class="kpi"><div class="kpi-val blue">${data.summary.openSlots}</div><div class="kpi-label">פנויים</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.slotUtil>=70?'green':'yellow'}">${data.summary.slotUtil}%</div><div class="kpi-label">תפיסה</div></div>
</div>
${timelineRes.rows.length?`<div class="section"><h2>📈 פגישות לפי יום</h2>${timelineBars}</div>`:''}
<div class="section"><h2>✅ פגישות שנקבעו (${data.summary.totalConfirmed})</h2>${confirmedRows?`<table><thead><tr><th>שם</th><th>טלפון</th><th>תאריך</th><th>שעה</th><th>נציג</th><th>שפה</th></tr></thead><tbody>${confirmedRows}</tbody></table>`:'<div style="color:#64748b;font-size:13px;padding:8px 0">אין פגישות</div>'}</div>
${repsRes.rows.length?`<div class="section"><h2>👤 עומס לפי נציג</h2><table><thead><tr><th>נציג</th><th>סה"כ</th><th>נקבעו</th><th>תפיסה</th></tr></thead><tbody>${repRows}</tbody></table></div>`:''}
<div class="section"><h2>🔄 משפך</h2><table><thead><tr><th>שלב</th><th>סה"כ</th><th>עברית</th><th>רוסית</th></tr></thead><tbody>${sessionsRes.rows.map(s=>`<tr><td><span class="badge ${s.state==='confirmed'?'badge-green':'badge-blue'}">${s.state}</span></td><td>${s.total}</td><td>${s.hebrew||0}</td><td>${s.russian||0}</td></tr>`).join('')}</tbody></table></div>
</div></body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar management routes ──────────────────────────────────
// Imported from calendarRoutes.js via index.js
// (see: GET/POST /api/scheduling/calendar/*)

module.exports = router;
