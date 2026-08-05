const MODEL = 'gemini-3.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 10000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      if (attempt === 2) throw new Error('Network error: ' + fetchErr.message);
      continue;
    }
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
  let json;
  try { json = JSON.stringify(data); }
  catch (e) { json = JSON.stringify({ error: 'Serialization error' }); }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(json);
  } catch (e) {
    console.error('Response write error:', e.message);
  }
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
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const data = await r.json();
      const models = (data.models || []).map(m => m.name);
      return send(res, 200, { models });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  let reqBody;
  try { reqBody = req.body || {}; }
  catch (e) { reqBody = {}; }

  const { mode, ticker, prompt } = reqBody;
  console.log('gemini req:', mode, ticker || '', !!prompt);

  // ── Analyst data for single ticker ───────────────────────────────────────
  if (mode === 'analyst' && ticker) {
    const p = `Financial data for stock ${ticker}. Return ONLY a JSON object, no markdown, start with { end with }.
Keys: "ticker","buy","hold","sell","pt_low","pt_median","pt_high","upside_pct"
- buy/hold/sell: analyst rating counts as integer strings e.g. "18"
- pt_low/pt_median/pt_high: 12-month price targets e.g. "210.00"
- upside_pct: % to median PT e.g. "15.4"
No currency symbols. Use "N/A" if unknown. JSON only.`;

    try {
      const raw = await callGemini(apiKey, p);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON found for ${ticker}`);
      const obj = JSON.parse(match[0]);
      return send(res, 200, { analyst: obj });
    } catch (err) {
      console.error(`Analyst ${ticker}:`, err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ── Commentary ───────────────────────────────────────────────────────────
  if (!prompt) return send(res, 400, { error: `No prompt. mode=${mode}` });
  try {
    const text = await callGemini(apiKey, prompt);
    return send(res, 200, { text });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
};
