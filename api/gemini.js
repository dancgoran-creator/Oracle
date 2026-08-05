const MODEL = 'gemini-3.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const https = require('https');

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    }).on('error', reject);
  });
}

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 10000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429) { await res.text(); continue; }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('Rate limited after 3 retries.');
}

function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'GOOGLE_AI_API_KEY not set' });

  // GET — list models
  if (req.method === 'GET') {
    try {
      const { body } = await httpsGet(
        'generativelanguage.googleapis.com',
        `/v1beta/models?key=${apiKey}`
      );
      const data = JSON.parse(body);
      const models = (data.models || []).map(m => m.name);
      return send(res, 200, { models });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const reqBody = req.body || {};
  const { mode, ticker, prompt } = reqBody;

  console.log('gemini req:', mode, ticker || '', !!prompt);

  // ── Analyst data for a single ticker (no grounding — uses training data) ─
  if (mode === 'analyst' && ticker) {
    const p = `You are a financial data assistant. From your training data provide analyst consensus data for the stock ${ticker} and return ONLY a raw JSON object. No markdown, no backticks. Start with { and end with }.

Required keys (all as strings):
"ticker": "${ticker}"
"buy": analyst buy rating count e.g. "18"
"hold": analyst hold rating count e.g. "5"
"sell": analyst sell rating count e.g. "2"
"pt_low": 12-month analyst price target low e.g. "150.00"
"pt_median": 12-month analyst price target median/average e.g. "210.00"
"pt_high": 12-month analyst price target high e.g. "280.00"
"upside_pct": % upside from current price to median PT e.g. "15.4" or "-3.2"

No $ £ € % signs in values. Use "N/A" if unknown. Return ONLY the JSON object.`;

    try {
      const raw = await callGemini(apiKey, p);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON for ${ticker}`);
      const obj = JSON.parse(match[0]);
      return send(res, 200, { analyst: obj });
    } catch (err) {
      console.error(`Analyst ${ticker}:`, err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ── Commentary / deep dive ───────────────────────────────────────────────
  if (!prompt) return send(res, 400, { error: `No prompt. mode=${mode}` });
  try {
    const text = await callGemini(apiKey, prompt);
    return send(res, 200, { text });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
};
