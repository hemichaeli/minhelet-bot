/**
 * מינהלת Zoho Scheduling Service
 * Writes bot conversation results back to Zoho CRM in real-time:
 *  - Creates incoming message records (הודעות נכנסות) in the campaign
 *  - Updates contact status in campaign (confirmed / declined / pending / no_answer)
 *  - Updates custom fields on the Contact record
 *  - Pulls Mailing_Street + Mailing_City for smart slot clustering
 */

const axios = require('axios');
const { logger } = require('./logger');

const ZOHO_BASE = 'https://www.zohoapis.com/crm/v3';
const ZOHO_ACCOUNTS = 'https://accounts.zoho.com/oauth/v2/token';

// Token cache
let _token = null;
let _tokenExpiry = 0;

// ── OAUTH ─────────────────────────────────────────────────────
async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN');
  }

  const res = await axios.post(ZOHO_ACCOUNTS, null, {
    params: {
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    }
  });

  _token = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

async function zohoRequest(method, path, data = null) {
  const token = await getAccessToken();
  const config = {
    method,
    url: `${ZOHO_BASE}${path}`,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (data) config.data = data;

  const res = await axios(config);
  return res.data;
}

// ── ADDRESS HELPERS ───────────────────────────────────────────

/**
 * Extract street name only from a full address string.
 * "רחוב הרצל 12 דירה 4" → "הרצל"
 * Strips common Hebrew prefixes and trailing numbers/apt info.
 */
function extractStreet(mailingStreet) {
  if (!mailingStreet) return null;
  return mailingStreet
    .replace(/^(רחוב|רח'|שד'|שדרות|סמטת|סמטא|דרך|כיכר|ככר)\s*/i, '')
    .replace(/\s+\d+.*$/, '')   // strip house number and everything after
    .trim() || null;
}

/**
 * Build a compact full address string from Zoho contact fields.
 * "רחוב הרצל 12, תל אביב"
 */
function buildAddress(mailingStreet, mailingCity) {
  return [mailingStreet, mailingCity].filter(Boolean).join(', ') || null;
}

// ── CONTACT LOOKUP ────────────────────────────────────────────
/**
 * Find a Zoho Contact by phone number.
 * Returns contact object including address fields, or null.
 *
 * Address fields pulled:
 *   Mailing_Street  - "רחוב הרצל 12"
 *   Mailing_City    - "תל אביב"
 *   Mailing_Zip     - optional
 */
async function findContactByPhone(phone) {
  try {
    const normalized = normalizePhone(phone);
    const variants = [phone, normalized, phone.replace(/\D/g, '')];

    const FIELDS = 'id,Full_Name,Email,Phone,Mobile,Mailing_Street,Mailing_City,Mailing_Zip,Language';

    for (const variant of variants) {
      const res = await zohoRequest('GET',
        `/Contacts/search?phone=${encodeURIComponent(variant)}&fields=${FIELDS}`
      );
      if (res.data && res.data.length > 0) {
        const c = res.data[0];
        return {
          ...c,
          // Normalised address helpers (ready for bot_sessions)
          contact_address: buildAddress(c.Mailing_Street, c.Mailing_City),
          contact_street:  extractStreet(c.Mailing_Street),
          contact_building_no: (c.Mailing_Street || '').match(/\d+/)?.[0] || null
        };
      }
    }
    return null;
  } catch (err) {
    logger.warn(`[ZohoScheduling] Contact lookup failed for ${phone}:`, err.message);
    return null;
  }
}

// ── CAMPAIGN CONTACT STATUS ───────────────────────────────────
async function updateCampaignContactStatus(campaignId, contactId, status, notes = '') {
  if (!campaignId || !contactId) return;

  const STATUS_LABELS = {
    pending: 'ממתין',
    bot_sent: 'WA נשלח',
    answered: 'ענה',
    confirmed: 'אישר פגישה ✅',
    declined: 'סירב ❌',
    maybe: 'אולי 🤷',
    no_answer_24h: 'לא ענה 24ש',
    no_answer_48h: 'לא ענה 48ש'
  };

  try {
    await zohoRequest('PUT', `/Campaigns/${campaignId}/Contacts/${contactId}`, {
      data: [{
        Status: STATUS_LABELS[status] || status,
        ...(notes ? { Description: notes } : {})
      }]
    });

    await zohoRequest('PUT', `/Contacts/${contactId}`, {
      data: [{
        Scheduling_Status: STATUS_LABELS[status] || status,
        Scheduling_Last_Update: new Date().toISOString()
      }]
    });

    logger.info(`[ZohoScheduling] Updated contact ${contactId} in campaign ${campaignId}: ${status}`);
  } catch (err) {
    logger.warn(`[ZohoScheduling] Status update failed:`, err.message);
  }
}

// ── INCOMING MESSAGE LOG ──────────────────────────────────────
async function logIncomingMessage({ campaignId, contactId, contactName, phone, messageContent, direction = 'נכנסת', subject = '' }) {
  if (!campaignId) return null;

  try {
    const res = await zohoRequest('POST', `/Campaigns/${campaignId}/Campaign_Messages`, {
      data: [{
        Direction: direction,
        Message_Content: messageContent,
        Contact: contactId ? { id: contactId } : null,
        Phone: phone,
        Subject: subject || 'BOT תשובה',
        Channel: 'WhatsApp',
        Status: 'Delivered',
        Sent_Time: new Date().toISOString()
      }]
    });

    logger.info(`[ZohoScheduling] Logged incoming message for campaign ${campaignId}`);
    return res?.data?.[0]?.details?.id || null;
  } catch (err) {
    if (contactId) await logAsContactNote(contactId, campaignId, messageContent);
    logger.warn(`[ZohoScheduling] Message log failed, used note fallback:`, err.message);
    return null;
  }
}

async function logAsContactNote(contactId, campaignId, content) {
  try {
    await zohoRequest('POST', `/Notes`, {
      data: [{
        Note_Title: `מינהלת BOT - קמפיין ${campaignId}`,
        Note_Content: content,
        Parent_Id: { id: contactId },
        se_module: 'Contacts'
      }]
    });
  } catch (err) {
    logger.warn(`[ZohoScheduling] Note fallback also failed:`, err.message);
  }
}

// ── BOOKING CONFIRMATION ──────────────────────────────────────
async function createMeetingActivity({ contactId, campaignId, meetingType, meetingDatetime, representativeName, location }) {
  if (!contactId) return null;

  const TYPE_LABELS = {
    consultation: 'פגישת ייעוץ - מינהלת',
    physical: 'פגישה פיזית - מינהלת',
    appraiser: 'ביקור שמאי - מינהלת',
    surveyor: 'ביקור מודד - מינהלת',
    signing_ceremony: 'כנס חתימות - מינהלת'
  };

  try {
    const startDt = new Date(meetingDatetime);
    const endDt = new Date(startDt.getTime() + 45 * 60000);

    const res = await zohoRequest('POST', `/Events`, {
      data: [{
        Event_Title: TYPE_LABELS[meetingType] || meetingType,
        Start_DateTime: startDt.toISOString(),
        End_DateTime: endDt.toISOString(),
        Who_Id: { id: contactId },
        Description: `קמפיין: ${campaignId}\nנציג: ${representativeName || ''}\nמיקום: ${location || ''}`,
        Location: location || '',
        $se_module: 'Events'
      }]
    });

    const eventId = res?.data?.[0]?.details?.id;
    logger.info(`[ZohoScheduling] Created event ${eventId} for contact ${contactId}`);
    return eventId;
  } catch (err) {
    logger.warn(`[ZohoScheduling] Event creation failed:`, err.message);
    return null;
  }
}

// ── CAMPAIGN CONTACTS ────────────────────────────────────────
/**
 * Fetch all contacts for a Zoho Campaign.
 * Returns array of { id, name, phone, email, language, status, contact_address, contact_street }
 */
async function getCampaignContacts(campaignId) {
  if (!campaignId) return [];
  try {
    const res = await zohoRequest('GET',
      `/Campaigns/${campaignId}/Contacts?fields=id,Full_Name,Phone,Mobile,Email,Member_Status,Mailing_Street,Mailing_City&per_page=200`
    );
    const members = res.data || [];
    return members.map(m => {
      const name = m.Full_Name || '';
      const isCyrillic = /[\u0400-\u04FF]/.test(name);
      const phone = m.Mobile || m.Phone || '';
      return {
        id: m.id,
        name,
        phone: phone.replace(/[^\d+]/g, ''),
        email: m.Email || '',
        language: isCyrillic ? 'ru' : 'he',
        status: (m.Member_Status || 'pending').toLowerCase(),
        contact_address: buildAddress(m.Mailing_Street, m.Mailing_City),
        contact_street:  extractStreet(m.Mailing_Street),
        contact_building_no: (m.Mailing_Street || '').match(/\d+/)?.[0] || null
      };
    }).filter(c => c.phone);
  } catch (err) {
    logger.warn(`[ZohoScheduling] getCampaignContacts failed for ${campaignId}:`, err.message);
    return [];
  }
}

// ── BULK STATUS UPDATE ────────────────────────────────────────
async function markNoAnswer(campaignId, contactId, hours) {
  const status = hours >= 48 ? 'no_answer_48h' : 'no_answer_24h';
  await updateCampaignContactStatus(campaignId, contactId, status,
    `לא ענה לאחר ${hours} שעות`);
}

// ── HELPERS ───────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return '+' + digits;
  if (digits.startsWith('0')) return '+972' + digits.slice(1);
  return '+972' + digits;
}

module.exports = {
  findContactByPhone,
  getCampaignContacts,
  updateCampaignContactStatus,
  logIncomingMessage,
  createMeetingActivity,
  markNoAnswer,
  extractStreet,
  buildAddress
};
