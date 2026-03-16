// appointmentRoutes.js — Appointments scheduling system (Sandbox mode)
// No Zoho CRM until explicitly approved by user

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

// ── Auto-migrations ─────────────────────────────────────────────────────────
async function ensureAppointmentTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointment_slots (
      id SERIAL PRIMARY KEY,
      slot_date DATE NOT NULL,
      slot_time TIME NOT NULL,
      is_available BOOLEAN DEFAULT true,
      label TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(slot_date, slot_time)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      lead_name TEXT,
      lead_id INTEGER,
      slot_id INTEGER REFERENCES appointment_slots(id),
      status VARCHAR(30) DEFAULT 'whatsapp_sent',
      whatsapp_message_id TEXT,
      vapi_call_id TEXT,
      confirmed_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_created ON appointments(created_at DESC)`);
  console.log('[Appointments] Tables ready');
}
ensureAppointmentTables().catch(e => console.error('[Appointments] Migration error:', e.message));

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSlotForWhatsApp(slot) {
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const d = new Date(slot.slot_date);
  const day = days[d.getDay()];
  const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
  const time = slot.slot_time.substring(0, 5);
  return `יום ${day} ${dateStr} בשעה ${time}`;
}

async function sendWhatsApp(phone, message) {
  const username = process.env.INFORU_USERNAME || 'hemichaeli';
  const token = process.env.INFORU_PASSWORD || process.env.INFORU_API_TOKEN;
  const businessLine = process.env.INFORU_BUSINESS_LINE || '037572229';

  const cleanPhone = phone.replace(/\D/g, '');
  const intlPhone = cleanPhone.startsWith('0') ? '972' + cleanPhone.slice(1) : cleanPhone;

  const resp = await axios.post(
    'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat',
    {
      Data: { Message: message, Recipients: [{ Phone: intlPhone }] },
      Settings: { BusinessPhoneNumber: businessLine }
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', username } }
  );
  return resp.data;
}

async function callWithVapi(phone, leadName, appointmentId) {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_COLD || process.env.VAPI_ASSISTANT_SELLER;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!apiKey || !phoneNumberId) return null;

  const cleanPhone = phone.replace(/\D/g, '');
  const intlPhone = cleanPhone.startsWith('0') ? '+972' + cleanPhone.slice(1) : '+' + cleanPhone;

  const resp = await axios.post(
    'https://api.vapi.ai/call/phone',
    {
      phoneNumberId,
      assistantId,
      customer: { number: intlPhone, name: leadName || 'לקוח' },
      assistantOverrides: {
        variableValues: { appointment_id: appointmentId.toString(), lead_name: leadName || 'לקוח' }
      }
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  return resp.data?.id || null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/appointments/slots — list all available slots
router.get('/slots', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *, (slot_date AT TIME ZONE 'Asia/Jerusalem')::date as slot_date_local
      FROM appointment_slots 
      WHERE slot_date >= CURRENT_DATE
      ORDER BY slot_date ASC, slot_time ASC
    `);
    res.json({ success: true, slots: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/slots — create new slot(s)
router.post('/slots', async (req, res) => {
  try {
    const { slots } = req.body; // [{date: '2026-03-10', time: '10:00', label: '...'}, ...]
    if (!slots || !Array.isArray(slots)) {
      return res.status(400).json({ success: false, error: 'slots array required' });
    }
    const created = [];
    for (const s of slots) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO appointment_slots (slot_date, slot_time, label, is_available)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (slot_date, slot_time) DO UPDATE SET is_available = true, label = $3
           RETURNING *`,
          [s.date, s.time, s.label || null]
        );
        created.push(rows[0]);
      } catch (e2) {
        console.warn('[Slots] Skip:', e2.message);
      }
    }
    res.json({ success: true, created, count: created.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/appointments/slots/:id — delete/disable slot
router.delete('/slots/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE appointment_slots SET is_available = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/appointments — list all appointments
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT a.*, s.slot_date, s.slot_time, s.label as slot_label
      FROM appointments a
      LEFT JOIN appointment_slots s ON a.slot_id = s.id
      ${status ? 'WHERE a.status = $1' : ''}
      ORDER BY a.created_at DESC
      LIMIT 200
    `;
    const params = status ? [status] : [];
    const { rows } = await pool.query(query, params);
    res.json({ success: true, appointments: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/send-slots — send available slots via WhatsApp to a lead
router.post('/send-slots', async (req, res) => {
  try {
    const { phone, leadName, leadId, activityId, buildingId, buildingName } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });

    // Generate unique token for this appointment
    const crypto = require('crypto');
    const appointmentToken = crypto.randomBytes(16).toString('hex');
    const BASE_URL = process.env.BASE_URL || 'https://minhelet-bot-production.up.railway.app';
    const rescheduleLink = `${BASE_URL}/reschedule.html?token=${appointmentToken}`;

    // Get available slots
    const { rows: slots } = await pool.query(`
      SELECT * FROM appointment_slots 
      WHERE is_available = true AND slot_date >= CURRENT_DATE
      ORDER BY slot_date ASC, slot_time ASC
      LIMIT 5
    `);

    if (slots.length === 0) {
      return res.status(400).json({ success: false, error: 'No available slots. Add slots first.' });
    }

    // Build WhatsApp message with reschedule link
    const slotsText = slots.map((s, i) => `${i + 1}. ${formatSlotForWhatsApp(s)}`).join('\n');
    const message = `שלום${leadName ? ' ' + leadName : ''},\nמינהלת כאן. אנחנו מכינים לתאם איתך פגישה${buildingName ? ' בנוגע ל' + buildingName : ''}.\n\nהזמנים הפנויים:\n${slotsText}\n\nלאישור, ביטול או תיאום מחדש — לחץ כאן:\n${rescheduleLink}`;

    // Send WhatsApp
    const waResult = await sendWhatsApp(phone, message);

    // Create appointment record with token
    const { rows: [appointment] } = await pool.query(
      `INSERT INTO appointments (phone, lead_name, lead_id, status, whatsapp_message_id, appointment_token, activity_id, building_id, building_name, created_at)
       VALUES ($1, $2, $3, 'whatsapp_sent', $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [phone, leadName || null, leadId || null, waResult?.data?.MessageId || null,
       appointmentToken, activityId || null, buildingId || null, buildingName || null]
    );

    res.json({ success: true, appointment, waResult, slots, message, rescheduleLink });
  } catch (e) {
    console.error('[Appointments] send-slots error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/:id/confirm — confirm appointment with a slot
router.post('/:id/confirm', async (req, res) => {
  try {
    const { slotId } = req.body;
    const { rows: [appt] } = await pool.query(`
      UPDATE appointments SET slot_id = $1, status = 'confirmed', confirmed_at = NOW()
      WHERE id = $2 RETURNING *
    `, [slotId, req.params.id]);

    if (!appt) return res.status(404).json({ success: false, error: 'Not found' });

    // Mark slot as taken
    await pool.query(`UPDATE appointment_slots SET is_available = false WHERE id = $1`, [slotId]);

    // Get slot info
    const { rows: [slot] } = await pool.query(`SELECT * FROM appointment_slots WHERE id = $1`, [slotId]);

    // Send confirmation WhatsApp
    if (appt.phone && slot) {
      const confirmMsg = `מעולה! הפגישה אושרה ל${formatSlotForWhatsApp(slot)}.\nנשמח לדבר איתך ולהכיר 😊\nצוות QUANTUM`;
      await sendWhatsApp(appt.phone, confirmMsg).catch(e => console.warn('[Appointments] confirm WA error:', e.message));
    }

    res.json({ success: true, appointment: appt, slot });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/:id/vapi-call — trigger Vapi fallback call
router.post('/:id/vapi-call', async (req, res) => {
  try {
    const { rows: [appt] } = await pool.query(`SELECT * FROM appointments WHERE id = $1`, [req.params.id]);
    if (!appt) return res.status(404).json({ success: false, error: 'Not found' });

    const vapiCallId = await callWithVapi(appt.phone, appt.lead_name, appt.id);
    await pool.query(
      `UPDATE appointments SET status = 'vapi_called', vapi_call_id = $1 WHERE id = $2`,
      [vapiCallId, appt.id]
    );

    res.json({ success: true, vapiCallId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const { rows: [appt] } = await pool.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    // Free the slot
    if (appt?.slot_id) {
      await pool.query(`UPDATE appointment_slots SET is_available = true WHERE id = $1`, [appt.slot_id]);
    }
    res.json({ success: true, appointment: appt });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/appointments/webhook/reply — handle WhatsApp reply with chosen slot number
// Called from whatsappWebhookRoutes when message matches appointment context
router.post('/webhook/reply', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false });

    // Find pending appointment for this phone
    const { rows: [appt] } = await pool.query(`
      SELECT * FROM appointments 
      WHERE phone = $1 AND status = 'whatsapp_sent'
      ORDER BY created_at DESC LIMIT 1
    `, [phone]);

    if (!appt) return res.json({ success: false, reason: 'no pending appointment' });

    // Parse slot number from reply
    const num = parseInt(message.trim());
    if (!num || num < 1 || num > 5) return res.json({ success: false, reason: 'not a slot number' });

    // Get available slots
    const { rows: slots } = await pool.query(`
      SELECT * FROM appointment_slots 
      WHERE is_available = true AND slot_date >= CURRENT_DATE
      ORDER BY slot_date ASC, slot_time ASC
      LIMIT 5
    `);

    const chosenSlot = slots[num - 1];
    if (!chosenSlot) return res.json({ success: false, reason: 'slot not found' });

    // Confirm
    await pool.query(`UPDATE appointments SET slot_id = $1, status = 'confirmed', confirmed_at = NOW() WHERE id = $2`, [chosenSlot.id, appt.id]);
    await pool.query(`UPDATE appointment_slots SET is_available = false WHERE id = $1`, [chosenSlot.id]);

    // Confirm WhatsApp
    const confirmMsg = `מעולה! קיבלנו את בחירתך.\nהפגישה אושרה ל${formatSlotForWhatsApp(chosenSlot)}.\nנשמח להכיר! 😊\nצוות QUANTUM`;
    await sendWhatsApp(phone, confirmMsg);

    res.json({ success: true, confirmed: true, slot: chosenSlot });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/appointments/stats — dashboard stat card
router.get('/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'whatsapp_sent') as pending,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
        COUNT(*) FILTER (WHERE status = 'vapi_called') as called,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) as total
      FROM appointments
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    const { rows: [slotStats] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE is_available = true AND slot_date >= CURRENT_DATE) as available_slots
      FROM appointment_slots
    `);
    res.json({ success: true, stats: { ...stats, ...slotStats } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Tenant-facing endpoints (by appointment_token) ──────────────────────────
// Each appointment gets a unique token when created; the token is sent in the WhatsApp confirmation link.

// Ensure appointment_token column exists (idempotent)
async function ensureTokenColumn() {
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_token TEXT UNIQUE`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS activity_id INTEGER`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS building_id TEXT`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS building_name TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_token ON appointments(appointment_token)`);
}
ensureTokenColumn().catch(e => console.warn('[Appointments] token column:', e.message));

// GET /api/appointments/slots/available — available slots for tenant reschedule page
router.get('/slots/available', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, slot_date, slot_time, label
      FROM appointment_slots
      WHERE is_available = true AND slot_date >= CURRENT_DATE
      ORDER BY slot_date ASC, slot_time ASC
      LIMIT 12
    `);
    res.json({ success: true, slots: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/appointments/by-token/:token — load appointment details for tenant page
router.get('/by-token/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        a.id, a.phone, a.lead_name, a.status, a.appointment_token,
        a.building_id, a.building_name, a.activity_id,
        s.slot_date, s.slot_time,
        (s.slot_date::text || ' ' || s.slot_time::text) AS slot_datetime,
        act.type AS activity_type
      FROM appointments a
      LEFT JOIN appointment_slots s ON a.slot_id = s.id
      LEFT JOIN activities act ON a.activity_id = act.id
      WHERE a.appointment_token = $1
    `, [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'לא נמצאה פגישה עם הקישור הזה.' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/appointments/by-token/:token/confirm
router.post('/by-token/:token/confirm', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET status = 'confirmed', confirmed_at = NOW()
       WHERE appointment_token = $1
         AND status NOT IN ('cancelled','arrived','no-show')
       RETURNING *`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'לא ניתן לאשר — הפגישה לא נמצאה או כבר בוטלה.' });
    const appt = rows[0];
    if (appt.slot_id) {
      const { rows: [slot] } = await pool.query('SELECT * FROM appointment_slots WHERE id = $1', [appt.slot_id]);
      if (slot) {
        const msg = `✅ אישרת הגעה לפגישה ל${formatSlotForWhatsApp(slot)}.\nנשמח לראותך! צוות מינהלת`;
        sendWhatsApp(appt.phone, msg).catch(e => console.warn('[Tenant confirm WA]', e.message));
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/appointments/by-token/:token/cancel
router.post('/by-token/:token/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = NOW()
       WHERE appointment_token = $1
         AND status NOT IN ('cancelled','arrived')
       RETURNING *`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'לא ניתן לבטל — הפגישה לא נמצאה או כבר בוטלה.' });
    const appt = rows[0];
    if (appt.slot_id) {
      await pool.query('UPDATE appointment_slots SET is_available = true WHERE id = $1', [appt.slot_id]);
    }
    const msg = `❌ הפגישה בוטלה. אם תרצה לתאם מחדש, פנה אלינו. צוות מינהלת`;
    sendWhatsApp(appt.phone, msg).catch(e => console.warn('[Tenant cancel WA]', e.message));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/appointments/by-token/:token/reschedule
router.post('/by-token/:token/reschedule', async (req, res) => {
  try {
    const { slot_id } = req.body;
    if (!slot_id) return res.status(400).json({ error: 'חסר slot_id.' });
    const { rows: [slot] } = await pool.query(
      'SELECT * FROM appointment_slots WHERE id = $1 AND is_available = true', [slot_id]
    );
    if (!slot) return res.status(400).json({ error: 'המועד שנבחר אינו פנוי יותר.' });
    const { rows: [appt] } = await pool.query(
      'SELECT * FROM appointments WHERE appointment_token = $1', [req.params.token]
    );
    if (!appt) return res.status(404).json({ error: 'פגישה לא נמצאה.' });
    if (appt.slot_id) {
      await pool.query('UPDATE appointment_slots SET is_available = true WHERE id = $1', [appt.slot_id]);
    }
    await pool.query(
      `UPDATE appointments SET slot_id = $1, status = 'rescheduled', confirmed_at = NOW() WHERE id = $2`,
      [slot_id, appt.id]
    );
    await pool.query('UPDATE appointment_slots SET is_available = false WHERE id = $1', [slot_id]);
    const msg = `🔄 הפגישה תואמה מחדש ל${formatSlotForWhatsApp(slot)}.\nנשמח לראותך! צוות מינהלת`;
    sendWhatsApp(appt.phone, msg).catch(e => console.warn('[Tenant reschedule WA]', e.message));
    res.json({ success: true, slot_datetime: `${slot.slot_date} ${slot.slot_time}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
