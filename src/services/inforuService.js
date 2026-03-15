const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * INFORU SMS + WhatsApp Service for QUANTUM
 * SMS: UAPI XML endpoint
 * WhatsApp: CAPI v2 REST endpoint
 */

const INFORU_XML_URL = 'https://uapi.inforu.co.il/SendMessageXml.ashx';
const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEFAULT_SENDER = '037572229';

// --- SMS Templates (free-text) ---
const SMS_TEMPLATES = {
  seller_initial: {
    name: 'פנייה ראשונית למוכר',
    template: `שלום {name},\nראיתי שיש לך נכס למכירה ב{address}, {city}.\nאני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\nיש לנו קונים רציניים לאזור שלך.\nאשמח לשוחח - {agent_phone}\nQUANTUM Real Estate`,
    maxLength: 480
  },
  seller_followup: {
    name: 'מעקב למוכר',
    template: `שלום {name},\nפניתי אליך לפני מספר ימים בנוגע לנכס ב{address}.\nעדיין יש לנו עניין רב מצד קונים.\nנשמח לעזור - {agent_phone}\nQUANTUM`,
    maxLength: 320
  },
  buyer_opportunity: {
    name: 'הזדמנות לקונה',
    template: `שלום {name},\nיש לנו הזדמנות חדשה שמתאימה לך:\n{complex_name}, {city}\nמכפיל: x{multiplier} | סטטוס: {status}\nלפרטים: {agent_phone}\nQUANTUM`,
    maxLength: 320
  },
  kones_inquiry: {
    name: 'פנייה לכונס',
    template: `לכבוד עו"ד {name},\nבנוגע לנכס בכינוס ב{address}, {city}.\nאנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\nיש לנו קונים פוטנציאליים מיידיים.\nנשמח לשיתוף פעולה - {agent_phone}`,
    maxLength: 480
  }
};

