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
    const { phone, leadName, leadId } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });

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

    // Build WhatsApp message
    const slotsText = slots.map((s, i) => `${i + 1}. ${formatSlotForWhatsApp(s)}`).join('\n');
    const message = `שלום${leadName ? ' ' + leadName : ''},\nנשמח לקיים איתך שיחת ייעוץ קצרה בנושא נכסך.\n\nהזמנים הפנויים אצלנו:\n${slotsText}\n\nאיזה זמן מתאים לך? פשוט ענה/י עם המספר הרצוי 😊`;

    // Send WhatsApp
    const waResult = await sendWhatsApp(phone, message);

    // Create appointment record (status: whatsapp_sent)
    const { rows: [appointment] } = await pool.query(
      `INSERT INTO appointments (phone, lead_name, lead_id, status, whatsapp_message_id, created_at)
       VALUES ($1, $2, $3, 'whatsapp_sent', $4, NOW())
       RETURNING *`,
      [phone, leadName || null, leadId || null, waResult?.data?.MessageId || null]
    );

    res.json({ success: true, appointment, waResult, slots, message });
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

module.exports = router;
