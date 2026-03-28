/**
 * מינהלת Event Scheduler Routes — v1.2
 *
 * Admin routes (Basic Auth protected):
 *   GET  /events/                        — list events
 *   POST /events/                        — create event
 *   GET  /events/:id                     — event details + attendees per station
 *   POST /events/:id/stations            — add station (auto-imports Zoho residents)
 *   POST /events/:id/stations/:sid/slots — generate slots
 *   POST /events/:id/stations/:sid/assign — auto-assign attendees to slots
 *   GET  /events/:id/report              — full report JSON
 *   GET  /events/zoho/compounds          — list Zoho compounds
 *   GET  /events/zoho/buildings/:cid     — list buildings in compound
 *
 * Professional HTML (token-protected):
 *   GET  /events/pro/:token              — attendance page
 *   POST /events/pro/:token/attendee/:id — update status
 *   GET  /events/pro/:token/pdf          — printable list
 *
 * Attendee HTML (token-protected):
 *   GET  /events/attend/:token           — confirmation page
 *   POST /events/attend/:token/confirm   — confirm/cancel/reschedule
 */

const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const { logger } = require('../services/logger');

let zohoSvc;
try { zohoSvc = require('../services/zohoResidentsService'); } catch (e) {}

const BASE_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── Basic Auth middleware (admin only) ────────────────────────────────────────

