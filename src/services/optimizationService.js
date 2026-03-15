/**
 * QUANTUM Schedule Optimization Service v1
 *
 * Runs the evening before appointments (default 20:00).
 * Identifies "isolated" confirmed slots and offers contacts a better time.
 *
 * PHASE 1 - WhatsApp:
 *   Sends a WA message to contacts with isolated slots offering a clustered alternative.
 *   Waits up to 2 hours for reply.
 *   Reply "1" → accept swap.  Reply "2" → decline.
 *
 * PHASE 2 - Vapi call (auto-triggered 2h after WA if no reply):
 *   Queued into reminder_queue with type 'reschedule_call'.
 *   Executed by reminderCron which checks this type.
 *
 * SWAP:
 *   Atomic PostgreSQL transaction:
 *     - Mark original slot → 'open' (contact_phone/name cleared)
 *     - Mark proposed slot → 'confirmed' (copy contact info over)
 *     - Update bot_sessions.context with new confirmed slot
 *     - Mark reschedule_request.status → 'accepted'
 */

const pool = require('../db/pool');
const inforuService = require('./inforuService');
const { logger } = require('./logger');

// How long before the meeting we stop accepting swap replies
const REPLY_WINDOW_HOURS = 2;
// Minimum gap (ms) on BOTH sides for a slot to be considered "isolated"
const ISOLATION_THRESHOLD_MS = 90 * 60 * 1000;
// Minimum gap saved (minutes) to bother asking
const MIN_GAP_SAVING_MINUTES = 30;

// ── MESSAGE STRINGS ────────────────────────────────────────────────────────────

const STRINGS = {
  he: {
    offer: (name, origTime, propTime, propDate) =>
      `שלום ${name} 👋\n` +
      `תזכורת: יש לך פגישה עם QUANTUM מחר ב-⏰ *${origTime}*.\n\n` +
      `💡 יש לנו מועד שנוח יותר גם לנו:\n` +
      `📅 *${propDate}* ⏰ *${propTime}*\n\n` +
      `האם תרצה לעבור למועד הזה?\n` +
      `1️⃣ כן, אעבור למועד החדש\n` +
      `2️⃣ לא, אשמור את ${origTime}`,
    accepted: (name, propTime, propDate) =>
      `✅ מעולה ${name}!\n` +
      `הפגישה שונתה ל-📅 *${propDate}* ⏰ *${propTime}*.\n` +
      `תזכורת תישלח יום לפני. נתראה! 👋`,
    declined: (name, origTime) =>
      `בסדר גמור ${name}! 🙂\n` +
      `הפגישה נשארת ב-⏰ *${origTime}*. נתראה! 👋`,
    alreadyPast: `המועד שהוצע כבר עבר. הפגישה המקורית נשמרת.`
  },
  ru: {
    offer: (name, origTime, propTime, propDate) =>
      `Здравствуйте, ${name} 👋\n` +
      `Напоминание: завтра встреча с QUANTUM в ⏰ *${origTime}*.\n\n` +
      `💡 У нас есть более удобное время:\n` +
      `📅 *${propDate}* ⏰ *${propTime}*\n\n` +
      `Хотите перенести?\n` +
      `1️⃣ Да, перенести на новое время\n` +
      `2️⃣ Нет, оставить ${origTime}`,
    accepted: (name, propTime, propDate) =>
      `✅ Отлично, ${name}!\n` +
      `Встреча перенесена на 📅 *${propDate}* ⏰ *${propTime}*.\n` +
      `Напомним за сутки. До встречи! 👋`,
    declined: (name, origTime) =>
      `Хорошо, ${name}! 🙂\n` +
      `Встреча остаётся в ⏰ *${origTime}*. До встречи! 👋`,
    alreadyPast: `Предложенное время уже прошло. Исходная встреча сохранена.`
  }
};

// ── HELPERS ────────────────────────────────────────────────────────────────────

