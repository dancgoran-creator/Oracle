const MODEL = 'gemini-3.1-flash-lite';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, prompt, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(attempt * 10000);
    }
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
  // CORS preflight
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

  const body = req.body || {};
  const { mode, ticker, prompt, useSearch } = body;

  console.log('gemini req:', mode, ticker || '', !!prompt);

  // Single ticker
  if (mode === 'ticker' && ticker) {
    const p = `Search Google for current stock market data for ${ticker} and return ONLY a raw JSON object. No markdown, no backticks. Start with { end with }.
Keys (all strings): ticker, price, currency, change_pct, buy, hold, sell, pt_low, pt_median, pt_high, upside_pct, rsi, pos52w
- price: e.g. "182.50", currency: "USD" or "EUR" (RHM=EUR only)
- buy/hold/sell: analyst counts e.g. "18"
- pt_low/pt_median/pt_high: price targets e.g. "210.00"
- upside_pct: e.g. "15.4", rsi: e.g. "58.3", pos52w: 0-100 e.g. "67.2"
No $ £ € % in values. Use "N/A" if unavailable. Return ONLY the JSON object.`;

    try {
      const raw = await callGemini(apiKey, p, true);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON for ${ticker}`);
      const obj = JSON.parse(match[0]);
      return send(res, 200, { ticker: obj });
    } catch (err) {
      console.error(ticker, err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // Commentary
  if (!prompt) return send(res, 400, { error: `No prompt. mode=${mode}` });
  try {
    const text = await callGemini(apiKey, prompt, useSearch || false);
    return send(res, 200, { text });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
};