function adminAuth(req, res, next) {
  const expected = process.env.EVENT_BASIC_AUTH || 'Basic UVVBTlRVTTpkZDRhN2U5YS0xOWYyLTQzYjktOTM2Yy01YmQ0OTRlZWRjNWM=';
  const provided  = req.headers['authorization'] || '';
  if (provided === expected) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="מינהלת Events"');
  return res.status(401).send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><title>מינהלת</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.logo{color:#4fc3f7;font-size:24px;font-weight:700;margin-bottom:12px}.msg{color:#78909c;font-size:14px}</style>
</head><body><div class="box"><div class="logo">מינהלת</div><div class="msg">נדרשת הרשאת כניסה</div></div></body></html>`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(res, data)    { res.json({ success: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ success: false, error: msg }); }

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auto-import Zoho residents into a station (background, fire-and-forget) ──

async function autoImportResidents(stationId, zohoCompoundId, compoundName) {
  if (!zohoSvc || !zohoCompoundId) return;
  try {
    const residents = await zohoSvc.getResidentsForCompound(zohoCompoundId, compoundName || '');
    let inserted = 0;
    for (const r of residents) {
      const ex = await pool.query(
        'SELECT id FROM event_attendees WHERE station_id=$1 AND zoho_contact_id=$2',
        [stationId, r.zoho_contact_id]
      );
      if (ex.rows.length) continue;
      await pool.query(
        `INSERT INTO event_attendees
           (station_id, zoho_contact_id, zoho_asset_id, name, phone, unit_number, floor, building_name, compound_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [stationId, r.zoho_contact_id, r.zoho_asset_id, r.name, r.phone,
         r.unit_number, r.floor, r.building_name, r.compound_name]
      );
      inserted++;
    }
    logger.info(`[Events] Auto-imported ${inserted}/${residents.length} residents → station ${stationId}`);
  } catch (e) {
    logger.error(`[Events] Auto-import error (station ${stationId}):`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC TOKEN ROUTES — must come BEFORE adminAuth middleware
// ═══════════════════════════════════════════════════════════════════════════════

// ── Professional page ─────────────────────────────────────────────────────────

router.get('/pro/:token', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.*, e.title, e.event_date, e.location, e.compound_name, e.zoho_compound_id FROM event_stations s JOIN minhelet_events e ON e.id=s.event_id WHERE s.token=$1',
      [req.params.token]
    );
    if (!st.length) return res.status(404).send('<h2>קישור לא תקין</h2>');
    const station = st[0];

    const { rows: attendees } = await pool.query(`
      SELECT a.*, sl.start_time, sl.end_time
      FROM event_attendees a
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.station_id = $1
      ORDER BY sl.start_time NULLS LAST, a.building_name, a.unit_number
    `, [station.id]);

    const roleLabel = { lawyer:'עורך דין', surveyor:'מודד', appraiser:'שמאי', other:'מקצוען' }[station.pro_role] || station.pro_role;
    const stats = {
      total:     attendees.length,
      confirmed: attendees.filter(a => a.status === 'confirmed').length,
      cancelled: attendees.filter(a => a.status === 'cancelled').length,
      arrived:   attendees.filter(a => a.status === 'arrived').length,
      no_show:   attendees.filter(a => a.status === 'no_show').length,
    };

    const token = req.params.token;
    const tableRows = attendees.map(a => {
      const time = a.start_time ? fmtDate(a.start_time).split(' ')[1] : '-';
      const statusColors = { confirmed:'#1b5e20', cancelled:'#3c1414', arrived:'#0d47a1', no_show:'#4a1942', pending:'#1a3a5c', rescheduled:'#3e2723' };
      const statusLabels = { confirmed:'אישר', cancelled:'ביטל', arrived:'הגיע', no_show:'לא הגיע', pending:'ממתין', rescheduled:'תיאם מחדש' };
      return `<tr data-id="${a.id}">
        <td style="text-align:center;font-size:13px;color:#90a4ae">${time}</td>
        <td><strong>${esc(a.name)}</strong>${a.unit_number?`<br><span style="font-size:11px;color:#78909c">דירה ${esc(a.unit_number)}${a.floor?', קומה '+esc(a.floor):''}</span>`:''}</td>
        <td style="font-size:12px;color:#b0bec5">${esc(a.building_name||'-')}</td>
        <td style="direction:ltr;font-size:12px">${esc(a.phone||'-')}</td>
        <td><span class="badge" style="background:${statusColors[a.status]||'#263238'}">${statusLabels[a.status]||a.status}</span></td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="act-btn" style="background:#0d47a1" onclick="setStatus(${a.id},'arrived',this)">✅ הגיע</button>
            <button class="act-btn" style="background:#3c1414" onclick="setStatus(${a.id},'no_show',this)">❌ לא הגיע</button>
            <button class="act-btn" style="background:#263238" onclick="openNotes(${a.id},'${esc(a.name)}')">📝</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>מינהלת | ${esc(station.pro_name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;direction:rtl}
.topbar{background:linear-gradient(135deg,#0d1117,#161b27);border-bottom:1px solid #1e3a5f;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#4fc3f7;font-size:18px;font-weight:700}
.event-header{padding:16px 20px;background:#0d1a2a;border-bottom:1px solid #1e3a5f}
.event-title{font-size:20px;font-weight:700;color:#e3f2fd;margin-bottom:4px}
.event-meta{font-size:13px;color:#78909c}
.pro-card{background:#0d1a2a;border:1px solid #1e3a5f;border-radius:8px;padding:14px 18px;margin:16px 20px;display:flex;align-items:center;gap:14px}
.pro-avatar{width:44px;height:44px;border-radius:50%;background:#1e3a5f;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.pro-name{font-size:16px;font-weight:600;color:#e3f2fd}
.pro-role{font-size:12px;color:#4fc3f7;margin-top:2px}
.stats-row{display:flex;gap:10px;padding:0 20px;margin:0 0 12px;flex-wrap:wrap}
.stat-card{background:#0d1a2a;border:1px solid #1e3a5f;border-radius:8px;padding:10px 16px;flex:1;min-width:80px;text-align:center}
.stat-num{font-size:22px;font-weight:700;color:#4fc3f7}
.stat-label{font-size:11px;color:#546e7a;margin-top:2px}
.table-wrap{padding:0 20px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#0d1a2a;padding:10px 12px;text-align:right;color:#78909c;font-weight:500;border-bottom:1px solid #1e3a5f;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid #141e2b;vertical-align:middle}
tr:hover td{background:#0d1a2a}
.badge{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600;color:#e3f2fd}
.act-btn{border:none;color:#e3f2fd;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:.2s}
.act-btn:hover{opacity:.8}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#0d1a2a;border:1px solid #1e3a5f;border-radius:12px;padding:24px;min-width:300px;max-width:400px;width:90%}
.modal-title{font-size:16px;font-weight:600;color:#e3f2fd;margin-bottom:14px}
textarea{width:100%;background:#060d1a;border:1px solid #1e3a5f;border-radius:8px;color:#e0e0e0;padding:10px;font-family:inherit;font-size:13px;resize:vertical;min-height:80px}
.modal-btns{display:flex;gap:8px;margin-top:12px}
.btn{flex:1;padding:10px;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600}
.btn-primary{background:#1565c0;color:#fff}.btn-cancel{background:#263238;color:#b0bec5}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">⚡ מינהלת</div>
  <div style="font-size:12px;color:#546e7a">גישת מקצוען</div>
</div>
<div class="event-header">
  <div class="event-title">${esc(station.title)}</div>
  <div class="event-meta">${fmtDate(station.event_date)} | ${esc(station.location||'')}</div>
</div>
<div class="pro-card">
  <div class="pro-avatar">👤</div>
  <div>
    <div class="pro-name">${esc(station.pro_name)}</div>
    <div class="pro-role">${roleLabel}</div>
    ${station.pro_phone ? `<div style="font-size:12px;color:#78909c;margin-top:2px;direction:ltr">${esc(station.pro_phone)}</div>` : ''}
  </div>
</div>
<div class="stats-row">
  <div class="stat-card"><div class="stat-num">${stats.total}</div><div class="stat-label">סה"כ</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#43a047">${stats.confirmed}</div><div class="stat-label">אישרו</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#1e88e5">${stats.arrived}</div><div class="stat-label">הגיעו</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#e53935">${stats.cancelled}</div><div class="stat-label">ביטלו</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#ffa726">${stats.no_show}</div><div class="stat-label">לא הגיעו</div></div>
</div>
<div class="table-wrap">
<table>
  <thead><tr><th>שעה</th><th>שם</th><th>בניין</th><th>טלפון</th><th>סטטוס</th><th>פעולות</th></tr></thead>
  <tbody id="tbody">${tableRows}</tbody>
</table>
</div>

<div class="modal-overlay" id="notesModal">
  <div class="modal">
    <div class="modal-title" id="notesTitle">הערות</div>
    <textarea id="notesText" placeholder="הכנס הערות..."></textarea>
    <div class="modal-btns">
      <button class="btn btn-primary" onclick="saveNotes()">שמור</button>
      <button class="btn btn-cancel" onclick="closeNotes()">ביטול</button>
    </div>
  </div>
</div>

<script>
const TOKEN = '${token}';
let notesId = null;

async function setStatus(id, status, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/events/pro/' + TOKEN + '/attendee/' + id, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({status})
    });
    if (r.ok) location.reload();
  } catch(e) { alert('שגיאה: ' + e.message); btn.disabled = false; }
}

function openNotes(id, name) {
  notesId = id;
  document.getElementById('notesTitle').textContent = 'הערות: ' + name;
  document.getElementById('notesText').value = '';
  document.getElementById('notesModal').classList.add('open');
}

function closeNotes() { document.getElementById('notesModal').classList.remove('open'); notesId = null; }

async function saveNotes() {
  if (!notesId) return;
  const notes = document.getElementById('notesText').value;
  try {
    await fetch('/events/pro/' + TOKEN + '/attendee/' + notesId, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({pro_notes: notes})
    });
    closeNotes();
  } catch(e) { alert('שגיאה'); }
}
</script>
</body></html>`);
  } catch(e) {
    logger.error('[Events] Pro page error:', e.message);
    res.status(500).send('<h2>שגיאה</h2><p>' + e.message + '</p>');
  }
});

