/**
 * מינהלת Calendar Management Routes
 *
 * Google Calendar:
 * GET  /api/scheduling/calendar/status              - Check GCal config
 * GET  /api/scheduling/calendar/test?calendarId=    - Test GCal access
 * POST /api/scheduling/calendar/set-project         - Set google_calendar_id on project
 * POST /api/scheduling/calendar/test-event          - Create a test GCal event
 *
 * Ceremony Calendars (one calendar per building):
 * POST   /api/scheduling/calendar/ceremony/:id/create-calendars
 * GET    /api/scheduling/calendar/ceremony/:id/calendars
 * DELETE /api/scheduling/calendar/ceremony/:id/delete-calendars
 *
 * Table structure:
 *   ceremony_buildings: id, ceremony_id, building_address, building_label, display_order
 *   ceremony_stations:  id, building_id, station_number, google_calendar_id, zoho_calendar_id
 *
 * Zoho Calendar:
 * GET  /api/scheduling/calendar/zoho/status
 * GET  /api/scheduling/calendar/zoho/list
 * POST /api/scheduling/calendar/zoho/set-project
 * GET  /api/scheduling/calendar/zoho/test?calendarId=
 * POST /api/scheduling/calendar/zoho/test-event
 *
 * Scheduling Projects:
 * GET    /api/scheduling/calendar/projects
 * POST   /api/scheduling/calendar/projects
 * DELETE /api/scheduling/calendar/projects/:id
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

let gcalService;
try {
  gcalService = require('../services/googleCalendarService');
} catch (e) {
  logger.warn('[CalendarRoutes] googleCalendarService not available:', e.message);
}

let zcalService;
try {
  zcalService = require('../services/zohoCalendarService');
} catch (e) {
  logger.warn('[CalendarRoutes] zohoCalendarService not available:', e.message);
}

// ════════════════════════════════════════════════════════════
// GOOGLE CALENDAR — BASIC
// ════════════════════════════════════════════════════════════

router.get('/status', async (req, res) => {
  const configured = gcalService?.isConfigured() || false;
  const email = process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || null;

  let projects = [];
  try {
    const r = await pool.query(
      `SELECT id, name, google_calendar_id
       FROM projects
       WHERE google_calendar_id IS NOT NULL AND google_calendar_id != ''
       ORDER BY name`
    );
    projects = r.rows;
  } catch (e) { /* ok */ }

  res.json({
    configured,
    service_account: email,
    projects_with_calendar: projects.length,
    projects,
    setup_hint: configured
      ? null
      : 'Set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY on Railway, then share your calendar with the service account email'
  });
});

router.get('/test', async (req, res) => {
  const { calendarId } = req.query;
  if (!calendarId) {
    return res.status(400).json({ error: 'calendarId query param required. Example: ?calendarId=primary' });
  }
  if (!gcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Google Calendar not configured.' });
  }
  const result = await gcalService.testCalendarAccess(calendarId);
  res.json(result);
});

