/**
 * Appointment Fallback Job — Issue #8
 *
 * Cron: every 5 minutes
 * Logic: Find appointments where:
 *   - status = 'pending'
 *   - whatsapp_sent_at < NOW() - 1 hour
 *   - vapi_called_at IS NULL
 * Action: Trigger Vapi outbound call with quantum_appointment_scheduler assistant
 */

const cron = require('node-cron');
const pool = require('../db/pool');
const logger = require('../utils/logger');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_APPOINTMENT = process.env.VAPI_ASSISTANT_APPOINTMENT;
const VAPI_BASE_URL = 'https://api.vapi.ai';

async function triggerVapiCall(appointment) {
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_APPOINTMENT) {
    logger.warn('[AppointmentFallback] VAPI_API_KEY or VAPI_ASSISTANT_APPOINTMENT not configured — skipping Vapi call');
    return false;
  }

  const phone = appointment.phone.startsWith('+') ? appointment.phone : `+972${appointment.phone.replace(/^0/, '')}`;

  try {
    const response = await fetch(`${VAPI_BASE_URL}/call/phone`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_APPOINTMENT,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number: phone },
        assistantOverrides: {
          metadata: {
            appointment_id: appointment.id,
            contact_id: appointment.contact_id,
            campaign_type: appointment.campaign_type,
            building_id: appointment.building_id
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      logger.error(`[AppointmentFallback] Vapi call failed for appointment #${appointment.id}:`, data);
      return false;
    }

    logger.info(`[AppointmentFallback] Vapi call triggered for appointment #${appointment.id}, phone ${phone}, call ID: ${data.id}`);
    return true;

  } catch (err) {
    logger.error(`[AppointmentFallback] Vapi call error for appointment #${appointment.id}:`, err.message);
    return false;
  }
}

async function runFallbackJob() {
  try {
    // Find pending appointments with no Vapi call, WhatsApp sent > 1 hour ago
    const result = await pool.query(
      `SELECT * FROM appointments
       WHERE status = 'pending'
         AND vapi_called_at IS NULL
         AND whatsapp_sent_at IS NOT NULL
         AND whatsapp_sent_at < NOW() - INTERVAL '1 hour'
       ORDER BY whatsapp_sent_at ASC
       LIMIT 20`
    );

    if (result.rows.length === 0) return;

    logger.info(`[AppointmentFallback] Found ${result.rows.length} appointments needing Vapi fallback`);

    for (const appt of result.rows) {
      const success = await triggerVapiCall(appt);

      // Mark vapi_called_at regardless of success to avoid repeated attempts
      await pool.query(
        `UPDATE appointments SET vapi_called_at = NOW() WHERE id = $1`,
        [appt.id]
      );

      if (success) {
        logger.info(`[AppointmentFallback] ✓ Vapi call queued for appointment #${appt.id}`);
      }

      // Small delay between calls
      await new Promise(resolve => setTimeout(resolve, 500));
    }

  } catch (err) {
    logger.error('[AppointmentFallback] Job error:', err.message);
  }
}

function initialize() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    logger.debug('[AppointmentFallback] Running fallback check...');
    runFallbackJob();
  });

  logger.info('[AppointmentFallback] Fallback job initialized — runs every 5 minutes');
}

module.exports = { initialize, runFallbackJob };