router.post('/pro/:token/attendee/:id', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.id FROM event_stations s WHERE s.token=$1', [req.params.token]
    );
    if (!st.length) return err(res, 'Invalid token', 403);

    const fields = [];
    const vals = [];
    let n = 1;

    if (req.body.status) { fields.push(`status=$${n++}`); vals.push(req.body.status); }
    if (req.body.pro_notes !== undefined) { fields.push(`pro_notes=$${n++}`); vals.push(req.body.pro_notes); }
    if (!fields.length) return err(res, 'Nothing to update', 400);

    vals.push(req.params.id, st[0].id);
    await pool.query(
      `UPDATE event_attendees SET ${fields.join(',')} WHERE id=$${n++} AND station_id=$${n++}`,
      vals
    );
    ok(res, { message: 'updated' });
  } catch(e) { err(res, e.message); }
});

router.get('/pro/:token/pdf', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.*, e.title, e.event_date, e.location FROM event_stations s JOIN minhelet_events e ON e.id=s.event_id WHERE s.token=$1',
      [req.params.token]
    );
    if (!st.length) return res.status(404).send('Not found');
    const station = st[0];

    const { rows: attendees } = await pool.query(`
      SELECT a.*, sl.start_time FROM event_attendees a
      LEFT JOIN event_slots sl ON sl.id=a.slot_id
      WHERE a.station_id=$1 ORDER BY sl.start_time NULLS LAST, a.building_name, a.unit_number
    `, [station.id]);

    const rows = attendees.map(a => `<tr>
      <td>${a.start_time ? fmtDate(a.start_time).split(' ')[1] : '-'}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.unit_number||'-')}</td>
      <td>${esc(a.building_name||'-')}</td>
      <td>${esc(a.phone||'-')}</td>
      <td>${a.status}</td>
      <td></td>
    </tr>`).join('');

    res.type('html').send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
