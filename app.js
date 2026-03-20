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
const authRoutes = require('./routes/auth');
app.use('/', authRoutes);

function matchSymptoms(message) {
  const cleaned = message.toLowerCase().trim();
  let bestMatch = null;
  let maxMatchCount = 0;

  for (const [key, value] of Object.entries(symptomData)) {
    const matchCount = value.keywords.filter(sym => cleaned.includes(sym.toLowerCase())).length;
    if (matchCount > 0 && matchCount > maxMatchCount) {
      maxMatchCount = matchCount;
      bestMatch = value;
    }
  }
  return bestMatch;
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

app.post('/manual', async (req, res) => {
  const query = req.body.query;
  let manualResult = "Sorry, no useful information found.";

  try {
    const response = await axios.get(`https://api.fda.gov/drug/label.json?search=${query}&limit=1`);
    const result = response.data.results?.[0];

    if (result) {
      const brand = result.openfda.brand_name?.[0] || "N/A";
      const purpose = result.purpose?.[0] || "N/A";
      const usage = result.indications_and_usage?.[0] || "N/A";
      const dosage = result.dosage_and_administration?.[0] || "N/A";

      manualResult = `
        <h3>💊 Brand: ${brand}</h3>
        <p><strong>🩺 Purpose:</strong> ${purpose}</p>
        <p><strong>📋 Usage:</strong> ${usage}</p>
        <p><strong>📦 Dosage:</strong> ${dosage}</p>
      `;
    }
    if (req.user && manualResult) {
  await pool.query(
    'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, 'manual', query, 'From OpenFDA', manualResult]
  );
}

  } catch (error) {
    console.error("OpenFDA error:", error.message);
    manualResult = "🚫 Failed to fetch drug info. Try another brand or disease name.";
  }

  res.render('index', { section: 'manual',
  flowStep: 1,
  reply: null,
  manualResult,
  category: null,
  options: [],
  symptom: null,
  condition: null,
  user: req.user,
  advice: null});
});


app.post('/chat', async (req, res) => {
  const userMsg = req.body.message;
  const match = matchSymptoms(userMsg);

  if (!match) {
    return res.render('index', { 
      section: 'bot', 
      flowStep: 1,
      reply: "I couldn't understand your symptoms. Please try describing them differently or use the Symptom Flow Assistant.",
      manualResult: null,
      category: null,
      options: [],
      symptom: null,
      condition: null,
      user: req.user,
      advice: null
    });
  }
  if (req.user) {
  await pool.query(
    'INSERT INTO history (user_id, source, symptom, condition, advice) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, 'bot', userMsg, match.condition, match.advice]
  );
}


  const fdaQuery = encodeURIComponent(match.condition.split(' ')[0]);
  let drugInfo = "No specific medication information found.";
  
  try {
    const response = await axios.get(
      `https://api.fda.gov/drug/label.json?search=indications_and_usage:${fdaQuery}&limit=1`
    );
    const result = response.data.results[0];
    if (result?.indications_and_usage) {
      drugInfo = result.indications_and_usage[0];
    }
  } catch (e) {
    console.log("OpenFDA Error:", e.message);
  }

  const reply = `
    <div class="chat-result">
      <p><strong>🏥 Possible Condition:</strong> ${match.condition}</p>
      <p><strong>✅ Medical Advice:</strong> ${match.advice}</p>
      <p><strong>💊 Related Medication Info:</strong></p>
      <p>${drugInfo}</p>
      <p><a href="https://medlineplus.gov/search/?query=${encodeURIComponent(match.condition)}" 
            target="_blank" class="learn-more">
        🔗 Learn more about ${match.condition} on MedlinePlus
      </a></p>
    </div>
  `;

  res.render('index', {
    section: 'bot',
    flowStep: 1,
    reply,
    manualResult: null,
    category: null,
    options: [],
    symptom: null,
    condition: null,
    user: req.user,
    advice: null
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
