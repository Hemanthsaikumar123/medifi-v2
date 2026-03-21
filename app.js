// app.js
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
require('./auth/passport-config')(passport);
const app = express();
const PORT = process.env.PORT || 3000;
const symptomData = JSON.parse(fs.readFileSync('./symptomData.json', 'utf8'));
const responseMap = JSON.parse(fs.readFileSync('./responseMap.json', 'utf8'));

const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

// Limit: 20 requests per minute per IP on API routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many requests, please slow down.'
});



// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(session({
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// Ensure template vars exist for all index renders
app.use((req, res, next) => {
  res.locals.manualError = null;
  next();
});

const authRoutes = require('./routes/auth');
app.use('/', authRoutes);

app.use('/manual', apiLimiter);
app.use('/chat', apiLimiter);
app.use('/flow-step', apiLimiter);
app.use('/flow-diagnose', apiLimiter);


async function askAI(userMessage) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are Medify, a helpful medical information assistant.
          When given symptoms, respond ONLY with valid JSON — no explanation, no markdown.
          Format: {"condition":"...","advice":"...","urgency":"low|medium|high"}
          urgency=high means go to hospital immediately.
          Always end advice with: Consult a doctor for proper diagnosis.`
        },
        { role: 'user', content: userMessage }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const raw = response.data.choices[0].message.content;
  // Strip markdown code fences if model adds them
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}


// Routes
app.get('/', (req, res) => {
  const section = req.query.section || 'home';
  res.render('index', {   section,
    flowStep: 1,           
    reply: null,
    manualResult: null,
    category: null,
    options: [],
    symptom: null,
    condition: null,
    user: req.user,
    advice: null});
});

// Smart multi-strategy OpenFDA search
async function fetchFromFDA(query) {
  const q = encodeURIComponent(query);
  const strategies = [
    `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${q}"&limit=3`,
    `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"&limit=3`,
    `https://api.fda.gov/drug/label.json?search=openfda.brand_name:${q}*+openfda.generic_name:${q}*&limit=3`,
    `https://api.fda.gov/drug/label.json?search=${q}&limit=5`,
  ];
  for (const url of strategies) {
    try {
      const res = await axios.get(url, { timeout: 6000 });
      const results = res.data.results || [];
      const good = results.filter(r =>
        r.openfda?.brand_name?.length || r.openfda?.generic_name?.length
      );
      if (good.length > 0) return good;
    } catch (e) { continue; }
  }
  return [];
}

function cleanText(text, maxLen = 400) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.substring(0, maxLen);
  const lastDot = cut.lastIndexOf('.');
  return lastDot > 200 ? cut.substring(0, lastDot + 1) + ' ...' : cut + ' ...';
}

async function summarizeWithAI(brand, rawUsage, rawWarning) {
  try {
    const prompt = `Summarize this drug info for a patient in plain English. Be concise.
Drug: ${brand}
Usage: ${rawUsage?.substring(0, 600) || 'N/A'}
Warnings: ${rawWarning?.substring(0, 400) || 'N/A'}
Respond ONLY in JSON (no markdown):
{"summary":"2-3 sentence plain English summary","keyWarnings":"1-2 most important warnings in plain English"}`;
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'You are a pharmacist. Respond only in valid JSON, no markdown.' },
          { role: 'user', content: prompt }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 8000 }
    );
    const raw = response.data.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) { return null; }
}

