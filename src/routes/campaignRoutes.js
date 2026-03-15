/**
 * QUANTUM Campaign Routes — v2.3
 * v2.3: voice/script settings per campaign + leads from DB filter
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const axios   = require('axios');
const { logger } = require('../services/logger');
const { buildWaMessages } = require('../services/ranScript');

const INFORU_BASE = 'https://capi.inforu.co.il/api/v2';
const VAPI_BASE   = 'https://api.vapi.ai';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBasicAuth() {
  const u = process.env.INFORU_USERNAME;
  const p = process.env.INFORU_PASSWORD;
  if (!u || !p) throw new Error('INFORU credentials missing');
  return Buffer.from(`${u}:${p}`).toString('base64');
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return '+' + digits;
  if (digits.startsWith('0'))   return '+972' + digits.slice(1);
  return '+972' + digits;
}

async function sendWhatsApp(phone, message, campaignLeadId) {
  const auth = getBasicAuth();
  const resp = await axios.post(`${INFORU_BASE}/WhatsApp/SendWhatsAppChat`, {
    Data: {
      Message: message,
      Phone: phone,
      Settings: {
        CustomerMessageId: `camp_${campaignLeadId}_${Date.now()}`,
        CustomerParameter: 'QUANTUM_CAMPAIGN',
      },
    },
  }, {
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    timeout: 15000,
    validateStatus: () => true,
  });
  return resp.data?.StatusId === 1;
}

async function initiateVapiCall(phone, leadName, campaign) {
  const apiKey        = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId   = process.env.VAPI_ASSISTANT_COLD ||
                        process.env.VAPI_ASSISTANT_SELLER ||
                        process.env.VAPI_ASSISTANT_ID;

  if (!apiKey || !phoneNumberId) throw new Error('Vapi credentials missing');
  if (!assistantId)              throw new Error('No Vapi assistant configured');

  const e164 = normalizePhone(phone);

  // Build assistant overrides — apply voice settings from campaign
  const assistantOverrides = {
    variableValues: {
      lead_name:     leadName || '',
      agent_name:    campaign.agent_name || 'רן',
      campaign_id:   String(campaign.id),
      campaign_name: campaign.name,
    },
  };

  // Apply voice override if campaign has custom voice
  if (campaign.voice_name) {
    assistantOverrides.voice = {
      provider: campaign.voice_provider || 'vapi',
      voiceId:  campaign.voice_name,
    };
  }

  // Apply script override if campaign has custom call script
  if (campaign.call_script) {
    assistantOverrides.model = {
      messages: [{ role: 'system', content: campaign.call_script }],
    };
  }

  const resp = await axios.post(`${VAPI_BASE}/call/phone`, {
    phoneNumberId,
    assistantId,
    customer: { number: e164, name: leadName || 'לקוח' },
    assistantOverrides,
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return resp.data?.id;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(cl.id)                                                         AS total_leads,
        COUNT(CASE WHEN cl.status = 'wa_sent'          THEN 1 END)          AS wa_sent,
        COUNT(CASE WHEN cl.status = 'wa_replied'       THEN 1 END)          AS wa_replied,
        COUNT(CASE WHEN cl.status = 'call_initiated'   THEN 1 END)          AS calls_made,
        COUNT(CASE WHEN cl.status = 'call_done'        THEN 1 END)          AS calls_done
      FROM campaigns c
      LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, campaigns: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/scripts/preview
router.get('/scripts/preview', (req, res) => {
  const { name, city, propertyType } = req.query;
  const msgs = buildWaMessages({ name, city, propertyType });
  res.json({ success: true, scripts: msgs });
});

// ─── System Settings (WA Bot Escalation) ──────────────────────────────────────

// GET /api/campaigns/settings
router.get('/settings', async (req, res) => {
  try {
    const { getEscalationMinutes, getEscalationStats } = require('../services/waBotEscalationService');
    const [minutes, rawStats] = await Promise.all([getEscalationMinutes(), getEscalationStats()]);
    const stats = {
      pending_escalation: parseInt(rawStats?.active_bot_leads) || 0,
      escalated_total:    parseInt(rawStats?.total_escalated)  || 0,
      total_bot_leads:    parseInt(rawStats?.total_bot_leads)  || 0,
    };
    res.json({
      success: true,
      escalation_minutes: minutes,
      wa_bot_escalation_minutes: minutes,
      wa_bot_escalation_enabled: minutes > 0,
      stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/settings
router.patch('/settings', async (req, res) => {
  try {
    const { wa_bot_escalation_minutes } = req.body;
    if (wa_bot_escalation_minutes === undefined) {
      return res.status(400).json({ error: 'wa_bot_escalation_minutes required' });
    }
    const { setEscalationMinutes } = require('../services/waBotEscalationService');
    const val = await setEscalationMinutes(wa_bot_escalation_minutes);
    res.json({ success: true, escalation_minutes: val, wa_bot_escalation_minutes: val });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/escalation/run
router.post('/escalation/run', async (req, res) => {
  try {
    const { runEscalation } = require('../services/waBotEscalationService');
    const result = await runEscalation();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Single Campaign CRUD ──────────────────────────────────────────────────────

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows: [campaign] } = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1', [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { rows: leads } = await pool.query(
      'SELECT * FROM campaign_leads WHERE campaign_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, campaign, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — create
router.post('/', async (req, res) => {
  try {
    const {
      name,
      mode = 'wa_then_call',
      wa_wait_minutes = 60,
      agent_name = 'רן',
      wa_message,
      notes,
      voice_gender = 'male',
      voice_name,
      voice_provider = 'vapi',
      call_script,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!['wa_then_call', 'call_only'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be wa_then_call or call_only' });
    }

    const { rows: [campaign] } = await pool.query(`
      INSERT INTO campaigns (name, mode, wa_wait_minutes, agent_name, wa_message, notes,
                             voice_gender, voice_name, voice_provider, call_script)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [name, mode, wa_wait_minutes, agent_name,
        wa_message || null, notes || null,
        voice_gender, voice_name || null, voice_provider, call_script || null]);

    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — update basic fields
router.patch('/:id', async (req, res) => {
  try {
    const { name, mode, wa_wait_minutes, agent_name, wa_message, notes, status,
            voice_gender, voice_name, voice_provider, call_script } = req.body;
    const { rows: [campaign] } = await pool.query(`
      UPDATE campaigns SET
        name            = COALESCE($1,  name),
        mode            = COALESCE($2,  mode),
        wa_wait_minutes = COALESCE($3,  wa_wait_minutes),
        agent_name      = COALESCE($4,  agent_name),
        wa_message      = COALESCE($5,  wa_message),
        notes           = COALESCE($6,  notes),
        status          = COALESCE($7,  status),
        voice_gender    = COALESCE($8,  voice_gender),
        voice_name      = COALESCE($9,  voice_name),
        voice_provider  = COALESCE($10, voice_provider),
        call_script     = COALESCE($11, call_script),
        updated_at      = NOW()
      WHERE id = $12
      RETURNING *
    `, [name, mode, wa_wait_minutes, agent_name, wa_message, notes, status,
        voice_gender, voice_name, voice_provider, call_script, req.params.id]);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lead Management ───────────────────────────────────────────────────────────

// POST /api/campaigns/:id/leads — add leads manually (array)
router.post('/:id/leads', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { leads, mode_override } = req.body;

    if (!Array.isArray(leads) || !leads.length) {
      return res.status(400).json({ error: 'leads array required' });
    }

    // If mode_override supplied, update campaign mode before adding leads
    if (mode_override && ['wa_then_call', 'call_only'].includes(mode_override)) {
      await pool.query(
        'UPDATE campaigns SET mode = $1, updated_at = NOW() WHERE id = $2',
        [mode_override, campaignId]
      );
    }

    const inserted = [];
    for (const l of leads) {
      if (!l.phone) continue;
      try {
        const { rows: [row] } = await pool.query(`
          INSERT INTO campaign_leads (campaign_id, phone, name, source, lead_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (campaign_id, phone) DO NOTHING
          RETURNING *
        `, [campaignId, l.phone, l.name || null, l.source || 'manual', l.lead_id || null]);
        if (row) inserted.push(row);
      } catch (e) {
        logger.warn(`[Campaign] Failed to insert lead ${l.phone}:`, e.message);
      }
    }

    res.json({ success: true, inserted: inserted.length, leads: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/leads/from-filter — add leads from leads table with filters
router.post('/:id/leads/from-filter', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { city, status: leadStatus, source, min_ssi, max_ssi, limit = 200, mode_override } = req.body;

    // Verify campaign exists
    const { rows: [campaign] } = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // If mode_override supplied, update campaign mode
    if (mode_override && ['wa_then_call', 'call_only'].includes(mode_override)) {
      await pool.query('UPDATE campaigns SET mode = $1, updated_at = NOW() WHERE id = $2', [mode_override, campaignId]);
    }

    // Build dynamic query from filters
    const conditions = ['l.phone IS NOT NULL', "l.phone != ''"];
    const params = [];

    if (city) {
      params.push(city);
      conditions.push(`l.city = $${params.length}`);
    }
    if (leadStatus) {
      params.push(leadStatus);
      conditions.push(`l.status = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`l.source = $${params.length}`);
    }
    if (min_ssi !== undefined) {
      params.push(min_ssi);
      conditions.push(`l.ssi_score >= $${params.length}`);
    }
    if (max_ssi !== undefined) {
      params.push(max_ssi);
      conditions.push(`l.ssi_score <= $${params.length}`);
    }

    params.push(campaignId);
    const excludeClause = `l.phone NOT IN (
      SELECT phone FROM campaign_leads WHERE campaign_id = $${params.length}
    )`;
    conditions.push(excludeClause);

    params.push(limit);
    const query = `
      SELECT l.id, l.phone, l.name, l.city, l.source, l.status, l.ssi_score
      FROM leads l
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.ssi_score DESC NULLS LAST
      LIMIT $${params.length}
    `;

    const { rows: leadsToAdd } = await pool.query(query, params);

    if (!leadsToAdd.length) {
      return res.json({ success: true, inserted: 0, message: 'אין ליידים תואמים לפילטרים' });
    }

    let inserted = 0;
    for (const l of leadsToAdd) {
      try {
        const { rowCount } = await pool.query(`
          INSERT INTO campaign_leads (campaign_id, phone, name, source, lead_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (campaign_id, phone) DO NOTHING
        `, [campaignId, l.phone, l.name || null, l.source || 'leads_db', l.id]);
        if (rowCount > 0) inserted++;
      } catch (e) {
        logger.warn(`[Campaign/filter] lead ${l.phone}:`, e.message);
      }
    }

    res.json({
      success: true,
      inserted,
      total_matched: leadsToAdd.length,
      message: `נוספו ${inserted} ליידים מה-DB לקמפיין`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/leads/filter-preview — preview leads matching filters (for UI)
router.get('/leads/filter-preview', async (req, res) => {
  try {
    const { city, status: leadStatus, source, min_ssi, max_ssi, limit = 50 } = req.query;

    const conditions = ['l.phone IS NOT NULL', "l.phone != ''"];
    const params = [];

    if (city) { params.push(city); conditions.push(`l.city = $${params.length}`); }
    if (leadStatus) { params.push(leadStatus); conditions.push(`l.status = $${params.length}`); }
    if (source) { params.push(source); conditions.push(`l.source = $${params.length}`); }
    if (min_ssi !== undefined) { params.push(min_ssi); conditions.push(`l.ssi_score >= $${params.length}`); }
    if (max_ssi !== undefined) { params.push(max_ssi); conditions.push(`l.ssi_score <= $${params.length}`); }

    params.push(parseInt(limit));
    const query = `
      SELECT l.id, l.phone, l.name, l.city, l.source, l.status, l.ssi_score
      FROM leads l
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.ssi_score DESC NULLS LAST
      LIMIT $${params.length}
    `;

    const { rows } = await pool.query(query, params);

    // Also get count
    const countQuery = `SELECT COUNT(*) FROM leads l WHERE ${conditions.slice(0, -1).join(' AND ')}`;
    const { rows: [{ count }] } = await pool.query(countQuery, params.slice(0, -1));

    // Get distinct cities for filter dropdown
    const { rows: cities } = await pool.query(
      `SELECT DISTINCT city FROM leads WHERE city IS NOT NULL AND city != '' ORDER BY city LIMIT 100`
    );

    res.json({
      success: true,
      leads: rows,
      total_count: parseInt(count),
      cities: cities.map(r => r.city),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign Execution ────────────────────────────────────────────────────────

router.post('/:id/launch', async (req, res) => {
  try {
    const { rows: [campaign] } = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1', [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await pool.query(
      "UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = $1",
      [campaign.id]
    );

    const { rows: leads } = await pool.query(
      "SELECT * FROM campaign_leads WHERE campaign_id = $1 AND status = 'pending'",
      [campaign.id]
    );

    if (!leads.length) {
      return res.json({ success: true, message: 'No pending leads', sent: 0 });
    }

    let waSent = 0, callsInitiated = 0, errors = 0;

    for (const lead of leads) {
      try {
        if (campaign.mode === 'call_only') {
          const vapiCallId = await initiateVapiCall(lead.phone, lead.name, campaign);
          await pool.query(`
            UPDATE campaign_leads
            SET status = 'call_initiated', call_initiated_at = NOW(),
                vapi_call_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [vapiCallId, lead.id]);
          callsInitiated++;
        } else {
          const waText = campaign.wa_message
            ? campaign.wa_message.replace(/\{\{name\}\}/g, lead.name || '')
                                 .replace(/\{\{city\}\}/g, lead.city  || '')
            : buildWaMessages({ name: lead.name, city: lead.city }).initial;

          const ok = await sendWhatsApp(lead.phone, waText, lead.id);
          await pool.query(`
            UPDATE campaign_leads
            SET status = $1, wa_sent_at = NOW(), updated_at = NOW()
            WHERE id = $2
          `, [ok ? 'wa_sent' : 'failed', lead.id]);
          if (ok) waSent++; else errors++;
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        logger.error(`[Campaign] Lead ${lead.phone} error:`, e.message);
        await pool.query(
          "UPDATE campaign_leads SET status = 'failed', notes = $1, updated_at = NOW() WHERE id = $2",
          [e.message.substring(0, 200), lead.id]
        );
        errors++;
      }
    }

    res.json({
      success: true,
      mode: campaign.mode,
      total: leads.length,
      wa_sent: waSent,
      calls_initiated: callsInitiated,
      errors,
      message: campaign.mode === 'wa_then_call'
        ? `נשלחו ${waSent} הודעות WA. שיחות יוזמו אחרי ${campaign.wa_wait_minutes} דק' ללא מענה.`
        : `יזומו ${callsInitiated} שיחות ישירות.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    await pool.query(
      "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    res.json({ success: true, status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Followup Cron ─────────────────────────────────────────────────────────────

router.post('/followup/run', async (req, res) => {
  try {
    const { rows: overdueLeads } = await pool.query(`
      SELECT cl.*, c.wa_wait_minutes, c.agent_name, c.name AS campaign_name, c.id AS camp_id,
             c.voice_gender, c.voice_name, c.voice_provider, c.call_script,
             cl.name AS lead_name
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      WHERE cl.status = 'wa_sent'
        AND c.mode = 'wa_then_call'
        AND c.status = 'active'
        AND cl.wa_sent_at < NOW() - (c.wa_wait_minutes * INTERVAL '1 minute')
        AND cl.vapi_call_id IS NULL
      LIMIT 20
    `);

    if (!overdueLeads.length) return res.json({ success: true, processed: 0 });

    let called = 0, errors = 0;

    for (const lead of overdueLeads) {
      try {
        const campaign = {
          id: lead.camp_id,
          name: lead.campaign_name,
          agent_name: lead.agent_name,
          voice_gender: lead.voice_gender,
          voice_name: lead.voice_name,
          voice_provider: lead.voice_provider,
          call_script: lead.call_script,
        };
        const vapiCallId = await initiateVapiCall(lead.phone, lead.lead_name, campaign);
        await pool.query(`
          UPDATE campaign_leads
          SET status = 'call_initiated', call_initiated_at = NOW(),
              call_queued_at = NOW(), vapi_call_id = $1, updated_at = NOW()
          WHERE id = $2
        `, [vapiCallId, lead.id]);
        called++;
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        logger.error(`[Campaign] Follow-up call failed for ${lead.phone}:`, e.message);
        errors++;
      }
    }

    res.json({ success: true, processed: overdueLeads.length, called, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/webhook/wa-reply
router.post('/webhook/wa-reply', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const { rowCount } = await pool.query(`
      UPDATE campaign_leads
      SET status = 'wa_replied', wa_replied_at = NOW(), updated_at = NOW()
      WHERE phone = $1
        AND status = 'wa_sent'
        AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
    `, [phone]);

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*)                                                    AS total,
        COUNT(CASE WHEN status = 'pending'        THEN 1 END)      AS pending,
        COUNT(CASE WHEN status = 'wa_sent'        THEN 1 END)      AS wa_sent,
        COUNT(CASE WHEN status = 'wa_replied'     THEN 1 END)      AS wa_replied,
        COUNT(CASE WHEN status = 'call_initiated' THEN 1 END)      AS calls_initiated,
        COUNT(CASE WHEN status = 'call_done'      THEN 1 END)      AS calls_done,
        COUNT(CASE WHEN status = 'failed'         THEN 1 END)      AS failed
      FROM campaign_leads WHERE campaign_id = $1
    `, [req.params.id]);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