<title>רשימת נוכחות — ${esc(station.pro_name)}</title>
<style>body{font-family:Arial,sans-serif;font-size:12px;direction:rtl}
h2{font-size:16px}table{width:100%;border-collapse:collapse}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:right}
th{background:#eee;font-weight:bold}
@media print{button{display:none}}</style>
</head><body>
<button onclick="window.print()">🖨️ הדפס</button>
<h2>${esc(station.title)} — ${esc(station.pro_name)} (${esc(station.pro_role)})</h2>
<p>${fmtDate(station.event_date)} | ${esc(station.location||'')}</p>
<table><thead><tr><th>שעה</th><th>שם</th><th>דירה</th><th>בניין</th><th>טלפון</th><th>סטטוס</th><th>חתימה</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`);
  } catch(e) { res.status(500).send(e.message); }
});

// ── Attendee confirmation page ────────────────────────────────────────────────

router.get('/attend/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, s.pro_name, s.pro_role, s.pro_phone,
             e.title, e.event_date, e.location, e.compound_name,
             sl.start_time, sl.end_time
      FROM event_attendees a
      JOIN event_stations s ON s.id = a.station_id
      JOIN minhelet_events e ON e.id = s.event_id
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.token = $1
    `, [req.params.token]);

    if (!rows.length) return res.status(404).send(`<!DOCTYPE html><html lang="he" dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#e0e0e0"><h2>קישור לא תקין</h2></body></html>`);
    const a = rows[0];
    const token = req.params.token;
    const statusMsg = {
      confirmed: '✅ פגישתך אושרה',
      cancelled:  '❌ הפגישה בוטלה',
      rescheduled: '🔄 הפגישה תואמה מחדש',
      pending: '⏳ ממתין לאישור',
    }[a.status] || '⏳ ממתין לאישור';

    const timeDisplay = a.start_time ? fmtDate(a.start_time) : 'טרם שובץ';
    const roleLabel = { lawyer:'עורך דין', surveyor:'מודד', appraiser:'שמאי', other:'מקצוען' }[a.pro_role] || a.pro_role;

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>מינהלת | אישור פגישה</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;direction:rtl;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#0d1a2a;border:1px solid #1e3a5f;border-radius:16px;padding:28px;max-width:420px;width:100%;text-align:center}
.logo{color:#4fc3f7;font-size:22px;font-weight:700;margin-bottom:20px}
.status-badge{font-size:18px;font-weight:700;color:#e3f2fd;margin-bottom:16px}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1e3a5f;font-size:14px}
.info-label{color:#78909c}
.info-value{color:#e3f2fd;font-weight:500}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.btn{width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:.2s}
.btn:hover{opacity:.85}
.btn-confirm{background:#1565c0;color:#fff}
.btn-cancel{background:#3c1414;color:#e0e0e0}
.msg{margin-top:14px;font-size:13px;color:#78909c;min-height:20px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ מינהלת</div>
  <div class="status-badge" id="statusMsg">${statusMsg}</div>
  <div class="info-row"><span class="info-label">שם</span><span class="info-value">${esc(a.name)}</span></div>
  <div class="info-row"><span class="info-label">אירוע</span><span class="info-value">${esc(a.title)}</span></div>
  <div class="info-row"><span class="info-label">כתובת</span><span class="info-value">${esc(a.location||'-')}</span></div>
  <div class="info-row"><span class="info-label">מקצוען</span><span class="info-value">${esc(a.pro_name)} (${roleLabel})</span></div>
  <div class="info-row"><span class="info-label">שעה</span><span class="info-value">${timeDisplay}</span></div>
  ${a.unit_number ? `<div class="info-row"><span class="info-label">דירה</span><span class="info-value">${esc(a.unit_number)}</span></div>` : ''}
  <div class="actions">
    <button class="btn btn-confirm" onclick="doAction('confirmed')">✅ אני מאשר הגעה</button>
    <button class="btn btn-cancel" onclick="doAction('cancelled')">❌ לא יכול להגיע</button>
  </div>
  <div class="msg" id="msg"></div>
</div>
<script>
const TOKEN = '${token}';
async function doAction(action) {
  const msgEl = document.getElementById('msg');
  const statusEl = document.getElementById('statusMsg');
  msgEl.textContent = 'שולח...';
  try {
    const r = await fetch('/events/attend/' + TOKEN + '/confirm', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action})
    });
    const d = await r.json();
    if (d.success) {
      statusEl.textContent = action === 'confirmed' ? '✅ אישור נשמר — תודה!' : '❌ ביטול נשמר';
      msgEl.textContent = '';
    } else { msgEl.textContent = 'שגיאה: ' + (d.error||''); }
  } catch(e) { msgEl.textContent = 'שגיאת רשת'; }
}
</script>
</body></html>`);
  } catch(e) {
    logger.error('[Events] Attend page error:', e.message);
    res.status(500).send('<h2>שגיאה</h2><p>' + e.message + '</p>');
  }
});

router.post('/attend/:token/confirm', async (req, res) => {
  try {
    const { action } = req.body;
    const allowed = ['confirmed', 'cancelled', 'rescheduled'];
    if (!allowed.includes(action)) return err(res, 'Invalid action', 400);

    const { rows } = await pool.query(
      'SELECT id FROM event_attendees WHERE token=$1', [req.params.token]
    );
    if (!rows.length) return err(res, 'Not found', 404);

    await pool.query(
      'UPDATE event_attendees SET status=$1 WHERE token=$2',
      [action, req.params.token]
    );
    ok(res, { action });
  } catch(e) { err(res, e.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — Basic Auth protected
// ═══════════════════════════════════════════════════════════════════════════════

// ── Zoho lookup (no :id conflict) ─────────────────────────────────────────────

router.get('/zoho/compounds', adminAuth, async (req, res) => {
  try {
    if (!zohoSvc) return err(res, 'Zoho service not available');
    const compounds = await zohoSvc.getActiveCompounds();
    ok(res, { compounds });
  } catch(e) { err(res, e.message); }
});

router.get('/zoho/buildings/:cid', adminAuth, async (req, res) => {
  try {
    if (!zohoSvc) return err(res, 'Zoho service not available');
    const buildings = await zohoSvc.getBuildingsForCompound(req.params.cid);
    ok(res, { buildings });
  } catch(e) { err(res, e.message); }
});

// ── List events ───────────────────────────────────────────────────────────────

router.get('/', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_stations WHERE event_id=e.id) AS station_count,
        (SELECT COUNT(*) FROM event_attendees a JOIN event_stations s ON s.id=a.station_id WHERE s.event_id=e.id) AS attendee_count
      FROM minhelet_events e ORDER BY e.event_date DESC LIMIT 50
    `);
    ok(res, { events: rows });
  } catch(e) { err(res, e.message); }
});

