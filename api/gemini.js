const MODEL = 'gemini-3.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, prompt, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { console.log(`429 attempt ${attempt + 1}`); continue; }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('Rate limited after 3 retries — please wait a moment and try again.');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not set' });

  const { prompt, useSearch, tickers, mode } = req.body;

  // ── MODE: data — fetch market data in batches of 10 ─────────────────────
  if (mode === 'data' && Array.isArray(tickers)) {
    const BATCH = 10;
    const results = [];

    const dataPrompt = (batch) => `You are a market data assistant. Use Google Search to find current market data for these tickers and return ONLY a valid JSON array — no markdown, no code fences. Start with [ and end with ].

Tickers: ${batch.join(', ')}

For each ticker return an object with EXACTLY these keys:
"ticker"     - string
"price"      - string, e.g. "182.50"
"currency"   - string, "USD" or "EUR" (RHM only is EUR)
"change_pct" - string, e.g. "1.23" or "-0.45"
"buy"        - integer, analyst Buy count
"hold"       - integer, analyst Hold count
"sell"       - integer, analyst Sell count
"pt_low"     - string, 12-month PT low e.g. "150.00"
"pt_median"  - string, 12-month PT median e.g. "210.00"
"pt_high"    - string, 12-month PT high e.g. "280.00"
"upside_pct" - string, % upside to median PT e.g. "15.4"
"rsi"        - string, 14-day RSI e.g. "58.3"
"pos52w"     - string, 52W position 0-100 e.g. "67.2"

Use "N/A" only if genuinely unavailable. Numbers only — no currency symbols or % signs.
Return ONLY the JSON array starting with [`;

    try {
      for (let i = 0; i < tickers.length; i += BATCH) {
        const batch = tickers.slice(i, i + BATCH);
        const raw = await callGemini(apiKey, dataPrompt(batch), true);
        const match = raw.match(/\[[\s\S]*?\]/);
        if (match) {
          const rows = JSON.parse(match[0]);
          results.push(...rows);
        }
        // Pause between batches to stay under spend rate limit
        if (i + BATCH < tickers.length) await sleep(4000);
      }
      return res.status(200).json({ data: results });
    } catch (err) {
      console.error('Data fetch error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── MODE: prompt — commentary / deep dive ───────────────────────────────
  if (!prompt) return res.status(400).json({ error: 'prompt or tickers required' });

  try {
    const text = await callGemini(apiKey, prompt, useSearch || false);
    return res.status(200).json({ text });
  } catch (err) {
    console.error('Prompt error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
