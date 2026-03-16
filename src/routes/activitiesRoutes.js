/**
 * Minhelet Bot — Activities & Professionals API
 * Handles: activities (with Google Calendar), professionals, assignments
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const gcal = require('../services/googleCalendarService');
const crypto = require('crypto');

// ════════════════════════════════════════════════════════════
// ACTIVITIES
// ════════════════════════════════════════════════════════════

// GET /api/activities — list all activities
router.get('/', async (req, res) => {
  try {
    const { status } = req.query; // optional: active | archived
    const whereClause = status ? `WHERE a.status = $1` : '';
    const params = status ? [status] : [];
    const r = await pool.query(`
      SELECT
        a.*,
        COUNT(DISTINCT aa.professional_id) AS professional_count,
        COUNT(DISTINCT aa.building_id) AS building_count
      FROM activities a
      LEFT JOIN activity_assignments aa ON aa.activity_id = a.id
      ${whereClause}
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `, params);
    res.json({ activities: r.rows, total: r.rows.length });
  } catch (err) {
    logger.error('[Activities] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activities/:id — get single activity with assignments
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const actRes = await pool.query(`SELECT * FROM activities WHERE id = $1`, [id]);
    if (!actRes.rows.length) return res.status(404).json({ error: 'Activity not found' });

    const assignRes = await pool.query(`
      SELECT
        aa.*,
        p.name AS professional_name,
        p.type AS professional_type,
        p.phone_number AS professional_phone,
        p.email AS professional_email,
        p.dashboard_token AS professional_token
      FROM activity_assignments aa
      JOIN professionals p ON p.id = aa.professional_id
      WHERE aa.activity_id = $1
      ORDER BY p.name, aa.building_id
    `, [id]);

    res.json({ activity: actRes.rows[0], assignments: assignRes.rows });
  } catch (err) {
    logger.error('[Activities] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activities — create new activity + Google Calendar
router.post('/', async (req, res) => {
  const { name, type } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

  const validTypes = ['signing', 'appraisal', 'measurement', 'other'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

  try {
    // Create Google Calendar for this activity
    let googleCalendarId = null;
    if (gcal.isConfigured()) {
      try {
        const calName = `מינהלת — ${name}`;
        googleCalendarId = await gcal.createCalendar(calName);
        logger.info(`[Activities] Created Google Calendar: ${googleCalendarId} for activity: ${name}`);
      } catch (calErr) {
        logger.warn(`[Activities] Could not create Google Calendar: ${calErr.message}`);
      }
    }

    const r = await pool.query(`
      INSERT INTO activities (name, type, google_calendar_id, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING *
    `, [name.trim(), type, googleCalendarId]);

    res.status(201).json({ success: true, activity: r.rows[0], calendar_created: !!googleCalendarId });
  } catch (err) {
    logger.error('[Activities] POST / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/activities/:id — update activity name/type
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { name, type } = req.body;
  try {
    const updates = [];
    const params = [];
    if (name) { updates.push(`name = $${params.length + 1}`); params.push(name.trim()); }
    if (type) { updates.push(`type = $${params.length + 1}`); params.push(type); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const r = await pool.query(
      `UPDATE activities SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Activity not found' });
    res.json({ success: true, activity: r.rows[0] });
  } catch (err) {
    logger.error('[Activities] PATCH /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activities/:id/archive — archive an activity
router.post('/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(
      `UPDATE activities SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Activity not found' });
    res.json({ success: true, activity: r.rows[0], message: 'Activity archived successfully' });
  } catch (err) {
    logger.error('[Activities] POST /:id/archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activities/:id/restore — restore archived activity
router.post('/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(
      `UPDATE activities SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Activity not found' });
    res.json({ success: true, activity: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activities/:id — permanently delete
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const act = await pool.query(`SELECT * FROM activities WHERE id = $1`, [id]);
    if (!act.rows.length) return res.status(404).json({ error: 'Activity not found' });

    // Optionally delete the Google Calendar
    if (act.rows[0].google_calendar_id && gcal.isConfigured()) {
      try { await gcal.deleteCalendar(act.rows[0].google_calendar_id); } catch (e) { /* ignore */ }
    }

    await pool.query(`DELETE FROM activities WHERE id = $1`, [id]);
    res.json({ success: true, deleted: act.rows[0] });
  } catch (err) {
    logger.error('[Activities] DELETE /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PROFESSIONALS
// ════════════════════════════════════════════════════════════

// GET /api/activities/professionals/list — list all professionals
router.get('/professionals/list', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*,
        COUNT(DISTINCT aa.activity_id) AS activity_count,
        COUNT(DISTINCT aa.building_id) AS building_count
      FROM professionals p
      LEFT JOIN activity_assignments aa ON aa.professional_id = p.id
      GROUP BY p.id
      ORDER BY p.type, p.name
    `);
    res.json({ professionals: r.rows, total: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activities/professionals — create professional
router.post('/professionals', async (req, res) => {
  const { name, type, phone_number, email } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const validTypes = ['appraiser', 'surveyor', 'lawyer', 'other'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  try {
    // Generate a unique dashboard token
    const token = crypto.randomBytes(20).toString('hex');
    const r = await pool.query(`
      INSERT INTO professionals (name, type, phone_number, email, dashboard_token)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name.trim(), type, phone_number || null, email || null, token]);
    res.status(201).json({ success: true, professional: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/activities/professionals/:id — update professional
router.patch('/professionals/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { name, type, phone_number, email } = req.body;
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push(`name = $${params.length + 1}`); params.push(name.trim()); }
    if (type !== undefined) { updates.push(`type = $${params.length + 1}`); params.push(type); }
    if (phone_number !== undefined) { updates.push(`phone_number = $${params.length + 1}`); params.push(phone_number); }
    if (email !== undefined) { updates.push(`email = $${params.length + 1}`); params.push(email); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const r = await pool.query(
      `UPDATE professionals SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Professional not found' });
    res.json({ success: true, professional: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activities/professionals/:id
router.delete('/professionals/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM professionals WHERE id = $1 RETURNING *`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Professional not found' });
    res.json({ success: true, deleted: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// ASSIGNMENTS (activity ↔ professional ↔ building)
// ════════════════════════════════════════════════════════════

// POST /api/activities/:id/assign — assign professional to building in activity
router.post('/:id/assign', async (req, res) => {
  const activityId = parseInt(req.params.id);
  if (isNaN(activityId)) return res.status(400).json({ error: 'Invalid activity id' });
  const { professional_id, building_id } = req.body;
  if (!professional_id || !building_id) return res.status(400).json({ error: 'professional_id and building_id required' });
  try {
    const r = await pool.query(`
      INSERT INTO activity_assignments (activity_id, professional_id, building_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (activity_id, professional_id, building_id) DO NOTHING
      RETURNING *
    `, [activityId, professional_id, building_id]);
    res.status(201).json({ success: true, assignment: r.rows[0] || 'already exists' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activities/:id/assign — remove assignment
router.delete('/:id/assign', async (req, res) => {
  const activityId = parseInt(req.params.id);
  const { professional_id, building_id } = req.body;
  try {
    await pool.query(`
      DELETE FROM activity_assignments
      WHERE activity_id = $1 AND professional_id = $2 AND building_id = $3
    `, [activityId, professional_id, building_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activities/:id/auto-assign — auto-assign professionals to buildings evenly
router.post('/:id/auto-assign', async (req, res) => {
  const activityId = parseInt(req.params.id);
  if (isNaN(activityId)) return res.status(400).json({ error: 'Invalid activity id' });
  const { professional_ids, building_ids } = req.body;
  if (!professional_ids?.length || !building_ids?.length) {
    return res.status(400).json({ error: 'professional_ids and building_ids arrays required' });
  }
  try {
    // Round-robin assignment: distribute buildings evenly across professionals
    const assignments = [];
    building_ids.forEach((buildingId, index) => {
      const professionalId = professional_ids[index % professional_ids.length];
      assignments.push({ activityId, professionalId, buildingId });
    });

    // Insert all assignments
    const inserted = [];
    for (const a of assignments) {
      const r = await pool.query(`
        INSERT INTO activity_assignments (activity_id, professional_id, building_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (activity_id, professional_id, building_id) DO NOTHING
        RETURNING *
      `, [a.activityId, a.professionalId, a.buildingId]);
      if (r.rows.length) inserted.push(r.rows[0]);
    }

    res.json({
      success: true,
      assigned: inserted.length,
      total_buildings: building_ids.length,
      total_professionals: professional_ids.length,
      assignments: inserted
    });
  } catch (err) {
    logger.error('[Activities] auto-assign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PROFESSIONAL DASHBOARD (public token-based access)
// ════════════════════════════════════════════════════════════

// GET /api/activities/dashboard/:token — get professional's schedule
router.get('/dashboard/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const profRes = await pool.query(
      `SELECT id, name, type, phone_number, email FROM professionals WHERE dashboard_token = $1`,
      [token]
    );
    if (!profRes.rows.length) return res.status(404).json({ error: 'Dashboard not found' });
    const prof = profRes.rows[0];

    // Get all assignments for this professional across active activities
    const assignRes = await pool.query(`
      SELECT
        aa.building_id,
        a.id AS activity_id,
        a.name AS activity_name,
        a.type AS activity_type,
        a.google_calendar_id,
        a.status AS activity_status
      FROM activity_assignments aa
      JOIN activities a ON a.id = aa.activity_id
      WHERE aa.professional_id = $1 AND a.status = 'active'
      ORDER BY a.name, aa.building_id
    `, [prof.id]);

    // Get appointments for this professional's buildings
    const buildingIds = assignRes.rows.map(r => r.building_id);
    let appointments = [];
    if (buildingIds.length > 0) {
      const apptRes = await pool.query(`
        SELECT
          ap.id,
          ap.contact_name,
          ap.contact_phone,
          ap.slot_datetime,
          ap.status,
          ap.building_id,
          ap.apartment_number,
          ap.notes
        FROM appointments ap
        WHERE ap.building_id = ANY($1::text[])
          AND ap.slot_datetime >= NOW() - INTERVAL '7 days'
        ORDER BY ap.slot_datetime ASC
      `, [buildingIds]);
      appointments = apptRes.rows;
    }

    res.json({
      professional: prof,
      assignments: assignRes.rows,
      appointments,
      dashboard_url: `${process.env.BASE_URL || ''}/dashboard/${token}`
    });
  } catch (err) {
    logger.error('[Activities] dashboard/:token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/activities/dashboard/:token/appointment/:apptId — update appointment status
router.patch('/dashboard/:token/appointment/:apptId', async (req, res) => {
  const { token, apptId } = req.params;
  const { status } = req.body;
  const validStatuses = ['arrived', 'no-show', 'rescheduled', 'confirmed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    // Verify token belongs to a professional who has this building
    const profRes = await pool.query(
      `SELECT id FROM professionals WHERE dashboard_token = $1`, [token]
    );
    if (!profRes.rows.length) return res.status(403).json({ error: 'Unauthorized' });

    const r = await pool.query(`
      UPDATE appointments SET status = $1, updated_at = NOW()
      WHERE id = $2 RETURNING *
    `, [status, apptId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ success: true, appointment: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// SCHEDULE LINKS — generate shareable links per professional
// ════════════════════════════════════════════════════════════

// GET /api/activities/:id/schedule-links — get all professional dashboard links for activity
router.get('/:id/schedule-links', async (req, res) => {
  const activityId = parseInt(req.params.id);
  if (isNaN(activityId)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`
      SELECT DISTINCT
        p.id,
        p.name,
        p.type,
        p.phone_number,
        p.dashboard_token,
        COUNT(aa.building_id) AS building_count,
        ARRAY_AGG(aa.building_id ORDER BY aa.building_id) AS buildings
      FROM activity_assignments aa
      JOIN professionals p ON p.id = aa.professional_id
      WHERE aa.activity_id = $1
      GROUP BY p.id, p.name, p.type, p.phone_number, p.dashboard_token
      ORDER BY p.type, p.name
    `, [activityId]);

    const baseUrl = process.env.BASE_URL || 'https://minhelet-bot-production.up.railway.app';
    const links = r.rows.map(p => ({
      ...p,
      dashboard_url: `${baseUrl}/professional-dashboard.html?token=${p.dashboard_token}`
    }));

    res.json({ links, total: links.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PRINT / SCHEDULE VIEW
// ════════════════════════════════════════════════════════════

// GET /api/activities/:id/schedule — get full schedule for printing
router.get('/:id/schedule', async (req, res) => {
  const activityId = parseInt(req.params.id);
  const { filter_by, filter_value } = req.query; // filter_by: building_id | professional_id
  if (isNaN(activityId)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const actRes = await pool.query(`SELECT * FROM activities WHERE id = $1`, [activityId]);
    if (!actRes.rows.length) return res.status(404).json({ error: 'Activity not found' });

    let apptQuery = `
      SELECT
        ap.id,
        ap.contact_name,
        ap.contact_phone,
        ap.slot_datetime,
        ap.status,
        ap.building_id,
        ap.apartment_number,
        ap.notes,
        p.name AS professional_name,
        p.type AS professional_type
      FROM appointments ap
      LEFT JOIN activity_assignments aa ON aa.building_id = ap.building_id AND aa.activity_id = $1
      LEFT JOIN professionals p ON p.id = aa.professional_id
      WHERE 1=1
    `;
    const params = [activityId];

    if (filter_by === 'building_id' && filter_value) {
      params.push(filter_value);
      apptQuery += ` AND ap.building_id = $${params.length}`;
    } else if (filter_by === 'professional_id' && filter_value) {
      params.push(parseInt(filter_value));
      apptQuery += ` AND aa.professional_id = $${params.length}`;
    }

    apptQuery += ` ORDER BY ap.slot_datetime ASC`;

    const apptRes = await pool.query(apptQuery, params);

    res.json({
      activity: actRes.rows[0],
      appointments: apptRes.rows,
      total: apptRes.rows.length,
      filter: filter_by ? { by: filter_by, value: filter_value } : null
    });
  } catch (err) {
    logger.error('[Activities] schedule error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
