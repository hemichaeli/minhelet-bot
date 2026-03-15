/**
 * Minhelet Bot — Main Entry Point
 *
 * Responsibilities:
 *  1. Campaign management — send WhatsApp messages to residents for appointment scheduling
 *  2. Bot conversation — handle resident replies (confirm/decline/reschedule)
 *  3. Appointment booking — visual booking link with available slots
 *  4. Reminders — automatic reminders before appointments
 *  5. Fallback — escalate unresponsive residents to human agent
 *
 * Data source: Zoho CRM (residents, buildings, compounds — read via API)
 * Local DB: Railway PostgreSQL (campaigns, sessions, bookings — write)
 * Outbound channel: INFORU CAPI (Minhelet business line)
 * Calendar: Google Calendar + Zoho Calendar
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { logger } = require('./services/logger');

const app = express();
app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'minhelet-bot',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: {
      inforu: !!(process.env.INFORU_USERNAME && process.env.INFORU_PASSWORD),
      zoho: !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN),
      google_calendar: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      db: !!process.env.DATABASE_URL,
    },
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/campaigns',   require('./routes/campaignRoutes'));
app.use('/api/bot',         require('./routes/botRoutes'));
app.use('/api/booking',     require('./routes/bookingRoute'));
app.use('/api/appointments',require('./routes/appointmentRoutes'));
app.use('/api/scheduling',  require('./routes/schedulingRoutes'));
app.use('/api/calendar',    require('./routes/calendarRoutes'));
app.use('/api/events',      require('./routes/eventSchedulerRoutes'));

// ── Scheduled Jobs ────────────────────────────────────────────────────────────

// Appointment reminders: every hour
cron.schedule('0 * * * *', async () => {
  try {
    const { runReminderJob } = require('./jobs/reminderJob');
    await runReminderJob();
    logger.info('[Scheduler] Reminder job completed');
  } catch (err) {
    logger.error('[Scheduler] Reminder job error:', err.message);
  }
});

// Appointment fallback (escalate unresponsive): every 6 hours
cron.schedule('0 */6 * * *', async () => {
  try {
    const { runFallbackJob } = require('./jobs/appointmentFallbackJob');
    await runFallbackJob();
    logger.info('[Scheduler] Fallback job completed');
  } catch (err) {
    logger.error('[Scheduler] Fallback job error:', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  logger.info(`[Minhelet Bot] Running on port ${PORT}`);
});
