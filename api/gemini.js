const MODEL = 'gemini-3.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, prompt, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 10000;
      console.log(`429 retry ${attempt + 1} — waiting ${wait}ms`);
      await sleep(wait);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await res.text(); continue; }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('Rate limited after 4 retries.');
}

// Parse body manually — handles cases where Vercel doesn't auto-parse
async function parseBody(req) {
  // Already parsed by Vercel
  if (req.body && typeof req.body === 'object') return req.body;
  // Raw stream — read and parse manually
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not set' });

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse request body: ' + e.message });
  }

  const { mode, ticker, prompt, useSearch } = body;

  console.log('Request body:', JSON.stringify({ mode, ticker: ticker || null, hasPrompt: !!prompt }));

  // ── MODE: single ticker ──────────────────────────────────────────────────
  if (mode === 'ticker' && ticker) {
    const p = `Search Google for current stock market data for ${ticker} and return ONLY a JSON object — no markdown, no code fences, just the raw JSON object.

Return exactly these keys:
"ticker"     - "${ticker}"
"price"      - current price, 2dp string e.g. "182.50"
"currency"   - "USD" or "EUR" (only RHM is EUR)
"change_pct" - today's % change, string e.g. "1.23" or "-0.45"
"buy"        - integer, analyst Buy count
"hold"       - integer, analyst Hold count
"sell"       - integer, analyst Sell count
"pt_low"     - 12-month price target low, string e.g. "150.00"
"pt_median"  - 12-month price target median, string e.g. "210.00"
"pt_high"    - 12-month price target high, string e.g. "280.00"
"upside_pct" - % upside to median PT, string e.g. "15.4" or "-3.2"
"rsi"        - 14-day RSI, string e.g. "58.3"
"pos52w"     - 52-week position 0-100, string e.g. "67.2"

Numbers only — no $ £ € or % in values. Use "N/A" if unavailable.
Return ONLY the JSON object starting with {`;

    try {
      const raw = await callGemini(apiKey, p, true);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON object found for ${ticker}. Raw: ${raw.slice(0,100)}`);
      const obj = JSON.parse(match[0]);
      return res.status(200).json({ ticker: obj });
    } catch (err) {
      console.error(`Ticker ${ticker} error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── MODE: commentary / deep dive ─────────────────────────────────────────
  if (!prompt) {
    return res.status(400).json({ error: `prompt or tickers required — received mode="${mode}", ticker="${ticker}"` });
  }
  try {
    const text = await callGemini(apiKey, prompt, useSearch || false);
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