// --- WhatsApp Templates (QUANTUM account - capi.inforu.co.il) ---
// Updated 2026-03-11: added visit_invite_button template
const WA_TEMPLATES = {
  // ---- scheduling / bot templates ----
  meeting_invite:         { templateId: '141183', name: 'הזמנה למפגש נציגות',                                    params: [], hasButtons: false },
  meeting_reminder:       { templateId: '141181', name: 'תזכורת לאישור הגעה למפגש נציגות',                       params: [], hasButtons: false },
  zoom_link:              { templateId: '141453', name: 'לינק למפגש זום',                                         params: [], hasButtons: false },
  zoom_confirm:           { templateId: '141199', name: 'תזכורת לאישור השתתפות במפגש זום',                        params: [], hasButtons: false },
  zoom_confirm_reply:     { templateId: '141203', name: 'תזכורת לאישור השתתפות במפגש זום (אישור בהודעה חוזרת)',   params: [], hasButtons: false },

  // ---- professional visit invite — CTA button ----
  //
  // ⚠️  PENDING_META_APPROVAL
  // After approval via INFORU portal → replace templateId value below.
  //
  // === Template text to submit to Meta (via INFORU portal) ===
  //
  //   שלום {{1}},
  //   ביום {{2}} יגיע {{3}} למתחם לצורך מדידת הדירות במתחם.
  //   הסיור תואם עם הנציגות ועם עורכי הדין המייצגים אתכם בפרויקט.
  //   מדובר בסיור קצר בדירה, שאיננו רועש ואיננו מלכלך.
  //
  //   לצורך תיאום, יש ללחוץ על הכפתור, פה בתחתית ההודעה👇
  //
  //   תודה רבה על שיתוף הפעולה,
  //   {{4}}
  //
  // === Button (Call-To-Action / URL) ===
  //   Label:    לתיאום לחצו
  //   Type:     URL
  //   Base URL: https://pinuy-binuy-analyzer-production.up.railway.app/booking/
  //   Dynamic suffix: {{1}}   ← booking token appended at send time
  //
  // === Body variables ===
  //   {{1}} = שם פרטי (firstName)
  //   {{2}} = תאריך הביקור (visitDate)  e.g. "א', 15.04.2026"
  //   {{3}} = שמאי / מודד (professionalType)
  //   {{4}} = שם היזם (developerName)
  //
  // === Button variable ===
  //   ButtonIndex 0, Value = booking token (suffix appended to base URL)
  //
  visit_invite_button: {
    templateId: 'PENDING_META_APPROVAL',
    name: 'הזמנה לביקור מקצועי עם כפתור תיאום',
    params: ['firstName', 'visitDate', 'professionalType', 'developerName'],
    hasButtons: true,
    buttonBaseUrl: 'https://pinuy-binuy-analyzer-production.up.railway.app/booking/',
    pendingApproval: true
  },

  // ---- ceremony templates ----
  ceremony_42:            { templateId: '158832', name: 'כנס ראשון - 42',                                         params: [], hasButtons: false },
  ceremony_44:            { templateId: '158833', name: 'כנס ראשון - 44',                                         params: [], hasButtons: false },
  ceremony_42_g:          { templateId: '159311', name: 'G - כנס ראשון - 42',                                     params: [], hasButtons: false },
  ceremony_44_g:          { templateId: '159307', name: 'G - כנס ראשון - 44',                                     params: [], hasButtons: false },
  reminder_42:            { templateId: '159175', name: 'G - תזכורת להשיב להזמנה (42)',                            params: [], hasButtons: false },
  reminder_44:            { templateId: '159176', name: 'G - תזכורת להשיב להזמנה (44)',                            params: [], hasButtons: false },
  // ---- test / generic ----
  test_message:           { templateId: '157823', name: 'תבנית בדיקה גינדי (2)',                                   params: [], hasButtons: false },
  test_message_basic:     { templateId: '156872', name: 'תבנית בדיקה גינדי',                                       params: [], hasButtons: false },
  // ---- legacy aliases (kept for backward compat) ----
  institutional_message:  { templateId: '157823', name: 'תבנית בדיקה גינדי (2)',                                   params: [], hasButtons: false },
  institutional_original: { templateId: '156872', name: 'תבנית בדיקה גינדי',                                       params: [], hasButtons: false },
  representative_intro:   { templateId: '141183', name: 'הזמנה למפגש נציגות',                                    params: [], hasButtons: false },
  project_attendance:     { templateId: '141181', name: 'תזכורת לאישור הגעה למפגש נציגות',                       params: [], hasButtons: false },
  meeting_attendance:     { templateId: '141183', name: 'הזמנה למפגש נציגות',                                    params: [], hasButtons: false },
  file_link_basic:        { templateId: '157823', name: 'תבנית בדיקה גינדי (2)',                                   params: [], hasButtons: false },
  file_link_updated:      { templateId: '157823', name: 'תבנית בדיקה גינדי (2)',                                   params: [], hasButtons: false },
};

const QUANTUM_WA_MAPPINGS = {
  seller_initial:   'file_link_basic',
  seller_followup:  'institutional_message',
  buyer_opportunity:'project_attendance',
  kones_inquiry:    'representative_intro',
  test_message:     'test_message'
};

// ==================== AUTH ====================

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// ==================== SMS ====================

function buildXmlPayload(username, password, recipients, message, senderName = DEFAULT_SENDER) {
  const esc = (str) => String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const phones = Array.isArray(recipients) ? recipients : [recipients];
  return `<Inforu>
<User>
<Username>${esc(username)}</Username>
<Password>${esc(password)}</Password>
</User>
<Content Type="sms">
<Message>${esc(message)}</Message>
</Content>
<Recipients>
<PhoneNumber>${esc(phones.join(';'))}</PhoneNumber>
</Recipients>
<Settings>
<Sender>${esc(senderName)}</Sender>
</Settings>
</Inforu>`;
}

async function sendSms(recipients, message, options = {}) {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhone).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers');
  const isHebrew = /[\u0590-\u05FF]/.test(message);
  const segments = Math.ceil(message.length / (isHebrew ? 70 : 160));
  const xml = buildXmlPayload(username, password, phones, message, options.senderName || DEFAULT_SENDER);
  try {
    const response = await axios.post(INFORU_XML_URL, null, {
      params: { InforuXML: xml },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      timeout: 30000
    });
    const status = parseInt((response.data.match(/<Status>(.*?)<\/Status>/) || [])[1] || '-999');
    const description = (response.data.match(/<Description>(.*?)<\/Description>/) || [])[1] || 'Unknown';
    const recipientCount = parseInt((response.data.match(/<NumberOfRecipients>(.*?)<\/NumberOfRecipients>/) || [])[1] || '0');
    const result = { success: status === 1, status, description, recipientsCount: recipientCount, messageSegments: segments, phones, channel: 'sms', timestamp: new Date().toISOString() };
    await logMessage(result, message, phones, { ...options, channel: 'sms' });
    if (status === 1) logger.info(`SMS sent to ${recipientCount} recipients`, { phones });
    else logger.warn('SMS failed', { status, description, phones });
    return result;
  } catch (err) {
    logger.error('SMS API error', { error: err.message });
    throw err;
  }
}