function formatTime(dt, tz = 'Asia/Jerusalem') {
  return new Date(dt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

function formatDate(dt, tz = 'Asia/Jerusalem') {
  return new Date(dt).toLocaleDateString('he-IL', {
    weekday: 'long', day: '2-digit', month: '2-digit', timeZone: tz
  });
}

// ── CORE: find candidates for a given campaign ─────────────────────────────────

/**
 * Returns array of { originalSlot, proposedSlot, gapSavedMinutes }
 * for slots that are "isolated" AND have a genuinely better alternative available.
 */
async function findRescheduleCandidates(campaignId) {
  // All confirmed slots for tomorrow, with contact info
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const confirmedRes = await pool.query(
    `SELECT ms.*,
            bs.language, bs.contact_address, bs.contact_street, bs.zoho_contact_id AS bs_zoho_id
     FROM meeting_slots ms
     LEFT JOIN bot_sessions bs ON bs.phone = ms.contact_phone
       AND bs.zoho_campaign_id = ms.campaign_id
     WHERE ms.campaign_id = $1
       AND ms.status = 'confirmed'
       AND DATE(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem') = $2
     ORDER BY ms.slot_datetime`,
    [campaignId, tomorrowStr]
  );

  const confirmed = confirmedRes.rows;
  if (confirmed.length < 2) return []; // nothing to cluster

  // Open slots for tomorrow
  const openRes = await pool.query(
    `SELECT * FROM meeting_slots
     WHERE campaign_id = $1
       AND status = 'open'
       AND DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem') = $2
     ORDER BY slot_datetime`,
    [campaignId, tomorrowStr]
  );
  const open = openRes.rows;

  const candidates = [];

  for (let i = 0; i < confirmed.length; i++) {
    const slot = confirmed[i];
    const slotMs = new Date(slot.slot_datetime).getTime();

    // Skip if already has a pending reschedule request
    const existingReq = await pool.query(
      `SELECT 1 FROM reschedule_requests WHERE original_slot_id=$1 AND status='pending' LIMIT 1`,
      [slot.id]
    );
    if (existingReq.rows.length) continue;

    // Calculate isolation: gap to previous and next confirmed slots
    const prevSlot = confirmed[i - 1];
    const nextSlot = confirmed[i + 1];
    const gapBefore = prevSlot ? slotMs - new Date(prevSlot.slot_datetime).getTime() : Infinity;
    const gapAfter  = nextSlot ? new Date(nextSlot.slot_datetime).getTime() - slotMs : Infinity;

    const isIsolated = gapBefore > ISOLATION_THRESHOLD_MS && gapAfter > ISOLATION_THRESHOLD_MS;
    if (!isIsolated) continue;

    // Find the best open slot: adjacent to an existing cluster
    let bestProposal = null;
    let bestGapSaving = 0;

    for (const openSlot of open) {
      const openMs = new Date(openSlot.slot_datetime).getTime();

      // Don't propose the same time
      if (Math.abs(openMs - slotMs) < 60000) continue;

      // Calculate what gap saving would result
      const nearestConfirmed = confirmed
        .filter(c => c.id !== slot.id)
        .map(c => Math.abs(new Date(c.slot_datetime).getTime() - openMs))
        .sort((a, b) => a - b)[0] || Infinity;

      const currentWorstGap = Math.min(gapBefore, gapAfter) / 60000;
      const proposedNearestGap = nearestConfirmed / 60000;
      const gapSaving = currentWorstGap - proposedNearestGap;

      if (gapSaving > MIN_GAP_SAVING_MINUTES && gapSaving > bestGapSaving) {
        bestGapSaving = gapSaving;
        bestProposal = openSlot;
      }
    }

    if (bestProposal) {
      candidates.push({
        originalSlot: slot,
        proposedSlot: bestProposal,
        gapSavedMinutes: Math.round(bestGapSaving)
      });
    }
  }

  return candidates;
}

// ── PHASE 1: Send WhatsApp offers ─────────────────────────────────────────────

async function sendRescheduleOffers(campaignId) {
  const candidates = await findRescheduleCandidates(campaignId);
  logger.info(`[Optimization] Campaign ${campaignId}: ${candidates.length} reschedule candidates found`);

  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const { originalSlot, proposedSlot, gapSavedMinutes } of candidates) {
    try {
      const lang = originalSlot.language || 'he';
      const S = STRINGS[lang] || STRINGS.he;
      const name = originalSlot.contact_name || 'שלום';

      const origTime = formatTime(originalSlot.slot_datetime);
      const propTime = formatTime(proposedSlot.slot_datetime);
      const propDate = formatDate(proposedSlot.slot_datetime);

      // Soft-reserve the proposed slot so no one else grabs it while we wait
      const reserved = await pool.query(
        `UPDATE meeting_slots SET status='reserved', reserved_at=NOW()
         WHERE id=$1 AND status='open'
         RETURNING id`,
        [proposedSlot.id]
      );
      if (!reserved.rows.length) {
        logger.warn(`[Optimization] Proposed slot ${proposedSlot.id} already taken, skipping`);
        results.skipped++;
        continue;
      }

      // Create reschedule_request record
      const expiresAt = new Date(
        new Date(originalSlot.slot_datetime).getTime() - REPLY_WINDOW_HOURS * 3600000
      );

      const reqRes = await pool.query(
        `INSERT INTO reschedule_requests
           (original_slot_id, campaign_id, phone, zoho_contact_id, contact_name, language,
            original_datetime, proposed_slot_id, proposed_datetime,
            gap_saved_minutes, status, wa_sent_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW(),$11)
         RETURNING id`,
        [
          originalSlot.id, campaignId, originalSlot.contact_phone,
          originalSlot.zoho_contact_id || originalSlot.bs_zoho_id,
          name, lang,
          originalSlot.slot_datetime, proposedSlot.id, proposedSlot.slot_datetime,
          gapSavedMinutes, expiresAt
        ]
      );
      const reqId = reqRes.rows[0].id;

      // Send WhatsApp free-text chat message (sendWhatsAppChat, NOT sendWhatsApp which requires a template key)
      const msg = S.offer(name, origTime, propTime, propDate);
      await inforuService.sendWhatsAppChat(originalSlot.contact_phone, msg, {
        customerParameter: 'QUANTUM_RESCHEDULE',
        customerMessageId: `reschedule_${reqId}_${Date.now()}`
      });

      // Queue Vapi fallback call for 2h later
      await pool.query(
        `INSERT INTO reminder_queue
           (phone, zoho_contact_id, zoho_campaign_id, reminder_type, scheduled_at, payload)
         VALUES ($1,$2,$3,'reschedule_call',$4,$5)
         ON CONFLICT DO NOTHING`,
        [
          originalSlot.contact_phone,
          originalSlot.zoho_contact_id || null,
          campaignId,
          new Date(Date.now() + 2 * 3600000),
          JSON.stringify({ reschedule_request_id: reqId, lang, name, origTime, propTime, propDate })
        ]
      );

      logger.info(`[Optimization] Sent reschedule offer to ${originalSlot.contact_phone} (req #${reqId}, saves ${gapSavedMinutes} min)`);
      results.sent++;

    } catch (err) {
      logger.error(`[Optimization] Error processing slot ${originalSlot.id}: ${err.message}`, { stack: err.stack });
      results.errors++;
    }
  }

  return results;
}

// ── PHASE 2: Handle WhatsApp reply ─────────────────────────────────────────────

async function handleRescheduleReply(phone, messageText) {
  const reqRes = await pool.query(
    `SELECT * FROM reschedule_requests
     WHERE phone=$1 AND status='pending'
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!reqRes.rows.length) return false;

  const req = reqRes.rows[0];
  const lang = req.language || 'he';
  const S = STRINGS[lang] || STRINGS.he;
  const msg = messageText.trim();

  // Mark replied
  await pool.query(
    `UPDATE reschedule_requests SET wa_replied_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [req.id]
  );

  if (msg === '1') {
    const swapped = await performSwap(req);
    if (swapped) {
      const propTime = formatTime(req.proposed_datetime);
      const propDate = formatDate(req.proposed_datetime);
      await inforuService.sendWhatsAppChat(phone, S.accepted(req.contact_name || '', propTime, propDate));
    } else {
      await inforuService.sendWhatsAppChat(phone, S.alreadyPast);
      await pool.query(
        `UPDATE reschedule_requests SET status='expired', updated_at=NOW() WHERE id=$1`,
        [req.id]
      );
    }
  } else {
    await declineRequest(req);
    const origTime = formatTime(req.original_datetime);
    await inforuService.sendWhatsAppChat(phone, S.declined(req.contact_name || '', origTime));
  }

  return true;
}

// ── SWAP LOGIC ─────────────────────────────────────────────────────────────────

async function performSwap(req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockRes = await client.query(
      `SELECT id FROM meeting_slots
       WHERE id=$1 AND status IN ('reserved','open')
       FOR UPDATE SKIP LOCKED`,
      [req.proposed_slot_id]
    );
    if (!lockRes.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }

    const origRes = await client.query(
      `SELECT contact_phone, zoho_contact_id, contact_name, contact_address, contact_street
       FROM meeting_slots WHERE id=$1`,
      [req.original_slot_id]
    );
    if (!origRes.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    const orig = origRes.rows[0];

    await client.query(
      `UPDATE meeting_slots SET
         status='open', contact_phone=NULL, zoho_contact_id=NULL,
         contact_name=NULL, contact_address=NULL, contact_street=NULL,
         reserved_at=NULL
       WHERE id=$1`,
      [req.original_slot_id]
    );

    await client.query(
      `UPDATE meeting_slots SET
         status='confirmed', contact_phone=$1, zoho_contact_id=$2,
         contact_name=$3, contact_address=$4, contact_street=$5,
         reserved_at=NOW()
       WHERE id=$6`,
      [orig.contact_phone, orig.zoho_contact_id, orig.contact_name,
       orig.contact_address, orig.contact_street, req.proposed_slot_id]
    );

    await client.query(
      `UPDATE reschedule_requests SET status='accepted', swapped_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.id]
    );

    const newSlotRes = await client.query(
      `SELECT slot_datetime,
              TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time_str
       FROM meeting_slots WHERE id=$1`,
      [req.proposed_slot_id]
    );
    if (newSlotRes.rows.length) {
      const newSlot = newSlotRes.rows[0];
      const newDateStr = formatDate(newSlot.slot_datetime);
      const newTimeStr = newSlot.time_str;
      await client.query(
        `UPDATE bot_sessions
         SET context = jsonb_set(
           jsonb_set(context, '{confirmedSlot,dateStr}', $1::jsonb),
           '{confirmedSlot,timeStr}', $2::jsonb
         )
         WHERE phone=$3 AND zoho_campaign_id=$4`,
        [JSON.stringify(newDateStr), JSON.stringify(newTimeStr),
         req.phone, req.campaign_id]
      );
    }

    await client.query('COMMIT');
    logger.info(`[Optimization] Swap completed for req #${req.id}: slot ${req.original_slot_id} → ${req.proposed_slot_id}`);
    return true;

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[Optimization] Swap failed for req #${req.id}: ${err.message}`);
    return false;
  } finally {
    client.release();
  }
}

async function declineRequest(req) {
  await pool.query(
    `UPDATE meeting_slots SET status='open', reserved_at=NULL WHERE id=$1 AND status='reserved'`,
    [req.proposed_slot_id]
  );
  await pool.query(
    `UPDATE reschedule_requests SET status='declined', updated_at=NOW() WHERE id=$1`,
    [req.id]
  );
  await pool.query(
    `DELETE FROM reminder_queue
     WHERE phone=$1 AND reminder_type='reschedule_call'
       AND (payload->>'reschedule_request_id')::int = $2`,
    [req.phone, req.id]
  );
}

// ── EXPIRE stale pending requests ─────────────────────────────────────────────

async function expireStaleRequests() {
  const res = await pool.query(
    `UPDATE reschedule_requests SET status='expired', updated_at=NOW()
     WHERE status='pending' AND expires_at < NOW()
     RETURNING id, proposed_slot_id, phone`
  );
  for (const row of res.rows) {
    await pool.query(
      `UPDATE meeting_slots SET status='open', reserved_at=NULL
       WHERE id=$1 AND status='reserved'`,
      [row.proposed_slot_id]
    );
    logger.info(`[Optimization] Expired req #${row.id} for ${row.phone}, slot ${row.proposed_slot_id} released`);
  }
  return res.rows.length;
}

// ── Run full optimization for all active campaigns ─────────────────────────────

async function runOptimizationForAllCampaigns() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const campaignsRes = await pool.query(
    `SELECT DISTINCT campaign_id FROM meeting_slots
     WHERE status='confirmed'
       AND DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem') = $1`,
    [tomorrowStr]
  );

  const summary = { campaigns: 0, totalSent: 0, totalSkipped: 0, totalErrors: 0 };

  for (const row of campaignsRes.rows) {
    const results = await sendRescheduleOffers(row.campaign_id);
    summary.campaigns++;
    summary.totalSent    += results.sent;
    summary.totalSkipped += results.skipped;
    summary.totalErrors  += results.errors;
  }

  logger.info(`[Optimization] Run complete: ${summary.campaigns} campaigns, ${summary.totalSent} offers sent`);
  return summary;
}

module.exports = {
  runOptimizationForAllCampaigns,
  sendRescheduleOffers,
  handleRescheduleReply,
  performSwap,
  declineRequest,
  expireStaleRequests,
  findRescheduleCandidates
};