router.post('/set-project', async (req, res) => {
  const { projectId, calendarId } = req.body;
  if (!projectId || !calendarId) return res.status(400).json({ error: 'projectId and calendarId required' });
  try {
    let accessOk = false;
    if (gcalService?.testCalendarAccess) {
      const test = await gcalService.testCalendarAccess(calendarId);
      accessOk = test.ok;
    }
    await pool.query(`UPDATE projects SET google_calendar_id = $1 WHERE id = $2`, [calendarId, projectId]);
    const proj = await pool.query(`SELECT id, name, google_calendar_id FROM projects WHERE id = $1`, [projectId]);
    res.json({
      success: true, project: proj.rows[0], calendar_accessible: accessOk,
      warning: !accessOk ? `Could not verify access to calendar "${calendarId}". Share with ${process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL}` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-event', async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });
  if (!gcalService?.isConfigured()) return res.status(503).json({ ok: false, error: 'Google Calendar not configured' });
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const eventId = await gcalService.createEvent(calendarId, {
    title: '🧪 מינהלת - בדיקת חיבור לוח שנה',
    startDatetime: start.toISOString(),
    durationMins: 15,
    description: 'Test event created by מינהלת system. Can be deleted.'
  });
  if (eventId) {
    res.json({ ok: true, eventId, calendarId, message: 'Test event created successfully!' });
  } else {
    res.json({ ok: false, calendarId, message: 'Failed to create event - check service account permissions' });
  }
});

// ════════════════════════════════════════════════════════════
// CEREMONY CALENDARS — one per building
//
// ceremony_buildings: id, ceremony_id, building_address, building_label, display_order
// ceremony_stations:  id, building_id, station_number, google_calendar_id, ...
// ════════════════════════════════════════════════════════════

/**
 * POST /api/scheduling/calendar/ceremony/:ceremonyId/create-calendars
 *
 * Creates one Google Calendar per building in the ceremony.
 * Calendar name: "{building_address} | {DD/MM/YY}"
 * Shares each calendar with CEREMONY_SHARE_EMAIL (default hemi.michaeli@gmail.com).
 * Saves the calendar ID to all ceremony_stations rows of that building.
 *
 * Body (optional): { shareEmail: "someone@gmail.com" }
 */
router.post('/ceremony/:ceremonyId/create-calendars', async (req, res) => {
  const ceremonyId = parseInt(req.params.ceremonyId);
  if (isNaN(ceremonyId)) return res.status(400).json({ error: 'Invalid ceremony ID' });

  if (!gcalService?.isConfigured()) {
    return res.status(503).json({ error: 'Google Calendar not configured on this server' });
  }

  const shareEmail = req.body?.shareEmail
    || process.env.CEREMONY_SHARE_EMAIL
    || 'hemi.michaeli@gmail.com';

  try {
    // Load ceremony info
    const cerRes = await pool.query(
      `SELECT id, name, ceremony_date FROM signing_ceremonies WHERE id = $1`,
      [ceremonyId]
    );
    if (!cerRes.rows.length) return res.status(404).json({ error: 'Ceremony not found' });
    const ceremony = cerRes.rows[0];

    // Format date: DD/MM/YY
    const d = new Date(ceremony.ceremony_date);
    const dateLabel = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)}`;

    // Get all buildings for this ceremony from ceremony_buildings table
    const bldRes = await pool.query(
      `SELECT cb.id AS building_id, cb.building_address, cb.building_label,
              MIN(cst.google_calendar_id) AS existing_calendar_id
       FROM ceremony_buildings cb
       LEFT JOIN ceremony_stations cst ON cst.building_id = cb.id AND cst.google_calendar_id IS NOT NULL
       WHERE cb.ceremony_id = $1
       GROUP BY cb.id, cb.building_address, cb.building_label
       ORDER BY cb.display_order, cb.id`,
      [ceremonyId]
    );

    if (!bldRes.rows.length) {
      return res.status(400).json({ error: 'No buildings found for this ceremony. Create ceremony with buildings first.' });
    }

    const results = [];

    for (const bld of bldRes.rows) {
      const calName = `${bld.building_address} | ${dateLabel}`;

      // Already has a calendar
      if (bld.existing_calendar_id) {
        results.push({
          building: bld.building_address,
          calendar_name: calName,
          calendar_id: bld.existing_calendar_id,
          status: 'already_exists'
        });
        continue;
      }

      // Create new calendar
      const calendarId = await gcalService.createCalendar(calName);
      if (!calendarId) {
        results.push({ building: bld.building_address, calendar_name: calName, status: 'error_creating' });
        continue;
      }

      // Share with the configured email as writer
      await gcalService.shareCalendar(calendarId, shareEmail, 'writer');

      // Save calendar ID to all stations of this building
      await pool.query(
        `UPDATE ceremony_stations SET google_calendar_id = $1 WHERE building_id = $2`,
        [calendarId, bld.building_id]
      );

      results.push({
        building: bld.building_address,
        calendar_name: calName,
        calendar_id: calendarId,
        shared_with: shareEmail,
        status: 'created'
      });

      logger.info(`[CalendarRoutes] Created calendar "${calName}" → ${calendarId}, shared with ${shareEmail}`);
    }

    const created = results.filter(r => r.status === 'created').length;
    const existing = results.filter(r => r.status === 'already_exists').length;

    res.json({
      success: true,
      ceremony_id: ceremonyId,
      ceremony_name: ceremony.name,
      ceremony_date: ceremony.ceremony_date,
      shared_with: shareEmail,
      calendars_created: created,
      calendars_existing: existing,
      buildings: results
    });

  } catch (err) {
    logger.error('[CalendarRoutes] create-calendars error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/scheduling/calendar/ceremony/:ceremonyId/calendars
 * Returns current calendar assignments for a ceremony.
 */
router.get('/ceremony/:ceremonyId/calendars', async (req, res) => {
  const ceremonyId = parseInt(req.params.ceremonyId);
  if (isNaN(ceremonyId)) return res.status(400).json({ error: 'Invalid ceremony ID' });

  try {
    const r = await pool.query(
      `SELECT cb.id AS building_id, cb.building_address, cb.building_label,
              MIN(cst.google_calendar_id) AS google_calendar_id,
              COUNT(cst.id) AS station_count
       FROM ceremony_buildings cb
       LEFT JOIN ceremony_stations cst ON cst.building_id = cb.id AND cst.is_active = true
       WHERE cb.ceremony_id = $1
       GROUP BY cb.id, cb.building_address, cb.building_label
       ORDER BY cb.display_order, cb.id`,
      [ceremonyId]
    );

    res.json({
      ceremony_id: ceremonyId,
      buildings: r.rows,
      share_email: process.env.CEREMONY_SHARE_EMAIL || 'hemi.michaeli@gmail.com'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/scheduling/calendar/ceremony/:ceremonyId/delete-calendars
 * Deletes all Google Calendars associated with a ceremony and clears the IDs from DB.
 */
router.delete('/ceremony/:ceremonyId/delete-calendars', async (req, res) => {
  const ceremonyId = parseInt(req.params.ceremonyId);
  if (isNaN(ceremonyId)) return res.status(400).json({ error: 'Invalid ceremony ID' });

  if (!gcalService?.isConfigured()) {
    return res.status(503).json({ error: 'Google Calendar not configured on this server' });
  }

  try {
    // Get all unique calendar IDs per building for this ceremony
    const calRes = await pool.query(
      `SELECT cb.building_address, MIN(cst.google_calendar_id) AS google_calendar_id, cb.id AS building_id
       FROM ceremony_buildings cb
       JOIN ceremony_stations cst ON cst.building_id = cb.id
       WHERE cb.ceremony_id = $1 AND cst.google_calendar_id IS NOT NULL
       GROUP BY cb.id, cb.building_address`,
      [ceremonyId]
    );

    if (!calRes.rows.length) {
      return res.json({ success: true, message: 'No calendars found for this ceremony', deleted: 0 });
    }

    const results = [];
    for (const row of calRes.rows) {
      const deleted = await gcalService.deleteCalendar(row.google_calendar_id);
      // Clear from all stations of this building
      await pool.query(
        `UPDATE ceremony_stations SET google_calendar_id = NULL WHERE building_id = $1`,
        [row.building_id]
      );
      results.push({ building: row.building_address, calendar_id: row.google_calendar_id, deleted });
    }

    res.json({
      success: true,
      ceremony_id: ceremonyId,
      deleted: results.filter(r => r.deleted).length,
      results
    });

  } catch (err) {
    logger.error('[CalendarRoutes] delete-calendars error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// ZOHO CALENDAR
// ════════════════════════════════════════════════════════════

router.get('/zoho/status', async (req, res) => {
  const configured = zcalService?.isConfigured() || false;
  let projects = [];
  try {
    const r = await pool.query(
      `SELECT id, name, zoho_calendar_id FROM projects WHERE zoho_calendar_id IS NOT NULL AND zoho_calendar_id != '' ORDER BY name`
    );
    projects = r.rows;
  } catch (e) { /* ok */ }
  res.json({
    configured, projects_with_zoho_calendar: projects.length, projects,
    setup_hint: configured ? null : 'ZOHO_CLIENT_ID + ZOHO_REFRESH_TOKEN must be set on Railway. Scope: ZohoCalendar.event.ALL'
  });
});

router.get('/zoho/list', async (req, res) => {
  if (!zcalService?.isConfigured()) return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  try { res.json(await zcalService.listCalendars()); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/zoho/test', async (req, res) => {
  const { calendarId } = req.query;
  if (!calendarId) return res.status(400).json({ error: 'calendarId query param required' });
  if (!zcalService?.isConfigured()) return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  try { res.json(await zcalService.testCalendarAccess(calendarId)); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/zoho/set-project', async (req, res) => {
  const { projectId, calendarId } = req.body;
  if (!projectId || !calendarId) return res.status(400).json({ error: 'projectId and calendarId required' });
  try {
    let accessOk = false;
    if (zcalService?.testCalendarAccess) {
      try { const test = await zcalService.testCalendarAccess(calendarId); accessOk = test.ok; } catch (e) { /* ok */ }
    }
    await pool.query(`UPDATE projects SET zoho_calendar_id = $1 WHERE id = $2`, [calendarId, projectId]);
    const proj = await pool.query(`SELECT id, name, zoho_calendar_id FROM projects WHERE id = $1`, [projectId]);
    res.json({
      success: true, project: proj.rows[0], calendar_accessible: accessOk,
      warning: !accessOk ? `Could not verify access to Zoho Calendar "${calendarId}". Saved anyway.` : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/zoho/test-event', async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });
  if (!zcalService?.isConfigured()) return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  try {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const uid = await zcalService.createEvent(calendarId, {
      title: '🧪 מינהלת - בדיקת לוח שנה Zoho', startDatetime: start.toISOString(),
      durationMins: 15, description: 'Test event created by מינהלת system. Can be deleted.'
    });
    if (uid) { res.json({ ok: true, uid, calendarId, message: 'Zoho Calendar test event created!' }); }
    else { res.json({ ok: false, calendarId, message: 'Failed to create event - check Zoho OAuth token and scope' }); }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ════════════════════════════════════════════════════════════
// SCHEDULING PROJECTS MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get('/projects', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.google_calendar_id, p.zoho_calendar_id, COUNT(csc.id) AS campaign_count
       FROM projects p LEFT JOIN campaign_schedule_config csc ON csc.project_id = p.id
       GROUP BY p.id, p.name, p.google_calendar_id, p.zoho_calendar_id ORDER BY p.name`
    );
    res.json({
      projects: r.rows, total: r.rows.length,
      google_service_account: process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || 'not configured',
      zoho_configured: zcalService?.isConfigured() || false
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id, name, google_calendar_id, zoho_calendar_id`,
      [name.trim()]
    );
    res.json({ success: true, project: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Project "${name.trim()}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/projects/:id', async (req, res) => {
  const projectId = parseInt(req.params.id);
  if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });
  try {
    const campaigns = await pool.query(`SELECT COUNT(*) AS cnt FROM campaign_schedule_config WHERE project_id = $1`, [projectId]);
    if (parseInt(campaigns.rows[0].cnt) > 0) {
      return res.status(409).json({ error: `Cannot delete: project has ${campaigns.rows[0].cnt} campaign(s) linked.` });
    }
    const result = await pool.query(`DELETE FROM projects WHERE id = $1 RETURNING id, name`, [projectId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