// ==================== WHATSAPP ====================

async function sendWhatsApp(recipients, templateKey, variables = {}, options = {}) {
  const actualTemplateKey = QUANTUM_WA_MAPPINGS[templateKey] || templateKey;
  const tmpl = WA_TEMPLATES[actualTemplateKey];
  if (!tmpl) throw new Error(`WhatsApp template "${templateKey}" -> "${actualTemplateKey}" not found`);
  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhoneLocal).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers');
  const templateParams = tmpl.params && tmpl.params.length > 0
    ? tmpl.params.map((paramName, idx) => ({ Name: `[#${idx + 1}#]`, Type: 'Text', Value: variables[paramName] || variables[`param${idx + 1}`] || '' }))
    : [];
  const recipientsArray = phones.map(phone => ({ Phone: phone }));
  const payload = { Data: { TemplateId: tmpl.templateId, ...(templateParams.length > 0 ? { TemplateParameters: templateParams } : {}), Recipients: recipientsArray } };
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsApp`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
      timeout: 30000
    });
    const data = response.data;
    const result = { success: data.StatusId === 1, status: data.StatusId, description: data.StatusDescription, recipientsCount: data.Data?.Recipients || 0, errors: data.Data?.Errors || null, phones, channel: 'whatsapp', templateKey: actualTemplateKey, originalTemplateKey: templateKey, templateId: tmpl.templateId, timestamp: new Date().toISOString() };
    const msgText = `[WA Template: ${tmpl.name}] ${JSON.stringify(variables)}`;
    await logMessage(result, msgText, phones, { ...options, channel: 'whatsapp', templateKey: actualTemplateKey });
    if (data.StatusId === 1) logger.info(`WhatsApp sent to ${data.Data?.Recipients} recipients`, { templateKey: actualTemplateKey, templateId: tmpl.templateId, phones });
    else logger.warn('WhatsApp send failed', { status: data.StatusId, description: data.StatusDescription, errors: data.Data?.Errors, templateKey: actualTemplateKey });
    return result;
  } catch (err) {
    logger.error('WhatsApp API error', { error: err.message, templateKey: actualTemplateKey });
    throw err;
  }
}

// ==================== VISIT INVITE WITH BUTTON ====================

/**
 * Send professional visit invitation with a CTA "לתיאום לחצו" button.
 *
 * Requires Meta-approved template 'visit_invite_button'.
 * After INFORU portal approval, update templateId in WA_TEMPLATES above.
 *
 * @param {string} phone  - Recipient phone (Israeli format, e.g. "0503016454")
 * @param {object} params
 *   @param {string} params.firstName        - דייר שם פרטי           e.g. "יצחק"
 *   @param {string} params.visitDate        - תאריך בעברית            e.g. "א', 15.04.2026"
 *   @param {string} params.professionalType - "שמאי" | "מודד"
 *   @param {string} params.developerName    - שם היזם                 e.g. "גינדי השקעות"
 *   @param {string} params.bookingToken     - טוקן ייחודי לדייר      e.g. "abc123xyz"
 *
 * @returns {object} INFORU API result
 */
async function sendVisitInviteWithButton(phone, params) {
  const tmpl = WA_TEMPLATES['visit_invite_button'];

  if (tmpl.pendingApproval) {
    logger.warn('[sendVisitInviteWithButton] Template pending Meta approval — cannot send yet', { phone });
    return { success: false, error: 'Template pending Meta approval. Submit via INFORU portal and update templateId in WA_TEMPLATES.', pendingApproval: true };
  }

  const normalizedPhone = normalizePhoneLocal(phone);
  if (!normalizedPhone) throw new Error('Invalid phone number');

  const { firstName, visitDate, professionalType, developerName, bookingToken } = params;
  if (!bookingToken) throw new Error('bookingToken is required');

  // Body parameters: {{1}}–{{4}}
  const templateParameters = [
    { Name: '[#1#]', Type: 'Text', Value: firstName || '' },
    { Name: '[#2#]', Type: 'Text', Value: visitDate || '' },
    { Name: '[#3#]', Type: 'Text', Value: professionalType || 'שמאי' },
    { Name: '[#4#]', Type: 'Text', Value: developerName || '' }
  ];

  // Button parameter: dynamic URL suffix (token appended after base URL)
  const buttonParameters = [
    { ButtonIndex: 0, Value: bookingToken }
  ];

  const payload = {
    Data: {
      TemplateId: tmpl.templateId,
      TemplateParameters: templateParameters,
      ButtonParameters: buttonParameters,
      Recipients: [{ Phone: normalizedPhone }]
    }
  };

  logger.info('[sendVisitInviteWithButton] Sending', {
    phone: normalizedPhone,
    firstName,
    visitDate,
    professionalType,
    bookingToken,
    fullUrl: tmpl.buttonBaseUrl + bookingToken
  });

  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsApp`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
      timeout: 30000,
      validateStatus: () => true
    });

    const data = response.data;
    const result = {
      success: data.StatusId === 1,
      status: data.StatusId,
      description: data.StatusDescription,
      phone: normalizedPhone,
      bookingUrl: tmpl.buttonBaseUrl + bookingToken,
      templateId: tmpl.templateId,
      channel: 'whatsapp_button',
      timestamp: new Date().toISOString()
    };

    const msgText = `[ביקור מקצועי] ${firstName} — ${visitDate} — ${professionalType} — ${tmpl.buttonBaseUrl + bookingToken}`;
    await logMessage(result, msgText, [normalizedPhone], { channel: 'whatsapp_button', templateKey: 'visit_invite_button' });

    if (data.StatusId === 1) logger.info('[sendVisitInviteWithButton] Sent', { phone: normalizedPhone, bookingToken });
    else logger.warn('[sendVisitInviteWithButton] Failed', { status: data.StatusId, description: data.StatusDescription, errors: data.Data?.Errors });

    return result;
  } catch (err) {
    logger.error('[sendVisitInviteWithButton] Error', { error: err.message, phone: normalizedPhone });
    throw err;
  }
}