// ── Create event ──────────────────────────────────────────────────────────────

router.post('/', adminAuth, async (req, res) => {
  try {
    const { title, event_type, event_date, location, zoho_compound_id, compound_name, notes } = req.body;
    if (!title || !event_date) return err(res, 'title and event_date required', 400);

    const { rows } = await pool.query(
      `INSERT INTO minhelet_events (title, event_type, event_date, location, zoho_compound_id, compound_name, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'upcoming') RETURNING *`,
      [title, event_type||'signing', event_date, location||'', zoho_compound_id||null, compound_name||'', notes||'']
    );
    ok(res, { event: rows[0] });
  } catch(e) { err(res, e.message); }
});

// ── Get event details ─────────────────────────────────────────────────────────

router.get('/:id', adminAuth, async (req, res) => {
  try {
    const { rows: ev } = await pool.query('SELECT * FROM minhelet_events WHERE id=$1', [req.params.id]);
    if (!ev.length) return err(res, 'Not found', 404);

    const { rows: stations } = await pool.query(
      'SELECT * FROM event_stations WHERE event_id=$1 ORDER BY station_number', [req.params.id]
    );

    const result = [];
    for (const s of stations) {
      const { rows: attendees } = await pool.query(
        `SELECT a.*, sl.start_time, sl.end_time FROM event_attendees a
         LEFT JOIN event_slots sl ON sl.id=a.slot_id
         WHERE a.station_id=$1 ORDER BY sl.start_time NULLS LAST, a.name`,
        [s.id]
      );
      const { rows: slots } = await pool.query(
        'SELECT * FROM event_slots WHERE station_id=$1 ORDER BY start_time', [s.id]
      );
      result.push({ ...s, attendees, slots });
    }
    ok(res, { event: ev[0], stations: result });
  } catch(e) { err(res, e.message); }
});

