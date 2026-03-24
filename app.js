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
         content: `You are Medify, a helpful medical assistant.

User may ask:
- symptoms
- diseases
- medicine questions
- general health doubts

Respond ONLY in valid JSON (no markdown).

Format:
{
  "title": "short heading",
  "summary": "clear, simple explanation for the user"
}

Instructions:
- Write like a doctor explaining to a patient
- If medicines are needed, include them naturally in the summary
- If advice is needed, include it at the end
- Do NOT separate fields for medicines or advice
- Keep it short and simple
- Always end with: Consult a doctor for proper diagnosis.`
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
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}


// Routes
app.get('/', (req, res) => {
  const section = req.query.section || 'home';
  res.render('index', {
    section,
    flowStep: 1,
    reply: null,
    manualResult: null,
    category: null,
    options: [],
    symptom: null,
    condition: null,
    user: req.user,
    advice: null
  });
});

// Smart multi-strategy OpenFDA search
async function fetchFromFDA(query) {
  const q = encodeURIComponent(query);

  try {
    const res = await axios.get(
      `https://api.fda.gov/drug/label.json?search=${q}&limit=5`,
      { timeout: 6000 }
    );

    return res.data.results || [];
  } catch (e) {
    return [];
  }
}




async function summarizeWithAI(query, fdaResults) {
  try {
    function short(text, max = 200) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

const trimmedResults = fdaResults.slice(0, 2).map(r => ({
  brand: r.openfda?.brand_name?.[0] || '',
  generic: r.openfda?.generic_name?.[0] || '',
  purpose: short(r.purpose?.[0], 120),
  usage: short(r.indications_and_usage?.[0], 200),
  warnings: short(r.warnings?.[0], 150),
  dosage: short(r.dosage_and_administration?.[0], 120)
}));

   const prompt = `
User query: "${query}"

FDA data (may or may not be relevant):
${JSON.stringify(trimmedResults)}

Instructions:

1. Detect if the query is:
   - a MEDICINE
   - a DISEASE / SYMPTOM

2. If MEDICINE:
   - Use FDA data if relevant
   - Explain what the medicine is used for

3. If DISEASE / SYMPTOM:
   - IGNORE irrelevant FDA data
   - Explain the condition briefly
   - Provide commonly used medicines in India

4. Keep it simple, safe, and clear for patients.

Output JSON ONLY:
{
  "type": "medicine" or "disease",
  "name": "final name",
  "summary": "2-3 sentence explanation",
  "medicines": ["Med1", "Med2"],
  "dosage": "common dosage",
  "warning": "important warning"
}
`;
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 400,
        messages: [
          { role: 'system', content: 'You are a clinical pharmacist. Output only JSON.' },
          { role: 'user', content: prompt }
        ]
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
      }
    );

    const raw = response.data.choices[0].message.content
      .replace(/```json|```/g, '')
      .trim();

    return JSON.parse(raw);

  } catch (e) {
    console.error("AI error:", e.message);
    return null;
  }
}





app.post('/manual', async (req, res) => {
  const query = req.body.query?.trim();
  if (!query) return res.redirect('/?section=manual');

  let drugData = null;
  let errorMsg = null;

  try {
    // STEP 1: Get FDA data
    const fdaResults = await fetchFromFDA(query);

    // STEP 2: Always send to AI
    const aiResult = await summarizeWithAI(query, fdaResults);

    if (!aiResult || !aiResult.summary) {
      errorMsg = `No useful info found for "${query}"`;
    } else {
      drugData = {
      type: aiResult.type,
      name: aiResult.name || query,
      summary: aiResult.summary,
      medicines: aiResult.medicines || [],
      dosage: aiResult.dosage || 'N/A',
      warning: aiResult.warning || 'N/A'
    };
    }

  } catch (err) {
    console.error(err);
    errorMsg = 'Something went wrong';
  }

  res.render('index', {
    section: 'manual',
    manualResult: drugData,
    manualError: errorMsg,
    user: req.user
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
    match = { title: 'Unable to process', summary: 'Please consult a doctor.' };
  }

  if (req.user) {
    await pool.query(
      'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'bot', userMsg, match.title, match.summary]
    );
  }



  res.render('index', {
    section: 'bot', flowStep: 1,
    reply: { ...match, query: userMsg },
    manualResult: null, manualError: null,
    category: null, options: [], symptom: null,
    condition: null, user: req.user, advice: null
  });
});


app.post('/flow-step', (req, res) => {
  const category = req.body.category;

  const optionMap = {
    head:    ['Headache', 'Dizziness', 'Blurred Vision'],
    chest:   ['Chest Pain', 'Shortness of Breath'],
    stomach: ['Nausea', 'Abdominal Pain', 'Diarrhea'],
    joints:  ['Joint Pain', 'Swelling', 'Stiffness'],
    skin:    ['Rash', 'Itching', 'Red Spots'],
    eye:     ['Redness', 'Itching', 'Dry Eyes'],
    throat:  ['Sore Throat', 'Difficulty Swallowing', 'Voice Loss'],
    back:    ['Lower Back Pain', 'Upper Back Pain', 'Stiff Back'],
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