// ==================== WHATSAPP CHAT ====================

/**
 * Send WhatsApp chat message (only within 24h window)
 */
async function sendWhatsAppChat(phone, message, options = {}) {
  const normalizedPhone = normalizePhoneLocal(phone);
  if (!normalizedPhone) throw new Error('Invalid phone number');

  const customerMessageId = options.customerMessageId || `q_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const customerParameter = options.customerParameter || 'QUANTUM';

  const payload = {
    Data: {
      Message: message,
      Phone: normalizedPhone,
      ...(options.mediaUrl ? { MessageMedia: options.mediaUrl } : {}),
      Settings: {
        CustomerMessageId: String(customerMessageId),
        CustomerParameter: String(customerParameter)
      }
    }
  };

  logger.info('SendWhatsAppChat payload', { phone: normalizedPhone, messageLength: message.length, customerMessageId, fullPayload: JSON.stringify(payload) });

  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
      timeout: 30000,
      validateStatus: () => true
    });

    const data = response.data;
    const httpStatus = response.status;

    logger.info('SendWhatsAppChat response', { httpStatus, responseData: JSON.stringify(data) });

    if (httpStatus >= 400) {
      return {
        success: false,
        httpStatus,
        inforuResponse: data,
        sentPayload: payload,
        phone: normalizedPhone,
        channel: 'whatsapp_chat',
        customerMessageId,
        timestamp: new Date().toISOString()
      };
    }

    const result = {
      success: data.StatusId === 1,
      status: data.StatusId,
      description: data.StatusDescription,
      customerMessageId,
      phone: normalizedPhone,
      channel: 'whatsapp_chat',
      timestamp: new Date().toISOString()
    };

    await logMessage(result, message, [normalizedPhone], { ...options, channel: 'whatsapp_chat' });
    return result;
  } catch (err) {
    logger.error('WhatsApp Chat API error', {
      error: err.message,
      phone: normalizedPhone,
      payload: JSON.stringify(payload),
      responseData: err.response?.data ? JSON.stringify(err.response.data) : null,
      responseStatus: err.response?.status
    });
    throw err;
  }
}

/**
 * Debug: send raw WhatsApp chat and return full INFORU response
 */
async function sendWhatsAppChatDebug(phone, message, rawOptions = {}) {
  const normalizedPhone = normalizePhoneLocal(phone);
  const payload = {
    Data: {
      Message: message || 'QUANTUM debug test',
      Phone: normalizedPhone || phone,
      Settings: {
        CustomerMessageId: rawOptions.customerMessageId || String(Date.now()),
        CustomerParameter: rawOptions.customerParameter || 'QUANTUM'
      }
    }
  };
  const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, payload, {
    headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
    timeout: 30000,
    validateStatus: () => true
  });
  return {
    httpStatus: response.status,
    httpStatusText: response.statusText,
    responseData: response.data,
    sentPayload: payload,
    endpoint: `${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`
  };
}

// ==================== OTHER API FUNCTIONS ====================

async function getWhatsAppTemplates() {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplateList`, { Data: {} }, { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 15000 });
    return response.data;
  } catch (err) { logger.error('Failed to get WA templates', { error: err.message }); throw err; }
}

