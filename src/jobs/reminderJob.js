/**
 * QUANTUM Reminder Job v2.0
 *
 * Runs every minute, processes reminder_queue.
 *
 * Types:
 *   reminder_24h         — first WA nudge (old style, legacy)
 *   bot_followup_48h     — second WA nudge (old style, legacy)
 *   pre_meeting_24h      — day-before meeting reminder
 *   pre_meeting_2h       — 2h-before meeting reminder
 *   reschedule_call      — Vapi call to confirm a rescheduling offer
 *   no_reply_reminder_1  — NEW: first no-reply WA with booking link
 *   no_reply_reminder_2  — NEW: second (urgent) no-reply WA with booking link
 *   no_reply_vapi_call   — NEW: Vapi scheduling call if contact still unresponsive
 */

const pool          = require('../db/pool');
const inforuService = require('../services/inforuService');
const zoho          = require('../services/zohoSchedulingService');
const { logger }    = require('../services/logger');
const axios         = require('axios');

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── Meeting type labels ───────────────────────────────────────
const MEETING_TYPE_LABELS = {
  he: {
    signing_ceremony: 'כנס החתימות',
    appraiser:        'ביקור השמאי',
    surveyor:         'ביקור המודד',
    consultation:     'פגישת הייעוץ',
    physical:         'הפגישה במשרד',
  },
  ru: {
    signing_ceremony: 'церемонии подписания',
    appraiser:        'визита оценщика',
    surveyor:         'визита геодезиста',
    consultation:     'консультации',
    physical:         'встречи в офисе',
  }
};

// ── String templates ──────────────────────────────────────────
const STRINGS = {
  he: {
    reminder_24h: (name, campaign) =>
      `שלום ${name} 👋\nQUANTUM כאן.\n\nעדיין לא קיבלנו ממך תשובה לגבי *${campaign}*.\nענה/י *1* ונתאם עכשיו.`,
    bot_followup_48h: (name, campaign) =>
      `שלום ${name} 👋\nQUANTUM שוב.\n\nזו ההזדמנות האחרונה לתאם את *${campaign}*.\nענה/י *1* ונסגור מיד.`,
    pre_meeting_24h: (name, type, date, time) =>
      `שלום ${name} 👋\n*תזכורת:* ${type} מחר\n📅 ${date} ⏰ ${time}\n\nלביטול/שינוי - ענה/י 0.`,
    pre_meeting_2h: (name, type, time) =>
      `שלום ${name} 👋\nבעוד כ-2 שעות: *${type}* ב-⏰ ${time}\n\nנתראה! 🤝`,
    no_reply_reminder_1: (name, typeLabel, url) =>
      `שלום ${name} 👋\nQUANTUM כאן.\n\nשלחנו לך הודעה בנוגע ל${typeLabel} — עדיין לא קיבלנו ממך תגובה.\n\n📅 לבחירת מועד נוח, לחץ/י:\n${url}\n\nהקישור תקף 48 שעות.`,
    no_reply_reminder_2: (name, typeLabel, url) =>
      `שלום ${name} 👋\nQUANTUM שוב.\n\n⚠️ לא תיאמת עדיין ${typeLabel}.\nזו הודעה אחרונה — אחרי זה נתקשר אליך.\n\n📅 לתיאום מהיר:\n${url}`,
  },
  ru: {
    reminder_24h: (name, campaign) =>
      `Здравствуйте, ${name} 👋\nQUANTUM на связи.\n\nМы ещё не получили ваш ответ по *${campaign}*.\nНажмите *1* для записи.`,
    bot_followup_48h: (name, campaign) =>
      `Здравствуйте, ${name} 👋\nQUANTUM снова.\n\nПоследний шанс записаться на *${campaign}*.\nНажмите *1* прямо сейчас.`,
    pre_meeting_24h: (name, type, date, time) =>
      `Здравствуйте, ${name} 👋\n*Напоминание:* ${type} завтра\n📅 ${date} ⏰ ${time}\n\nДля отмены/переноса - ответьте 0.`,
    pre_meeting_2h: (name, type, time) =>
      `Здравствуйте, ${name} 👋\nЧерез ~2 часа: *${type}* в ⏰ ${time}\n\nДо встречи! 🤝`,
    no_reply_reminder_1: (name, typeLabel, url) =>
      `Здравствуйте, ${name} 👋\nQUANTUM на связи.\n\nМы отправляли вам сообщение насчёт ${typeLabel} — ответа не получили.\n\n📅 Запишитесь по ссылке:\n${url}\n\nСсылка действует 48 часов.`,
    no_reply_reminder_2: (name, typeLabel, url) =>
      `Здравствуйте, ${name} 👋\nQUANTUM снова.\n\n⚠️ Вы ещё не записались на ${typeLabel}.\nПоследнее сообщение — после этого мы позвоним.\n\n📅 Запишитесь:\n${url}`,
  }
};

