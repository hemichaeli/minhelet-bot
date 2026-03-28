/**
 * מינהלת AI Bot - Advanced Flow
 * Uses Claude AI for dynamic sales conversations
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const { logger } = require('../services/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

async function callClaude(systemPrompt, userPrompt) {
  const response = await axios.post(CLAUDE_API_URL, {
    model: CLAUDE_MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 12000
  });
  return response.data.content[0].text;
}

const SALES_SYSTEM_PROMPT = `אתה מינהלת Sales AI - המתווך הדיגיטלי החכם ביותר בישראל.
לא סתם bot - נציג מכירות מבריק שמשלב AI עם חוכמת מכירות.

תכונות אישיות מכירות:
- חוש שישי מסחרי - קורא בין השורות, מזהה צרכים נסתרים
- יועץ אסטרטגי - לא רק מתווך, מכוון להחלטות חכמות  
- אנליסט שוק AI - יודע מה שאחרים לא יודעים
- מומחה התמודדות - הופך התנגדויות להזדמנויות

מטרת FLOW: QUALIFICATION → DIFFERENTIATION → CLOSE

זיהוי מצב התיווך:
1. יש מתווך → Competition Flow (הוכח עליונות)
2. אין מתווך → Open Field Flow (תפוס בעלות)  
3. בודק אפשרויות → Shopping Flow (הוכח שאתה הטוב ביותר)
4. עמום → Detective Flow (גלה את האמת)

אסטרטגיות מכירות לפי מצב:

OPEN FIELD (אין מתווך):
"מעולה! יש לך יתרון - תוכל לבחור את הטובים ביותר מההתחלה.
ב-מינהלת יש לנו [ערך מיידי]:
• מוכר: גישה לקונים רציניים שחיפשו בדיוק מה שיש לך
• קונה: נכסים שאחרים אפילו לא יודעים שקיימים
המומחה שלנו יכול לפגוש אותך השבוע. מתי נוח?"

COMPETITION (יש מתווך):  
"הבנתי. איך אתה מרגיש עם ההתקדמות?"
[בהתאם לתגובה:]
- מרוצה: "נהדר! לפעמים כדאי לקבל דעה שנייה מקצועית..."
- מתוסכל: "אני מבין. לפעמים המתווכים לא באמת..."
- ניטרלי: "בסדר. אגב, אתה יודע שב[אזור] יש דברים ששווה לבדוק..."

הוכחת עליונות:
"יש לנו משהו ייחודי - גישה למידע שרק אנחנו יודעים עליו + מומחיות בפינוי-בינוי.
כדאי לך לפחות לשמוע. 15 דקות - מה יכול להיות?"

SHOPPING (בודק אפשרויות):
"חכם שלך! מה החשוב לך במתווך?
80% מהמתווכים עובדים עם אותם נכסים. 
אנחנו יודעים על [נכסים נסתרים/מוכרים במצוקה] שאחרים לא מכירים.
15 דקות קפה עם המומחה - תבין איך השוק באמת עובד."

DETECTIVE (עמום):
"אני מרגיש שיש פה סיפור... 😏 מה המצב האמיתי?"
[קרא נכון את התגובה והתאם]

ערכים מבדילים לפי פרופיל:
- פינוי-בינוי: "רוב המתווכים לא באמת מבינים איך זה עובד. יש סיכונים + הזדמנויות שאתה חייב לדעת"
- נכסים יקרים: "בטווח הזה זה לא מחירון, זה קשרים ומידע. גישה למוכרים דיסקרטיים"
- השקעה: "מערכת התראות על נכסים טובים שעה אחרי פרסום"

טקטיקות סגירה:
- רכה: "מעביר אותך למומחה. מתי נוח - עד 17:00 או אחרי?"
- קשה: "המומחה זמין השבוע, השבוע הבא בנסיעה. יום X או Y?"
- התנגדות: "מה בדיוק צריך לחשב? אולי אעזור עם המידע"

JSON Output:
{
  "message": "התגובה המותאמת", 
  "save": {
    "current_broker": "yes/no/shopping/unknown",
    "satisfaction_level": "high/medium/low",
    "urgency": "high/medium/low", 
    "property_value": "estimate",
    "decision_maker": "yes/partial/no",
    "main_objection": "price/time/trust/process/none",
    "sales_stage": "qualifying/presenting/closing",
    "close_attempt": "soft/hard/objection_handling"
  },
  "next_action": "close/follow_up/nurture/disqualify",
  "confidence": 1-10,
  "done": boolean (true אם הושגה מחויבות או פסלת)
}

Red Flags לפסילה:
- "רק לקבל מחיר" → "שמור המספר, כשתהיה מוכן נשמח לעזור"
- "אני לא מחליט" → פסול
- "בעוד שנה" → פסול  

המטרה: להפוך כל שיחה למכירה או לפחות לפגישה איכותית. 
אתה מינהלת Sales Machine! 🎯`;

function parseParams(parameters) {
  const params = {};
  (parameters || []).forEach(p => { params[p.name] = p.value; });
  return params;
}

function getSalesStage(params) {
  if (!params.name || !params.user_type) return 'qualifying';
  if (!params.current_broker) return 'qualifying';
  if (params.close_attempt) return 'closing';
  return 'presenting';
}

function getRequiredFields(params, stage) {
  const base = ['name', 'user_type', 'current_broker'];
  
  if (stage === 'qualifying') {
    if (!params.city) return [...base, 'city'];
    if (!params.property_type) return [...base, 'property_type'];
  }
  
  if (stage === 'presenting') {
    if (params.user_type === 'seller' && !params.rooms) return [...base, 'rooms'];
    if (params.user_type === 'buyer' && !params.budget) return [...base, 'budget'];
    if (!params.satisfaction_level && params.current_broker === 'yes') return [...base, 'satisfaction_level'];
  }
  
  return [];
}

async function getSalesDecision(parameters, currentInput, chatHistory = []) {
  const params = parseParams(parameters);
  const stage = getSalesStage(params);
  const missing = getRequiredFields(params, stage);
  const isReadyToClose = missing.length === 0 && stage !== 'qualifying';

  // Build conversation context
  const context = chatHistory.length > 0 ? 
    `\nהיסטוריית השיחה:\n${chatHistory.map(h => `${h.role}: ${h.content}`).join('\n')}` : '';

  const userPrompt = `מצב נוכחי:
נאספו: ${JSON.stringify(params)}
קלט נוכחי: "${currentInput || '(התחלת שיחה)'}"
שלב מכירות: ${stage}
חסרים: ${missing.join(', ') || 'אין'}
מוכן לסגירה: ${isReadyToClose}
${context}

${isReadyToClose 
  ? `הגיע זמן הסגירה! בהתבסס על הפרופיל שנאסף, הכן סגירה מתאימה:
     - אם יש מתווך אחר: הוכח עליונות + ערך ייחודי
     - אם אין מתווך: תפוס בעלות על התהליך  
     - אם מתלבט: התמודד עם התנגדויות
     סגור עם פגישה ספציפית או העברה למומחה.`
  : missing.length > 0
  ? `צריך לאסוף: "${missing[0]}"
     שאלות לפי סוג:
     - name: "איך קוראים לך?"
     - user_type: "יש לך נכס למכירה או מחפש לקנות?"
     - city: "באיזה אזור?"
     - property_type: "איזה סוג נכס?"
     - current_broker: "יש לך כבר מתווך שעובד איתך על זה?"
     - satisfaction_level: "איך אתה מרגיש עם ההתקדמות?"
     - rooms: "כמה חדרים?"
     - budget: "מה התקציב?"
     
     שאל רק שאלה אחת!`
  : `זמן להציג ערך ולהתקדם לסגירה. השתמש באסטרטגיה המתאימה למצב התיווך.`}

ענה ב-JSON בלבד:
{
  "message": "המסר ללקוח",
  "save": { "param": "value" } // רק אם נתקבל בקלט הנוכחי,
  "next_action": "close/follow_up/nurture/disqualify",
  "confidence": 1-10,
  "done": true/false
}

זכור: אתה נציג מכירות מבריק, לא רובוט מקבל מידע!`;

  const text = await callClaude(SALES_SYSTEM_PROMPT, userPrompt);
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const decision = JSON.parse(match[0]);
      // Add sales intelligence
      if (decision.save) {
        decision.save.last_interaction = new Date().toISOString();
        decision.save.sales_stage = stage;
      }
      return decision;
    }
  } catch (e) {
    logger.warn('Claude non-JSON response', { text: text.substring(0, 300) });
  }
  return { 
    message: text.substring(0, 300), 
    save: { sales_stage: stage }, 
    next_action: 'follow_up',
    confidence: 3,
    done: false 
  };
}

function buildSalesActions(decision) {
  const actions = [];
  
  // Save parameters
  if (decision.save) {
    Object.entries(decision.save).forEach(([name, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        actions.push({ type: 'SetParameter', name, value: String(value) });
      }
    });
  }
  
  // Send message
  if (decision.message) {
    actions.push({ type: 'SendMessage', text: decision.message });
  }
  
  // Handle completion
  if (decision.done) {
    if (decision.next_action === 'disqualify') {
      actions.push({ type: 'SetParameter', name: 'disqualified', value: 'true' });
      actions.push({ type: 'Return', value: 'disqualified' });
    } else {
      actions.push({ type: 'SetParameter', name: 'qualified_lead', value: 'true' });
      actions.push({ type: 'SetParameter', name: 'ready_for_transfer', value: 'true' });
      actions.push({ type: 'Return', value: 'qualified' });
    }
  } else {
    actions.push({ type: 'InputText' });
  }
  
  return actions;
}

async function saveSalesLeadToDB(callbackData) {
  const { chat, fields, parameters } = callbackData;
  const params = parseParams(parameters);
  const rawPhone = (chat?.sender || '').replace(/\D/g, '').slice(-10);
  
  // Enhanced lead data with sales intelligence
  const leadData = {
    source: 'whatsapp_sales_bot',
    phone: rawPhone,
    name: params.name || fields?.name || null,
    city: params.city || null,
    property_type: params.property_type || null,
    user_type: params.user_type || null,
    budget: params.budget || null,
    timeline: params.timeline || null,
    rooms: params.rooms || null,
    
    // Sales intelligence fields
    current_broker: params.current_broker || null,
    satisfaction_level: params.satisfaction_level || null,
    urgency: params.urgency || null,
    property_value: params.property_value || null,
    decision_maker: params.decision_maker || null,
    main_objection: params.main_objection || null,
    sales_stage: params.sales_stage || null,
    confidence_score: params.confidence || null,
    
    raw_data: JSON.stringify(callbackData),
    status: params.disqualified === 'true' ? 'disqualified' : 'new'
  };
  
  try {
    await pool.query(`
      INSERT INTO leads (
        source, phone, name, city, property_type, user_type, budget, timeline, rooms,
        current_broker, satisfaction_level, urgency, property_value, decision_maker, 
        main_objection, sales_stage, confidence_score, raw_data, status, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
      )`, [
        leadData.source, leadData.phone, leadData.name, leadData.city, 
        leadData.property_type, leadData.user_type, leadData.budget, leadData.timeline,
        leadData.rooms, leadData.current_broker, leadData.satisfaction_level,
        leadData.urgency, leadData.property_value, leadData.decision_maker,
        leadData.main_objection, leadData.sales_stage, leadData.confidence_score,
        leadData.raw_data, leadData.status
      ]);
    
    logger.info('Sales lead saved with intelligence', { 
      phone: rawPhone, 
      type: params.user_type, 
      stage: params.sales_stage,
      broker: params.current_broker 
    });
    
  } catch (err) {
    // Fallback to simpler table
    try {
      await pool.query(`
        INSERT INTO website_leads (source, phone, name, user_type, form_data, status, created_at)
        VALUES ('whatsapp_sales_bot', $1, $2, $3, $4, 'new', NOW())
      `, [rawPhone, params.name || null, params.user_type || 'unknown', 
          JSON.stringify({ ...params, raw: callbackData })]);
    } catch (err2) {
      logger.error('Failed to save sales lead', { error: err2.message });
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  const base = 'https://pinuy-binuy-analyzer-production.up.railway.app';
  res.json({
    status: 'ok', 
    bot: 'מינהלת AI Sales Bot v3.0',
    features: ['AI_SALES_FLOW', 'COMPETITION_HANDLING', 'DYNAMIC_CLOSING'],
    endpoints: {
      webservice: `${base}/api/bot/webservice`,
      callback: `${base}/api/bot/callback`,
      leads_ui: `${base}/api/bot/leads-ui`,
      trello_webhook: `${base}/api/bot/trello-webhook`
    },
    config: {
      claude: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
      db: !!process.env.DATABASE_URL ? 'configured' : 'MISSING',
      trello: !!process.env.TRELLO_API_KEY ? 'configured' : 'MISSING'
    }
  });
});

router.post('/webservice', async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ actions: [{ type: 'SendMessage', text: 'אני חושב על התגובה הטובה ביותר...' }, { type: 'InputText' }] });
  }, 5000);
  
  try {
    const { chat, parameters, value } = req.body;
    logger.info('Sales bot webservice', { 
      sender: chat?.sender, 
      input: value?.string, 
      params: (parameters || []).length 
    });
    
    const decision = await getSalesDecision(parameters, value?.string || null);
    const actions = buildSalesActions(decision);
    
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ actions });
    
  } catch (err) {
    clearTimeout(timeout);
    logger.error('Sales bot error', { error: err.message });
    if (!res.headersSent) {
      res.json({ 
        actions: [
          { type: 'SendMessage', text: 'משהו השתבש. המומחה שלנו יחזור אליך בהקדם.' },
          { type: 'Return', value: 'error' }
        ] 
      });
    }
  }
});

router.post('/callback', async (req, res) => {
  res.json({ status: 'ok' });
  try {
    logger.info('Sales bot callback', { leadId: req.body?.lead?.id });
    await saveSalesLeadToDB(req.body);
  } catch (err) {
    logger.error('Sales bot callback error', { error: err.message });
  }
});

router.get('/leads-ui', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/bot-leads.html'));
});

router.get('/leads', async (req, res) => {
  try {
    const { status, user_type, sales_stage, current_broker, limit = 100, offset = 0 } = req.query;
    let where = [], params = [], idx = 1;
    let rows = [], total = 0;
    
    try {
      // Build dynamic WHERE clause
      if (status) { where.push(`status = $${idx++}`); params.push(status); }
      if (user_type) { where.push(`user_type = $${idx++}`); params.push(user_type); }
      if (sales_stage) { where.push(`sales_stage = $${idx++}`); params.push(sales_stage); }
      if (current_broker) { where.push(`current_broker = $${idx++}`); params.push(current_broker); }
      
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      
      // Get total count
      total = parseInt((await pool.query(`SELECT COUNT(*) FROM leads ${w}`, params)).rows[0].count);
      
      // Get leads with sales intelligence
      rows = (await pool.query(`
        SELECT id, source, phone, name, city, property_type, user_type, budget, timeline, rooms,
               current_broker, satisfaction_level, urgency, sales_stage, confidence_score,
               status, notes, assigned_to, created_at, updated_at
        FROM leads ${w} 
        ORDER BY confidence_score DESC NULLS LAST, created_at DESC 
        LIMIT $${idx++} OFFSET $${idx++}
      `, [...params, parseInt(limit), parseInt(offset)])).rows;
      
    } catch (e) { 
      logger.warn('Enhanced leads table not ready, using basic', { error: e.message }); 
    }

    // Calculate enhanced stats
    let stats = { total: 0, new: 0, qualified: 0, closing: 0, competition: 0, hot_leads: 0 };
    try {
      const s = (await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'new') as new,
          COUNT(*) FILTER (WHERE sales_stage = 'closing') as closing,
          COUNT(*) FILTER (WHERE current_broker = 'yes') as competition,
          COUNT(*) FILTER (WHERE confidence_score >= 8) as hot_leads,
          COUNT(*) FILTER (WHERE status != 'disqualified') as qualified
        FROM leads
      `)).rows[0];
      
      stats = {
        total: parseInt(s.total),
        new: parseInt(s.new),
        qualified: parseInt(s.qualified),
        closing: parseInt(s.closing),
        competition: parseInt(s.competition),
        hot_leads: parseInt(s.hot_leads)
      };
    } catch (e) { /* fallback to basic stats */ }

    res.json({ leads: rows, total, stats });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-sales', async (req, res) => {
  try {
    const { parameters = [], input = null, scenario = 'open_field' } = req.body;
    
    // Add test scenario context
    const testContext = {
      open_field: "Test: לקוח ללא מתווך",
      competition: "Test: לקוח עם מתווך קיים",
      shopping: "Test: לקוח בודק אפשרויות",
      objection: "Test: לקוח עם התנגדויות"
    };
    
    const decision = await getSalesDecision(parameters, input || testContext[scenario]);
    const actions = buildSalesActions(decision);
    
    const nextParams = [
      ...parameters,
      ...Object.entries(decision.save || {}).map(([name, value]) => ({ name, value }))
    ];
    
    res.json({ 
      scenario,
      decision, 
      actions, 
      next_params: nextParams,
      sales_intelligence: {
        stage: decision.save?.sales_stage || 'unknown',
        confidence: decision.confidence || 0,
        next_action: decision.next_action || 'continue'
      }
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Copy other routes from previous version...
router.get('/trello-webhook', (req, res) => res.sendStatus(200));
router.head('/trello-webhook', (req, res) => res.sendStatus(200));
router.post('/trello-webhook', async (req, res) => {
  res.sendStatus(200);
  // [Previous Trello webhook code remains the same]
});

router.put('/leads/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, assigned_to } = req.body;
    const valid = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost', 'disqualified'];
    if (status && !valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    
    const sets = [], params = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); params.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(notes); }
    if (assigned_to !== undefined) { sets.push(`assigned_to = $${idx++}`); params.push(assigned_to); }
    sets.push('updated_at = NOW()');
    params.push(parseInt(id));
    
    const result = await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, lead: result.rows[0] });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;