async function getWhatsAppTemplate(templateId) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplate`, { Data: { TemplateId: String(templateId) } }, { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 15000 });
    return response.data;
  } catch (err) { logger.error('Failed to get WA template', { error: err.message, templateId }); throw err; }
}

async function pullIncomingWhatsApp(batchSize = 100) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/PullData`, { Data: { Type: 'IncomingMessagesWhatsapp', BatchSize: batchSize } }, { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 15000 });
    return response.data;
  } catch (err) { logger.error('Failed to pull WA messages', { error: err.message }); throw err; }
}

async function pullWhatsAppDLR(batchSize = 100) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/PullData`, { Data: { Type: 'DeliveryNotificationWhatsapp', BatchSize: batchSize } }, { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 15000 });
    return response.data;
  } catch (err) { logger.error('Failed to pull WA DLR', { error: err.message }); throw err; }
}

// ==================== DUAL CHANNEL & BULK ====================

async function sendDualChannel(recipients, templateKey, variables = {}, options = {}) {
  const results = { sms: null, whatsapp: null };
  try { const smsMessage = fillTemplate(templateKey, variables); results.sms = await sendSms(recipients, smsMessage, options); }
  catch (err) { results.sms = { success: false, error: err.message, channel: 'sms' }; }
  if (QUANTUM_WA_MAPPINGS[templateKey] || WA_TEMPLATES[templateKey]) {
    try { results.whatsapp = await sendWhatsApp(recipients, templateKey, variables, options); }
    catch (err) { results.whatsapp = { success: false, error: err.message, channel: 'whatsapp' }; }
  }
  return results;
}

// ==================== HELPERS ====================

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  if (cleaned.startsWith('05')) cleaned = '972' + cleaned.substring(1);
  if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
  if (cleaned.startsWith('972') && cleaned.length >= 11 && cleaned.length <= 13) return cleaned;
  if (cleaned.length >= 10 && cleaned.length <= 13) return cleaned;
  return null;
}

function normalizePhoneLocal(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+972')) cleaned = '0' + cleaned.substring(4);
  if (cleaned.startsWith('972')) cleaned = '0' + cleaned.substring(3);
  if (cleaned.startsWith('05') && cleaned.length === 10) return cleaned;
  return cleaned;
}

function fillTemplate(templateKey, variables) {
  const tmpl = SMS_TEMPLATES[templateKey];
  if (!tmpl) throw new Error(`SMS template "${templateKey}" not found`);
  let message = tmpl.template;
  for (const [key, value] of Object.entries(variables)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return message;
}

async function bulkSend(templateKey, recipientsList, options = {}) {
  const channel = options.channel || 'sms';
  const results = { total: recipientsList.length, sent: 0, failed: 0, errors: [], details: [] };
  const batchSize = options.batchSize || 10;
  const delayMs = options.delayMs || 2000;
  for (let i = 0; i < recipientsList.length; i += batchSize) {
    const batch = recipientsList.slice(i, i + batchSize);
    for (const recipient of batch) {
      try {
        let result;
        if (channel === 'whatsapp') result = await sendWhatsApp(recipient.phone, templateKey, recipient.variables || {}, options);
        else if (channel === 'dual') result = await sendDualChannel(recipient.phone, templateKey, recipient.variables || {}, options);
        else { const message = fillTemplate(templateKey, recipient.variables || {}); result = await sendSms(recipient.phone, message, options); }
        const success = channel === 'dual' ? (result.sms?.success || result.whatsapp?.success) : result.success;
        if (success) results.sent++; else { results.failed++; results.errors.push({ phone: recipient.phone, error: result.description || 'Failed' }); }
        results.details.push(result);
      } catch (err) { results.failed++; results.errors.push({ phone: recipient.phone, error: err.message }); }
    }
    if (i + batchSize < recipientsList.length) await new Promise(r => setTimeout(r, delayMs));
  }
  logger.info(`Bulk ${channel} complete: ${results.sent}/${results.total}`, { templateKey, channel });
  return results;
}

// ==================== LOGGING & STATUS ====================

async function logMessage(result, message, phones, options = {}) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS sent_messages (id SERIAL PRIMARY KEY, phone VARCHAR(20), message TEXT, template_key VARCHAR(50), status VARCHAR(20), status_code INTEGER, status_description TEXT, listing_id INTEGER, complex_id INTEGER, channel VARCHAR(20) DEFAULT 'sms', template_id VARCHAR(50), sender VARCHAR(50) DEFAULT 'QUANTUM', created_at TIMESTAMP DEFAULT NOW())`);
    for (const phone of phones) {
      await pool.query(`INSERT INTO sent_messages (phone, message, template_key, status, status_code, status_description, listing_id, complex_id, channel, template_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [phone, message.substring(0, 500), options.templateKey || null, result.success ? 'sent' : 'failed', result.status, result.description, options.listingId || null, options.complexId || null, options.channel || 'sms', result.templateId || null]);
    }
  } catch (err) { logger.warn('Failed to log message', { error: err.message }); }
}

async function getStats() {
  try {
    const stats = await pool.query(`SELECT channel, COUNT(*) as total_sent, COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful, COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed, COUNT(DISTINCT phone) as unique_recipients, MIN(created_at) as first_message, MAX(created_at) as last_message FROM sent_messages GROUP BY channel`);
    return stats.rows;
  } catch (err) { return []; }
}

async function checkAccountStatus() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) return { configured: false, error: 'INFORU credentials not set' };
  const result = { configured: true, credentialsValid: true, sms: null, whatsapp: null };
  try {
    const xml = buildXmlPayload(username, password, '0000000000', 'QUANTUM test message', DEFAULT_SENDER);
    const resp = await axios.post(INFORU_XML_URL, null, { params: { InforuXML: xml }, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, timeout: 10000 });
    const status = parseInt((resp.data.match(/<Status>(.*?)<\/Status>/) || [])[1] || '-999');
    const description = (resp.data.match(/<Description>(.*?)<\/Description>/) || [])[1] || 'Unknown';
    result.sms = { working: status === 1, status, description };
  } catch (err) { result.sms = { working: false, error: err.message }; }
  try {
    const resp = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplateList`, { Data: {} }, { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 10000 });
    const templateCount = resp.data.Data?.Count || 0;
    result.whatsapp = { working: resp.data.StatusId === 1, templateCount, status: resp.data.StatusId, description: resp.data.StatusDescription || 'Success',
      templates: templateCount > 0 ? resp.data.Data.List.slice(0, 5).map(t => ({ id: t.TemplateId, name: t.TemplateName, status: t.ApprovalStatusDescription })) : [] };
  } catch (err) { result.whatsapp = { working: false, error: err.message }; }
  return result;
}

module.exports = {
  sendSms, fillTemplate,
  sendWhatsApp, sendWhatsAppChat, sendWhatsAppChatDebug,
  sendVisitInviteWithButton,
  getWhatsAppTemplates, getWhatsAppTemplate,
  pullIncomingWhatsApp, pullWhatsAppDLR,
  sendDualChannel, bulkSend,
  normalizePhone, normalizePhoneLocal,
  getStats, checkAccountStatus,
  SMS_TEMPLATES, WA_TEMPLATES, QUANTUM_WA_MAPPINGS
};