// ─────────────────────────────────────────────────────────────
// MAIN PROCESSOR
// ─────────────────────────────────────────────────────────────

async function processReminderQueue() {
  const now = new Date();
  const res = await pool.query(
    `SELECT rq.*, csc.meeting_type, csc.reminder_delay_hours, csc.bot_followup_delay_hours
     FROM reminder_queue rq
     LEFT JOIN campaign_schedule_config csc ON rq.zoho_campaign_id = csc.zoho_campaign_id
     WHERE rq.status='pending' AND rq.scheduled_at <= $1
     ORDER BY rq.scheduled_at ASC LIMIT 50`,
    [now]
  );

  for (const reminder of res.rows) {
    try {
      await processOne(reminder);
    } catch (err) {
      logger.error(`[ReminderJob] Failed id=${reminder.id}:`, err.message);
      await pool.query(`UPDATE reminder_queue SET status='failed' WHERE id=$1`, [reminder.id]);
    }
  }
}

async function processOne(reminder) {
  const { id, phone, reminder_type, payload, zoho_campaign_id, zoho_contact_id } = reminder;
  const data        = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
  const lang        = data.language || data.lang || 'he';
  const S           = STRINGS[lang] || STRINGS.he;
  const contactName = data.contactName || data.name || '';
  const campaignName = data.campaignName || zoho_campaign_id;

  let message = null;

  switch (reminder_type) {

    // ── Legacy types ──────────────────────────────────────────

    case 'reminder_24h':
      message = S.reminder_24h(contactName, campaignName);
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 24).catch(() => {});
      break;

    case 'bot_followup_48h':
      message = S.bot_followup_48h(contactName, campaignName);
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 48).catch(() => {});
      await pool.query(
        `UPDATE bot_sessions SET state='confirm_identity', context='{}' WHERE phone=$1 AND zoho_campaign_id=$2`,
        [phone, zoho_campaign_id]
      );
      break;

    case 'pre_meeting_24h':
      message = S.pre_meeting_24h(
        contactName,
        data.meetingType || '',
        data.meetingDate || '',
        data.meetingTime || ''
      );
      break;

    case 'pre_meeting_2h':
      message = S.pre_meeting_2h(
        contactName,
        data.meetingType || '',
        data.meetingTime || ''
      );
      break;

    case 'reschedule_call':
      await handleRescheduleCall(reminder, data);
      break;

    // ── NEW: No-reply follow-up types ─────────────────────────

    case 'no_reply_reminder_1':
    case 'no_reply_reminder_2': {
      // Skip if contact already booked
      const sessionCheck = await pool.query(
        `SELECT state, booking_token FROM bot_sessions
         WHERE phone=$1 AND zoho_campaign_id=$2`,
        [phone, zoho_campaign_id]
      );
      const s = sessionCheck.rows[0];
      if (s?.state === 'confirmed' || s?.state === 'booking_link_sent') {
        logger.info(`[ReminderJob] ${reminder_type} skipped — state=${s?.state} for ${phone}`);
        break;
      }

      const mt        = data.meetingType || reminder.meeting_type || '';
      const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[mt] || 'הפגישה';
      const url       = data.bookingUrl
        || (s?.booking_token ? `${BASE_URL}/booking/${s.booking_token}` : null);

      if (!url) {
        logger.warn(`[ReminderJob] ${reminder_type} skipped — no booking_url for ${phone}`);
        break;
      }

      message = reminder_type === 'no_reply_reminder_1'
        ? S.no_reply_reminder_1(contactName, typeLabel, url)
        : S.no_reply_reminder_2(contactName, typeLabel, url);
      break;
    }

    case 'no_reply_vapi_call':
      await handleSchedulingVapiCall(reminder, data);
      break;

    default:
      logger.warn(`[ReminderJob] Unknown type: ${reminder_type}`);
  }

  if (message) {
    await inforuService.sendWhatsApp(phone, message);
    zoho.logIncomingMessage({
      campaignId:     zoho_campaign_id,
      contactId:      zoho_contact_id,
      phone,
      messageContent: message,
      direction:      'יוצאת',
      subject:        `תזכורת - ${reminder_type}`
    }).catch(() => {});
  }

  await pool.query(`UPDATE reminder_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [id]);
}

// ─────────────────────────────────────────────────────────────
// SCHEDULING CONTEXT FETCHER
// Returns meeting type, event details, and speech-friendly slot list
// ─────────────────────────────────────────────────────────────

async function fetchSchedulingContext(phone, campaignId) {
  const sessionRes = await pool.query(
    `SELECT bs.*, csc.meeting_type
     FROM bot_sessions bs
     LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
     WHERE bs.phone = $1 AND bs.zoho_campaign_id = $2
     ORDER BY bs.created_at DESC LIMIT 1`,
    [phone, campaignId]
  );
  const session = sessionRes.rows[0];
  if (!session) return { meetingLabel: '', slotsText: '', slotsJson: '[]', extraContext: {} };

  const meetingType = session.meeting_type || '';
  const lang        = session.language || 'he';
  const meetingLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[meetingType] || meetingType || '';

  // ── Signing ceremony ───────────────────────────────────────
  if (meetingType === 'signing_ceremony') {
    const ceremonyRes = await pool.query(
      `SELECT sc.id, sc.location,
              TO_CHAR(sc.ceremony_date,'DD/MM/YYYY') AS date_str,
              p.name AS project_name
       FROM signing_ceremonies sc
       JOIN projects p ON sc.project_id = p.id
       WHERE sc.zoho_campaign_id=$1 AND sc.status='scheduled' AND sc.ceremony_date >= CURRENT_DATE
       ORDER BY sc.ceremony_date LIMIT 1`,
      [campaignId]
    );
    const ceremony = ceremonyRes.rows[0];
    if (!ceremony) return { meetingLabel, slotsText: '', slotsJson: '[]', extraContext: {} };

    const buildingFilter = session.ceremony_building_id
      ? `AND cst.building_id = ${parseInt(session.ceremony_building_id, 10)}`
      : '';
    const slotsRes = await pool.query(
      `SELECT DISTINCT TO_CHAR(cs.slot_time,'HH24:MI') AS time_str
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id = cst.id
       WHERE cs.ceremony_id=$1 AND cs.status='open' AND cst.is_active=true ${buildingFilter}
       ORDER BY time_str LIMIT 6`,
      [ceremony.id]
    );

    return {
      meetingLabel,
      slotsText:   slotsRes.rows.map(r => r.time_str).join(', '),
      slotsJson:   JSON.stringify(slotsRes.rows),
      extraContext: {
        projectName:      ceremony.project_name,
        ceremonyDate:     ceremony.date_str,
        ceremonyLocation: ceremony.location || '',
        ceremonyId:       ceremony.id,
        buildingId:       session.ceremony_building_id || null,
      }
    };
  }

  // ── Appraiser / Surveyor ───────────────────────────────────
  if (['appraiser', 'surveyor'].includes(meetingType)) {
    const slotsRes = await pool.query(
      `SELECT ms.id,
              TO_CHAR(ms.slot_datetime,'DD/MM/YYYY') AS date_str,
              TO_CHAR(ms.slot_datetime,'HH24:MI') AS time_str,
              pv.building_address
       FROM meeting_slots ms
       JOIN visit_professionals vp ON ms.visit_professional_id = vp.id
       JOIN professional_visits pv ON vp.visit_id = pv.id
       WHERE pv.campaign_id = $1
         AND ($2::text IS NULL OR pv.building_address = $2)
         AND ms.status = 'open' AND ms.slot_datetime > NOW()
       ORDER BY ms.slot_datetime LIMIT 6`,
      [campaignId, session.building_address || null]
    );
    const slotsText = slotsRes.rows
      .map(r => `${r.date_str} ב-${r.time_str}`)
      .join(', ');
    return {
      meetingLabel,
      slotsText,
      slotsJson:    JSON.stringify(slotsRes.rows),
      extraContext: { buildingAddress: session.building_address || '' }
    };
  }

  // ── Regular meeting ────────────────────────────────────────
  const slotsRes = await pool.query(
    `SELECT id,
            TO_CHAR(slot_datetime,'DD/MM/YYYY') AS date_str,
            TO_CHAR(slot_datetime,'HH24:MI') AS time_str,
            representative_name
     FROM meeting_slots
     WHERE campaign_id=$1 AND status='open' AND slot_datetime > NOW()
       AND visit_professional_id IS NULL
     ORDER BY slot_datetime LIMIT 6`,
    [campaignId]
  );
  const slotsText = slotsRes.rows
    .map(r => `${r.date_str} ב-${r.time_str}`)
    .join(', ');
  return {
    meetingLabel,
    slotsText,
    slotsJson:    JSON.stringify(slotsRes.rows),
    extraContext: {}
  };
}

// ─────────────────────────────────────────────────────────────
// SCHEDULING VAPI CALL HANDLER
// Called when no_reply_vapi_call fires — places an outbound Vapi call
// that explains the event and lets the contact book a slot verbally.
// ─────────────────────────────────────────────────────────────

async function handleSchedulingVapiCall(reminder, data) {
  const { phone, zoho_campaign_id, zoho_contact_id } = reminder;

  // Skip if already booked
  const sessionCheck = await pool.query(
    `SELECT state FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id=$2`,
    [phone, zoho_campaign_id]
  );
  if (['confirmed', 'booking_link_sent'].includes(sessionCheck.rows[0]?.state)) {
    logger.info(`[ReminderJob] no_reply_vapi_call skipped — ${sessionCheck.rows[0]?.state} for ${phone}`);
    return;
  }

  const apiKey       = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId  = process.env.VAPI_ASSISTANT_SCHEDULING;

  // Fallback: if Vapi scheduling assistant not configured, send a WA instead
  if (!apiKey || !phoneNumberId || !assistantId) {
    logger.warn('[ReminderJob] VAPI_ASSISTANT_SCHEDULING not set — sending WA fallback', { phone });
    const url = data.bookingUrl;
    if (url) {
      const lang      = data.language || 'he';
      const mt        = data.meetingType || '';
      const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[mt] || 'הפגישה';
      const msg = lang === 'ru'
        ? `Здравствуйте, ${data.contactName || ''} 👋\nQUANTUM: мы не смогли дозвониться. Запишитесь на ${typeLabel}:\n${url}`
        : `שלום ${data.contactName || ''} 👋\nQUANTUM: ניסינו להתקשר. תאם/י ${typeLabel}:\n${url}`;
      await inforuService.sendWhatsApp(phone, msg).catch(() => {});
    }
    return;
  }

  // Fetch full context from DB
  let ctx = { meetingLabel: '', slotsText: '', slotsJson: '[]', extraContext: {} };
  try {
    ctx = await fetchSchedulingContext(phone, zoho_campaign_id);
  } catch (e) {
    logger.warn('[ReminderJob] fetchSchedulingContext error:', e.message);
    const lang = data.language || 'he';
    ctx.meetingLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[data.meetingType || ''] || '';
  }

  const lang        = data.language || 'he';
  const contactName = data.contactName || '';
  const { meetingLabel, slotsText, slotsJson, extraContext } = ctx;

  const normalized = phone.replace(/\D/g, '');
  const intlPhone  = normalized.startsWith('972') ? `+${normalized}`
    : normalized.startsWith('0') ? `+972${normalized.slice(1)}`
    : `+${normalized}`;

  // Build context-aware system prompt + first message
  let systemPrompt, firstMessage;

  if (lang === 'ru') {
    const eventInfo = extraContext.projectName
      ? `\nПроект: ${extraContext.projectName}.\nДата: ${extraContext.ceremonyDate}.\nМесто: ${extraContext.ceremonyLocation || 'уточнить'}.`
      : extraContext.buildingAddress ? `\nАдрес объекта: ${extraContext.buildingAddress}.` : '';

    systemPrompt = `Вы представитель компании QUANTUM (пинуй-бинуй, реновация зданий в Израиле).
Имя клиента: ${contactName || 'клиент'}.
Цель звонка: записать клиента на ${meetingLabel}.${eventInfo}
${slotsText ? `Доступные слоты: ${slotsText}.` : 'Уточните время у клиента.'}
Объясните, что такое ${meetingLabel} и почему важно принять участие.
Предложите клиенту выбрать один из доступных слотов.
Когда клиент выбирает время — вызовите инструмент bookSlot с параметром time_str в формате ЧЧ:ММ.
Говорите кратко, по-деловому. Максимум 2 минуты. Язык: русский.`;

    firstMessage = `Здравствуйте${contactName ? `, ${contactName}` : ''}! Это QUANTUM. Мы несколько раз отправляли вам сообщение о ${meetingLabel}. Вам удобно поговорить?`;
  } else {
    const eventInfo = extraContext.projectName
      ? `\nשם הפרויקט: ${extraContext.projectName}.\nתאריך: ${extraContext.ceremonyDate}.\nמיקום: ${extraContext.ceremonyLocation || 'יועבר בנפרד'}.`
      : extraContext.buildingAddress ? `\nבניין: ${extraContext.buildingAddress}.` : '';

    systemPrompt = `אתה נציג QUANTUM נדלן, חברה המתמחה בפינוי-בינוי.
שם הדייר: ${contactName || 'שלום'}.
מטרת השיחה: לתאם ${meetingLabel}.${eventInfo}
${slotsText ? `מועדים פנויים: ${slotsText}.` : 'יש לברר מועד מתאים עם הדייר.'}
הסבר לדייר מה זה ${meetingLabel}, למה חשוב לבוא/להגיע, ובקש שיבחר מועד מהרשימה.
כשהדייר בוחר מועד — קרא לכלי bookSlot עם הפרמטר time_str בפורמט HH:MM.
שיחה קצרה ועניינית, עד 2 דקות. שפה: עברית.`;

    firstMessage = `שלום${contactName ? ` ${contactName}` : ''}! כאן QUANTUM. שלחנו לך כמה הודעות בנוגע ל${meetingLabel}. נוח לך לדבר רגע?`;
  }

  try {
    const resp = await axios.post('https://api.vapi.ai/call/phone', {
      phoneNumberId,
      assistantId,
      customer: { number: intlPhone, name: contactName || undefined },
      assistantOverrides: {
        firstMessage,
        model: {
          messages: [{ role: 'system', content: systemPrompt }]
        },
        variableValues: {
          lead_name:       contactName,
          meeting_type:    meetingLabel,
          available_slots: slotsText || '',
          slots_json:      slotsJson,
          campaign_id:     zoho_campaign_id,
        },
        metadata: {
          agent_type:      'scheduling_followup',
          campaign_id:     zoho_campaign_id,
          contact_id:      zoho_contact_id,
          quantum_source:  'no_reply_vapi_call'
        }
      }
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    logger.info(`[ReminderJob] scheduling call initiated: ${resp.data?.id} → ${intlPhone}`);

    pool.query(
      `INSERT INTO vapi_calls (call_id, phone, agent_type, status, metadata, created_at)
       VALUES ($1,$2,'scheduling_followup','initiated',$3,NOW())
       ON CONFLICT (call_id) DO NOTHING`,
      [resp.data?.id, phone, JSON.stringify({ campaign_id: zoho_campaign_id })]
    ).catch(() => {});

  } catch (err) {
    logger.error(
      `[ReminderJob] scheduling Vapi call failed ${intlPhone}: ${err.response?.data?.message || err.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// RESCHEDULE CALL HANDLER (existing)
// ─────────────────────────────────────────────────────────────

async function handleRescheduleCall(reminder, data) {
  const { phone, zoho_campaign_id } = reminder;
  const { reschedule_request_id, lang, name, origTime, propTime, propDate } = data;

  if (reschedule_request_id) {
    const reqRes = await pool.query(
      `SELECT status FROM reschedule_requests WHERE id=$1`,
      [reschedule_request_id]
    );
    if (reqRes.rows.length && reqRes.rows[0].status !== 'pending') {
      logger.info(`[ReminderJob] reschedule_call skipped — req #${reschedule_request_id} already ${reqRes.rows[0].status}`);
      return;
    }
  }

  const apiKey       = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId  = process.env.VAPI_ASSISTANT_RESCHEDULE
    || process.env.VAPI_ASSISTANT_APPOINTMENT
    || process.env.VAPI_ASSISTANT_REMINDER;

  if (!apiKey || !phoneNumberId || !assistantId) {
    logger.warn(`[ReminderJob] reschedule_call: Vapi not configured. Skipping for ${phone}`);
    return;
  }

  const normalized = phone.replace(/\D/g, '');
  const intlPhone  = normalized.startsWith('972') ? `+${normalized}`
    : normalized.startsWith('0') ? `+972${normalized.slice(1)}`
    : `+${normalized}`;

  const systemPromptOverride = lang === 'ru'
    ? `Вы представитель QUANTUM. Имя клиента: ${name || 'клиент'}.
Вы позвонили, потому что предложили перенести встречу.
Текущее время: ${origTime}. Предложенное: ${propTime} (${propDate}).
Спросите: "Хотите перенести встречу на ${propTime}? Нажмите 1 — да, 2 — нет".
Язык: русский. Разговор короткий, до 1 минуты.`
    : `אתה נציג QUANTUM. שם הלקוח: ${name || 'שלום'}.
התקשרת כי הצעת לשנות פגישה.
המועד הנוכחי: ${origTime}. הצעת: ${propTime} (${propDate}).
שאל: "האם תרצה לעבור ל-${propTime}? ענה 1 - כן, 2 - לא".
שפה: עברית. שיחה קצרה, עד דקה.`;

  try {
    const resp = await axios.post('https://api.vapi.ai/call/phone', {
      phoneNumberId,
      assistantId,
      customer: { number: intlPhone, name: name || undefined },
      assistantOverrides: {
        firstMessage: lang === 'ru'
          ? `Здравствуйте${name ? `, ${name}` : ''}! Это QUANTUM. Я звоню по поводу переноса встречи на ${propTime}. Удобно говорить?`
          : `שלום${name ? ` ${name}` : ''}! כאן QUANTUM. אני מתקשר לגבי העברת הפגישה ל-${propTime}. נוח לדבר?`,
        model: { messages: [{ role: 'system', content: systemPromptOverride }] },
        metadata: {
          reschedule_request_id,
          campaign_id: zoho_campaign_id,
          quantum_source: 'reschedule_vapi_fallback'
        }
      }
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    logger.info(`[ReminderJob] Vapi reschedule call: ${resp.data?.id} to ${intlPhone}`);

    pool.query(
      `INSERT INTO vapi_calls (call_id, phone, agent_type, status, metadata, created_at)
       VALUES ($1, $2, 'reschedule_call', 'initiated', $3, NOW())
       ON CONFLICT (call_id) DO NOTHING`,
      [resp.data?.id, phone, JSON.stringify({ reschedule_request_id, campaign_id: zoho_campaign_id })]
    ).catch(() => {});

  } catch (err) {
    logger.error(`[ReminderJob] Vapi reschedule call failed ${intlPhone}: ${err.response?.data?.message || err.message}`);
  }
}

module.exports = { processReminderQueue };
