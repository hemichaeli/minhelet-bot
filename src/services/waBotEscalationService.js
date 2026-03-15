/**
 * QUANTUM WA Bot Escalation Service
 * v1.0.0
 *
 * When an inbound WA bot lead goes silent (no reply for X minutes after bot's last message),
 * auto-trigger a Vapi call from "רן מ-QUANTUM"
 *
 * Setting: system_settings WHERE key = 'wa_bot_escalation_minutes' (0 = disabled)
 */

const pool = require('../db/pool');
const axios = require('axios');
const { logger } = require('./logger');

const VAPI_BASE = 'https://api.vapi.ai';

// ─── Settings ────────────────────────────────────────────────────────────────

async function getEscalationMinutes() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'wa_bot_escalation_minutes'"
    );
    if (rows.length) {
      const val = parseInt(rows[0].value, 10);
      return isNaN(val) ? 60 : val;
    }
  } catch (e) { /* table may not exist yet */ }
  return 60;
}

async function setEscalationMinutes(minutes) {
  const val = parseInt(minutes, 10);
  if (isNaN(val) || val < 0) throw new Error('Invalid minutes value');
  await pool.query(`
    INSERT INTO system_settings (key, value, label, updated_at)
    VALUES ('wa_bot_escalation_minutes', $1, 'זמן המתנה לאחר WA Bot לפני שיחה', NOW())
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
  `, [val.toString()]);
  return val;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getEscalationStats() {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE l.status = 'vapi_called')         AS total_escalated,
        COUNT(*) FILTER (WHERE l.status = 'new' OR l.status IS NULL) AS active_bot_leads,
        COUNT(*) FILTER (WHERE l.source = 'whatsapp_bot')        AS total_bot_leads
      FROM leads l
      WHERE l.source = 'whatsapp_bot'
    `);
    return rows[0] || {};
  } catch (e) {
    return {};
  }
}

// ─── Main Escalation Run ──────────────────────────────────────────────────────

async function runEscalation() {
  const apiKey        = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId   = process.env.VAPI_ASSISTANT_COLD  ||
                        process.env.VAPI_ASSISTANT_SELLER ||
                        process.env.VAPI_ASSISTANT_ID;

  if (!apiKey || !phoneNumberId || !assistantId) {
    return { skipped: true, reason: 'Vapi not fully configured' };
  }

  const waitMinutes = await getEscalationMinutes();
  if (waitMinutes === 0) return { disabled: true };

  // Find WA bot leads where:
  // - Last message was sent by 'bot'
  // - More than waitMinutes minutes ago
  // - Lead is not already closed/called/handoff
  const { rows: overdueLeads } = await pool.query(`
    WITH last_msg AS (
      SELECT DISTINCT ON (lead_id)
        lead_id,
        sender,
        created_at AS last_at
      FROM whatsapp_conversations
      ORDER BY lead_id, created_at DESC
    )
    SELECT l.id, l.phone, l.name, lm.last_at
    FROM leads l
    JOIN last_msg lm ON lm.lead_id = l.id
    WHERE l.source = 'whatsapp_bot'
      AND lm.sender = 'bot'
      AND lm.last_at < NOW() - ($1::int * INTERVAL '1 minute')
      AND l.status NOT IN ('called', 'closed', 'pending_handoff', 'disqualified', 'vapi_called')
    LIMIT 10
  `, [waitMinutes]);

  if (!overdueLeads.length) return { processed: 0 };

  let called = 0, errors = 0;

  for (const lead of overdueLeads) {
    try {
      const digits = (lead.phone || '').replace(/\D/g, '');
      const e164   = digits.startsWith('972') ? `+${digits}`
                   : digits.startsWith('0')   ? `+972${digits.slice(1)}`
                   : `+${digits}`;

      await axios.post(`${VAPI_BASE}/call/phone`, {
        phoneNumberId,
        assistantId,
        customer: { number: e164, name: lead.name || 'לקוח' },
        assistantOverrides: {
          variableValues: {
            lead_name:   lead.name  || '',
            lead_source: 'wa_bot_escalation',
          },
        },
        metadata: {
          lead_id: lead.id.toString(),
          source:  'wa_bot_escalation',
        },
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      await pool.query(
        "UPDATE leads SET status = 'vapi_called', updated_at = NOW() WHERE id = $1",
        [lead.id]
      );

      logger.info(`[WaBotEscalation] Called ${e164} (lead #${lead.id}) after ${waitMinutes}min silence`);
      called++;
      await new Promise(r => setTimeout(r, 800));

    } catch (e) {
      logger.error(`[WaBotEscalation] Failed for lead #${lead.id}:`, e.message);
      errors++;
    }
  }

  return { processed: overdueLeads.length, called, errors };
}

module.exports = { runEscalation, getEscalationMinutes, setEscalationMinutes, getEscalationStats };
