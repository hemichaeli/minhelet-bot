/**
 * QUANTUM Zoho Service — Event Scheduler
 * שליפת מתחמים / בניינים / דיירים מ-Zoho CRM
 *
 * מבנה Zoho:
 *   Compound (מתחמים)
 *     → Buildings (בניינים) via lookup field
 *       → Assets (דירות) via lookup field
 *         → Contacts (דיירים) via LinkingModule1 / Contacts1 related list
 */

const axios = require('axios');
const { logger } = require('./logger');

const ZOHO_BASE = 'https://www.zohoapis.com/crm/v2';

// ── Token cache ────────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry  = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN env vars');
  }

  const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });

  _cachedToken = resp.data.access_token;
  _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return _cachedToken;
}

async function zohoGet(endpoint, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`${ZOHO_BASE}/${endpoint}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params,
  });
  return resp.data;
}

// ── Compounds (מתחמים) ────────────────────────────────────────────────────────

async function getCompounds(page = 1, perPage = 100) {
  try {
    const data = await zohoGet('Compound', { page, per_page: perPage, fields: 'id,Name' });
    return (data.data || []).map(c => ({ id: c.id, name: c.Name }));
  } catch (err) {
    logger.error('[ZohoSvc] getCompounds error:', err.message);
    return [];
  }
}

// ── Buildings per compound ────────────────────────────────────────────────────

async function getBuildingsByCompound(compoundId) {
  try {
    // Buildings have a lookup field to Compound — search by it
    const data = await zohoGet('Buildings', {
      per_page: 200,
      fields: 'id,Name,Address_Street,Compound',
    });
    const all = data.data || [];
    if (!compoundId) return all.map(formatBuilding);
    return all
      .filter(b => b.Compound && (b.Compound.id === compoundId || b.Compound === compoundId))
      .map(formatBuilding);
  } catch (err) {
    logger.error('[ZohoSvc] getBuildingsByCompound error:', err.message);
    return [];
  }
}

function formatBuilding(b) {
  return {
    id:       b.id,
    name:     b.Name,
    address:  b.Address_Street || b.Name,
    compound: b.Compound ? (b.Compound.name || b.Compound) : null,
  };
}

// ── Assets (דירות) per building ───────────────────────────────────────────────

async function getAssetsByBuilding(buildingId) {
  try {
    const data = await zohoGet('Assets', {
      per_page: 200,
      fields: 'id,Name,Unit_Number,Floor,Building',
    });
    const all = data.data || [];
    if (!buildingId) return all.map(formatAsset);
    return all
      .filter(a => a.Building && (a.Building.id === buildingId || a.Building === buildingId))
      .map(formatAsset);
  } catch (err) {
    logger.error('[ZohoSvc] getAssetsByBuilding error:', err.message);
    return [];
  }
}

function formatAsset(a) {
  return {
    id:          a.id,
    name:        a.Name,
    unit_number: a.Unit_Number || a.Name,
    floor:       a.Floor || null,
    building_id: a.Building ? a.Building.id : null,
  };
}

// ── Contacts (דיירים) per asset ───────────────────────────────────────────────

async function getContactsByAsset(assetId) {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(
      `${ZOHO_BASE}/Assets/${assetId}/Contacts1`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { per_page: 50, fields: 'id,Full_Name,First_Name,Last_Name,Phone,Mobile,Email' },
      }
    );
    const contacts = resp.data.data || [];
    return contacts.map(c => ({
      id:    c.id,
      name:  c.Full_Name || `${c.First_Name || ''} ${c.Last_Name || ''}`.trim(),
      phone: c.Mobile || c.Phone || null,
      email: c.Email || null,
    }));
  } catch (err) {
    if (err.response && err.response.status === 204) return []; // no content
    logger.warn(`[ZohoSvc] getContactsByAsset(${assetId}) error:`, err.message);
    return [];
  }
}

// ── Main: get all residents for an event (by compound + buildings) ─────────────

/**
 * Returns flat array of residents with unit/building context,
 * ready to be imported into event_attendees.
 *
 * @param {string[]} buildingIds  - Zoho Building IDs to include
 * @param {string}   compoundName - Display name for compound
 * @returns {Array<{name, phone, email, unit_number, floor, building_name, compound_name, zoho_contact_id, zoho_asset_id}>}
 */
async function getResidentsForEvent(buildingIds, compoundName = '') {
  const residents = [];

  for (const buildingId of buildingIds) {
    let buildingName = buildingId;
    try {
      const bData = await zohoGet(`Buildings/${buildingId}`, { fields: 'id,Name,Address_Street' });
      const b = bData.data && bData.data[0];
      if (b) buildingName = b.Address_Street || b.Name || buildingId;
    } catch (e) {}

    const assets = await getAssetsByBuilding(buildingId);
    logger.info(`[ZohoSvc] Building ${buildingName}: ${assets.length} units`);

    for (const asset of assets) {
      const contacts = await getContactsByAsset(asset.id);
      for (const contact of contacts) {
        if (!contact.phone && !contact.email) continue; // skip if no way to reach
        residents.push({
          name:            contact.name || 'דייר',
          phone:           contact.phone,
          email:           contact.email,
          unit_number:     asset.unit_number,
          floor:           asset.floor,
          building_name:   buildingName,
          compound_name:   compoundName,
          zoho_contact_id: contact.id,
          zoho_asset_id:   asset.id,
        });
      }
    }

    // Rate limit: avoid Zoho API throttle
    await new Promise(r => setTimeout(r, 200));
  }

  return residents;
}

// ── Single compound — all buildings + residents ───────────────────────────────

async function getResidentsForCompound(compoundId, compoundName) {
  const buildings = await getBuildingsByCompound(compoundId);
  if (!buildings.length) {
    logger.warn(`[ZohoSvc] No buildings found for compound ${compoundId}`);
    return [];
  }
  const buildingIds = buildings.map(b => b.id);
  return getResidentsForEvent(buildingIds, compoundName);
}

module.exports = {
  getCompounds,
  getBuildingsByCompound,
  getAssetsByBuilding,
  getContactsByAsset,
  getResidentsForEvent,
  getResidentsForCompound,
};