app.post('/manual', async (req, res) => {
  const query = req.body.query?.trim();
  if (!query) return res.redirect('/?section=manual');

  let drugData = null;
  let errorMsg = null;

  try {
    const results = await fetchFromFDA(query);

    if (results.length === 0) {
      // Nothing in OpenFDA — fall back to AI
      try {
        const aiResponse = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: 'llama-3.1-8b-instant',
            max_tokens: 350,
            messages: [
              { role: 'system', content: 'You are a pharmacist. Respond only in valid JSON, no markdown.' },
              { role: 'user', content: `Give information about "${query}" as a drug or medical condition. Respond ONLY in JSON: {"brand":"...","generic":"...","purpose":"...","usage":"2-3 sentences in plain English","dosage":"common dosage","warning":"most important warning","source":"AI"} If completely unknown set brand to null.` }
            ]
          },
          { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 8000 }
        );
        const raw = aiResponse.data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const aiData = JSON.parse(raw);
        if (aiData.brand) {
          drugData = { ...aiData, fromAI: true, otherMatches: [] };
        } else {
          errorMsg = `No results found for "${query}". Try a brand name like "Paracetamol" or "Metformin".`;
        }
      } catch (aiErr) {
        errorMsg = `No results found for "${query}". Try a specific brand or generic drug name.`;
      }
    } else {
      const scoreResult = r => (r.purpose ? 2 : 0) + (r.indications_and_usage ? 2 : 0) +
        (r.dosage_and_administration ? 1 : 0) + (r.warnings ? 1 : 0);
      const best = results.reduce((a, b) => scoreResult(a) >= scoreResult(b) ? a : b);

      const rawUsage   = best.indications_and_usage?.[0] || null;
      const rawWarning = best.warnings?.[0] || best.warnings_and_cautions?.[0] || null;
      const rawDosage  = best.dosage_and_administration?.[0] || null;
      const brand      = best.openfda?.brand_name?.[0] || best.openfda?.generic_name?.[0] || query;

      // Use AI to clean up long/missing text
      const needsSummary = !best.purpose || (rawUsage && rawUsage.length > 500);
      const aiSummary = needsSummary ? await summarizeWithAI(brand, rawUsage, rawWarning) : null;

      drugData = {
        brand,
        generic:         best.openfda?.generic_name?.[0] || best.openfda?.brand_name?.[0] || 'N/A',
        purpose:         best.purpose?.[0] || aiSummary?.summary || cleanText(rawUsage, 200) || 'N/A',
        usage:           aiSummary?.summary || cleanText(rawUsage) || 'N/A',
        dosage:          cleanText(rawDosage, 300) || 'N/A',
        warning:         aiSummary?.keyWarnings || cleanText(rawWarning, 300) || 'N/A',
        activeIngredient: best.active_ingredient?.[0]?.substring(0, 200) || null,
        fromAI: false,
        otherMatches: results
          .filter(r => r !== best)
          .slice(0, 2)
          .map(r => {
            const rRaw  = r.indications_and_usage?.[0] || null;
            const rWarn = r.warnings?.[0] || r.warnings_and_cautions?.[0] || null;
            return {
              brand:           r.openfda?.brand_name?.[0]  || r.openfda?.generic_name?.[0] || 'Unknown',
              generic:         r.openfda?.generic_name?.[0] || 'N/A',
              purpose:         r.purpose?.[0]               || cleanText(rRaw, 120)         || 'N/A',
              usage:           cleanText(rRaw)               || 'N/A',
              dosage:          cleanText(r.dosage_and_administration?.[0], 300) || 'N/A',
              warning:         cleanText(rWarn, 300)         || 'N/A',
              activeIngredient: r.active_ingredient?.[0]?.substring(0, 200) || null,
            };
          })
      };

      if (req.user) {
        await pool.query(
          'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1,$2,$3,$4,$5)',
          [req.user.id, 'manual', query, drugData.brand, drugData.purpose.substring(0, 200)]
        );
      }
    }
  } catch (err) {
    console.error('Manual search error:', err.message);
    errorMsg = 'Something went wrong. Please try again.';
  }

  res.render('index', {
    section: 'manual', flowStep: 1, reply: null,
    manualResult: drugData, manualError: errorMsg,
    category: null, options: [], symptom: null,
    condition: null, user: req.user, advice: null
  });
});



app.post('/chat', async (req, res) => {
  const userMsg = req.body.message?.trim();
  if (!userMsg) return res.redirect("/?section=bot");

  let match;
  try {
    match = await askAI(userMsg);
  } catch (err) {
    console.error("AI error:", err.message);
    match = { condition: 'Unable to process', advice: 'Please consult a doctor.', urgency: 'low' };
  }

  if (req.user) {
    await pool.query(
      'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'bot', userMsg, match.condition, match.advice]
    );
  }

  // Still fetch OpenFDA for related drug info
  const fdaQuery = encodeURIComponent(match.condition.split(" ")[0]);
  let drugInfo = null;
  try {
    const fda = await axios.get(
      `https://api.fda.gov/drug/label.json?search=indications_and_usage:${fdaQuery}&limit=1`
    );
    drugInfo = fda.data.results?.[0]?.indications_and_usage?.[0] || null;
  } catch (e) {}

  res.render('index', {
    section: 'bot', flowStep: 1,
    reply: { ...match, drugInfo, query: userMsg },
    manualResult: null, manualError: null,
    category: null, options: [], symptom: null,
    condition: null, user: req.user, advice: null
  });
});


app.post('/flow-step', (req, res) => {
  const category = req.body.category;

const optionMap = {
  head: ['Headache', 'Dizziness', 'Blurred Vision'],
  chest: ['Chest Pain', 'Shortness of Breath'],
  stomach: ['Nausea', 'Abdominal Pain', 'Diarrhea'],
  joints: ['Joint Pain', 'Swelling', 'Stiffness'],
  skin: ['Rash', 'Itching', 'Red Spots'],
  eye: ['Redness', 'Itching', 'Dry Eyes'],
  throat: ['Sore Throat', 'Difficulty Swallowing', 'Voice Loss'],
  back: ['Lower Back Pain', 'Upper Back Pain', 'Stiff Back'],
  general: ['Fatigue', 'Fever', 'Loss of Appetite']
};


  const options = optionMap[category] || [];

  res.render('index', {
    section: 'flow',
    flowStep: 2,
    category,
    options,
    reply: null,
    manualResult: null,
    user: req.user
  });
});

app.post('/flow-diagnose', (req, res) => {
  const { category, symptom } = req.body;

  const result = responseMap[symptom] || {
    condition: "Unknown",
    advice: "Please consult a doctor."
  };
  if (req.user) {
    pool.query(
      'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'flow', symptom, result.condition, result.advice]
    );
  }
  

  res.render('index', {
    section: 'flow',
    flowStep: 3,
    category,
    symptom,
    condition: result.condition,
    advice: result.advice,
    reply: null,
    manualResult: null,
    user: req.user
  });
});


app.get('/history', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const historyData = await pool.query(
    'SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.render('history', { user: req.user, history: historyData.rows });
});


app.post('/history/delete', async (req, res) => {
  const entryId = req.body.entryId;
  if (!req.user) return res.redirect('/login');

  try {
    await pool.query(
      'DELETE FROM history WHERE id = $1 AND user_id = $2',
      [entryId, req.user.id]
    );
    res.redirect('/history');
  } catch (err) {
    console.error('Failed to delete history entry:', err.message);
    res.status(500).send('Something went wrong.');
  }
});








app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});