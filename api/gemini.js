const MODEL = 'gemini-3.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, prompt, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 15000; // 15s, 30s, 45s, 60s
      console.log(`429 retry ${attempt + 1} — waiting ${wait}ms`);
      await sleep(wait);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const errText = await res.text();
      console.log(`429 on attempt ${attempt + 1}:`, errText.slice(0, 100));
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('Rate limited after 5 retries — your Gemini quota is exhausted. Wait a few minutes and try again.');
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not set' });

  // ── GET: list available models ───────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const data = await r.json();
      const models = (data.models || []).map(m => m.name);
      return res.status(200).json({ models });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = await parseBody(req); }
  catch (e) { return res.status(400).json({ error: 'Bad request body: ' + e.message }); }

  const { mode, ticker, prompt, useSearch } = body;
  console.log('gemini handler:', JSON.stringify({ mode, ticker: ticker || null, hasPrompt: !!prompt }));

  // ── MODE: single ticker ──────────────────────────────────────────────────
  if (mode === 'ticker' && ticker) {
    const p = `Search Google for current stock market data for the ticker ${ticker} and return ONLY a raw JSON object. No markdown, no backticks, no explanation. Start with { and end with }.

Required keys (all values as strings):
"ticker": "${ticker}"
"price": current price e.g. "182.50"
"currency": "USD" or "EUR" (RHM only = EUR)
"change_pct": today % change e.g. "1.23" or "-0.45"
"buy": analyst buy count as integer string e.g. "18"
"hold": analyst hold count e.g. "5"
"sell": analyst sell count e.g. "2"
"pt_low": 12-month price target low e.g. "150.00"
"pt_median": 12-month price target median e.g. "210.00"
"pt_high": 12-month price target high e.g. "280.00"
"upside_pct": % upside to median PT e.g. "15.4"
"rsi": 14-day RSI e.g. "58.3"
"pos52w": 52-week position 0-100 e.g. "67.2"

No $ £ € % signs in values. Use "N/A" if unavailable. Return ONLY the JSON object.`;

    try {
      const raw = await callGemini(apiKey, p, true);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON for ${ticker}. Got: ${raw.slice(0, 150)}`);
      const obj = JSON.parse(match[0]);
      return res.status(200).json({ ticker: obj });
    } catch (err) {
      console.error(`${ticker} failed:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── MODE: commentary ─────────────────────────────────────────────────────
  if (!prompt) return res.status(400).json({ error: `No prompt. Received: mode=${mode}, ticker=${ticker}` });
  try {
    const text = await callGemini(apiKey, prompt, useSearch || false);
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
