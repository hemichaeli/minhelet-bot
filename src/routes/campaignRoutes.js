/**
 * Minhelet Bot — Campaign Routes
 *
 * Manages scheduling campaigns: create, list, view, update, delete.
 * Each campaign links to a Zoho project and defines meeting type,
 * available time windows, and developer branding (per-campaign INFORU credentials).
 *
 * Campaign data is stored in Railway PostgreSQL.
 * Resident data comes from Zoho CRM (read-only).
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { logger } = require('../services/logger');

// ── List all campaigns ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        csc.*,
        COUNT(DISTINCT bs.phone) FILTER (WHERE bs.state != 'initial') AS active_sessions,
        COUNT(DISTINCT bs.phone) FILTER (WHERE bs.state = 'confirmed') AS confirmed_count,
        COUNT(DISTINCT bs.phone) FILTER (WHERE bs.state = 'declined') AS declined_count
      FROM campaign_schedule_config csc
      LEFT JOIN bot_sessions bs ON bs.zoho_campaign_id = csc.zoho_campaign_id
      GROUP BY csc.id
      ORDER BY csc.id DESC
    `);
    res.json({ campaigns: result.rows, total: result.rowCount });
  } catch (err) {
    logger.error('[CampaignRoutes] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get single campaign ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id = $1 OR id::text = $1',
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('[CampaignRoutes] Get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Create / upsert campaign ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      zoho_campaign_id,
      project_id,
      meeting_type = 'consultation',
      available_windows = [],
      slot_duration_minutes = 45,
      buffer_minutes = 15,
      reminder_delay_hours = 24,
      bot_followup_delay_hours = 48,
      pre_meeting_reminder_hours = 24,
      morning_reminder_hours = 2,
      wa_initial_template = '',
      wa_language = 'he',
      show_rep_name = true,
      booking_link_expires_hours = 48,
      default_start_time = '09:00',
      default_end_time = '18:00',
      developer_name,
      inforu_username,
      inforu_password,
    } = req.body;

    if (!zoho_campaign_id) return res.status(400).json({ error: 'zoho_campaign_id is required' });

    const result = await pool.query(`
      INSERT INTO campaign_schedule_config (
        zoho_campaign_id, project_id, meeting_type, available_windows,
        slot_duration_minutes, buffer_minutes, reminder_delay_hours,
        bot_followup_delay_hours, pre_meeting_reminder_hours, morning_reminder_hours,
        wa_initial_template, wa_language, show_rep_name, booking_link_expires_hours,
        default_start_time, default_end_time,
        developer_name, inforu_username, inforu_password
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (zoho_campaign_id) DO UPDATE SET
        project_id                  = EXCLUDED.project_id,
        meeting_type                = EXCLUDED.meeting_type,
        available_windows           = EXCLUDED.available_windows,
        slot_duration_minutes       = EXCLUDED.slot_duration_minutes,
        buffer_minutes              = EXCLUDED.buffer_minutes,
        reminder_delay_hours        = EXCLUDED.reminder_delay_hours,
        bot_followup_delay_hours    = EXCLUDED.bot_followup_delay_hours,
        pre_meeting_reminder_hours  = EXCLUDED.pre_meeting_reminder_hours,
        morning_reminder_hours      = EXCLUDED.morning_reminder_hours,
        wa_initial_template         = EXCLUDED.wa_initial_template,
        wa_language                 = EXCLUDED.wa_language,
        show_rep_name               = EXCLUDED.show_rep_name,
        booking_link_expires_hours  = EXCLUDED.booking_link_expires_hours,
        default_start_time          = EXCLUDED.default_start_time,
        default_end_time            = EXCLUDED.default_end_time,
        developer_name              = EXCLUDED.developer_name,
        inforu_username             = EXCLUDED.inforu_username,
        inforu_password             = EXCLUDED.inforu_password,
        updated_at                  = NOW()
      RETURNING *
    `, [
      zoho_campaign_id, project_id, meeting_type, JSON.stringify(available_windows),
      slot_duration_minutes, buffer_minutes, reminder_delay_hours,
      bot_followup_delay_hours, pre_meeting_reminder_hours, morning_reminder_hours,
      wa_initial_template, wa_language, show_rep_name, booking_link_expires_hours,
      default_start_time, default_end_time,
      developer_name || null, inforu_username || null, inforu_password || null,
    ]);

    logger.info(`[CampaignRoutes] Campaign created/updated: ${zoho_campaign_id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('[CampaignRoutes] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Update campaign ───────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'project_id','meeting_type','available_windows','slot_duration_minutes',
      'buffer_minutes','reminder_delay_hours','bot_followup_delay_hours',
      'pre_meeting_reminder_hours','morning_reminder_hours','wa_initial_template',
      'wa_language','show_rep_name','booking_link_expires_hours',
      'default_start_time','default_end_time',
      'developer_name','inforu_username','inforu_password',
    ];
    const keys = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!keys.length) return res.status(400).json({ error: 'No valid fields to update' });

    const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [id, ...keys.map(k => req.body[k])];

    const result = await pool.query(
      `UPDATE campaign_schedule_config SET ${setClause}, updated_at = NOW()
       WHERE zoho_campaign_id = $1 OR id::text = $1
       RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('[CampaignRoutes] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Delete campaign ───────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM campaign_schedule_config WHERE zoho_campaign_id = $1 OR id::text = $1',
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('[CampaignRoutes] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign stats ────────────────────────────────────────────────────────────
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await pool.query(`
      SELECT state, COUNT(*) as count
      FROM bot_sessions
      WHERE zoho_campaign_id = $1
      GROUP BY state
    `, [id]);

    const bookings = await pool.query(`
      SELECT COUNT(*) as total
      FROM appointments
      WHERE zoho_campaign_id = $1
    `, [id]);

    const byState = {};
    stats.rows.forEach(r => { byState[r.state] = parseInt(r.count); });

    res.json({
      campaign_id: id,
      sessions: byState,
      total_sessions: Object.values(byState).reduce((a, b) => a + b, 0),
      total_bookings: parseInt(bookings.rows[0]?.total || 0),
    });
  } catch (err) {
    logger.error('[CampaignRoutes] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