// ── Add station — auto-imports Zoho residents in background ──────────────────

router.post('/:id/stations', adminAuth, async (req, res) => {
  try {
    const { rows: ev } = await pool.query('SELECT * FROM minhelet_events WHERE id=$1', [req.params.id]);
    if (!ev.length) return err(res, 'Event not found', 404);

    const { pro_name, pro_role, pro_phone, pro_email } = req.body;
    if (!pro_name || !pro_role) return err(res, 'pro_name and pro_role required', 400);

    // Count existing stations for this event
    const { rows: cnt } = await pool.query(
      'SELECT COUNT(*) FROM event_stations WHERE event_id=$1', [req.params.id]
    );
    const stationNumber = parseInt(cnt[0].count) + 1;

    // Generate token
    const crypto = require('crypto');
    const token = crypto.createHash('md5').update(`${req.params.id}-${pro_name}-${Date.now()}`).digest('hex');

    const { rows } = await pool.query(
      `INSERT INTO event_stations (event_id, pro_name, pro_role, pro_phone, pro_email, station_number, token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, pro_name, pro_role, pro_phone||'', pro_email||'', stationNumber, token]
    );
    const station = rows[0];
    const proUrl = `${BASE_URL}/events/pro/${token}`;

    // Auto-import Zoho residents in background (fire-and-forget)
    setImmediate(() => {
      autoImportResidents(station.id, ev[0].zoho_compound_id, ev[0].compound_name)
        .catch(e => logger.warn('[Events] Background import error:', e.message));
    });

    ok(res, {
      station,
      pro_url: proUrl,
      message: `עמדה נוספה. דיירים מיובאים ברקע מ-Zoho.`,
    });
  } catch(e) { err(res, e.message); }
});

// ── Generate slots ────────────────────────────────────────────────────────────

router.post('/:id/stations/:sid/slots', adminAuth, async (req, res) => {
  try {
    const { start_time, end_time, slot_duration_minutes = 15 } = req.body;
    if (!start_time || !end_time) return err(res, 'start_time and end_time required', 400);

    const { rows: st } = await pool.query(
      'SELECT * FROM event_stations WHERE id=$1 AND event_id=$2',
      [req.params.sid, req.params.id]
    );
    if (!st.length) return err(res, 'Station not found', 404);

    // Remove existing free slots
    await pool.query(
      "DELETE FROM event_slots WHERE station_id=$1 AND status='free'", [req.params.sid]
    );

    const start = new Date(start_time);
    const end   = new Date(end_time);
    const dur   = parseInt(slot_duration_minutes) * 60000;
    const created = [];

    let cur = start;
    while (cur < end) {
      const slotEnd = new Date(cur.getTime() + dur);
      if (slotEnd > end) break;
      const { rows } = await pool.query(
        `INSERT INTO event_slots (station_id, start_time, end_time, status)
         VALUES ($1,$2,$3,'free') RETURNING *`,
        [req.params.sid, cur.toISOString(), slotEnd.toISOString()]
      );
      created.push(rows[0]);
      cur = slotEnd;
    }

    ok(res, { slots_created: created.length, slots: created });
  } catch(e) { err(res, e.message); }
});

// ── Auto-assign attendees to slots ────────────────────────────────────────────

router.post('/:id/stations/:sid/assign', adminAuth, async (req, res) => {
  try {
    const { rows: freeSlots } = await pool.query(
      "SELECT * FROM event_slots WHERE station_id=$1 AND status='free' ORDER BY start_time",
      [req.params.sid]
    );
    const { rows: unassigned } = await pool.query(
      "SELECT * FROM event_attendees WHERE station_id=$1 AND slot_id IS NULL AND status NOT IN ('cancelled') ORDER BY building_name, unit_number",
      [req.params.sid]
    );

    let assigned = 0;
    for (let i = 0; i < Math.min(freeSlots.length, unassigned.length); i++) {
      const slot = freeSlots[i];
      const attendee = unassigned[i];

      // Generate attendee token
      const crypto = require('crypto');
      const aToken = crypto.createHash('md5').update(`${attendee.id}-${slot.id}-${Date.now()}`).digest('hex');

      await pool.query(
        `UPDATE event_attendees SET slot_id=$1, token=$2, status='assigned' WHERE id=$3`,
        [slot.id, aToken, attendee.id]
      );
      await pool.query(
        "UPDATE event_slots SET status='booked' WHERE id=$1", [slot.id]
      );
      assigned++;
    }

    ok(res, {
      assigned,
      total_attendees: unassigned.length,
      total_slots: freeSlots.length,
      remaining_unassigned: Math.max(0, unassigned.length - assigned),
    });
  } catch(e) { err(res, e.message); }
});

// ── Full report ───────────────────────────────────────────────────────────────

router.get('/:id/report', adminAuth, async (req, res) => {
  try {
    const { rows: ev } = await pool.query('SELECT * FROM minhelet_events WHERE id=$1', [req.params.id]);
    if (!ev.length) return err(res, 'Not found', 404);

    const { rows: stations } = await pool.query(
      'SELECT * FROM event_stations WHERE event_id=$1 ORDER BY station_number', [req.params.id]
    );

    const stationsReport = [];
    for (const s of stations) {
      const { rows: attendees } = await pool.query(
        `SELECT a.*, sl.start_time FROM event_attendees a
         LEFT JOIN event_slots sl ON sl.id=a.slot_id
         WHERE a.station_id=$1 ORDER BY sl.start_time NULLS LAST`,
        [s.id]
      );
      const summary = {
        total:     attendees.length,
        confirmed: attendees.filter(a => a.status === 'confirmed').length,
        cancelled: attendees.filter(a => a.status === 'cancelled').length,
        arrived:   attendees.filter(a => a.status === 'arrived').length,
        no_show:   attendees.filter(a => a.status === 'no_show').length,
        pending:   attendees.filter(a => ['pending','assigned'].includes(a.status)).length,
      };
      stationsReport.push({ ...s, summary, attendees, pro_url: `${BASE_URL}/events/pro/${s.token}` });
    }

    ok(res, { event: ev[0], stations: stationsReport });
  } catch(e) { err(res, e.message); }
});

module.exports = router;
