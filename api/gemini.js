const MODEL = 'gemini-2.0-flash';

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
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );
      const data = await r.json();
      return send(res, 200, { models: (data.models || []).map(m => m.name) });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const { mode, ticker, prompt } = req.body || {};
  console.log('req:', mode, ticker || '', !!prompt);

  // ── Single attempt — no retries (avoid timeout) ──────────────────────────
  const callGemini = async (p) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: p }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(data).slice(0, 150)}`);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  };

  // ── Analyst mode ─────────────────────────────────────────────────────────
  if (mode === 'analyst' && ticker) {
    const p = `Analyst data for ${ticker}. Respond with ONLY this JSON (no markdown, no backticks):
{"ticker":"${ticker}","buy":"18","hold":"5","sell":"2","pt_low":"150.00","pt_median":"210.00","pt_high":"280.00","upside_pct":"15.4","earnings_date":"2025-10-30"}
Replace values with real data for ${ticker}. earnings_date = next earnings date as YYYY-MM-DD. Use N/A if unknown.`;

    try {
      const raw = await callGemini(p);
      console.log('raw:', raw.slice(0, 200));
      const match = raw.match(/\{[^{}]*\}/);
      if (!match) throw new Error('No JSON. Got: ' + raw.slice(0, 120));
      return send(res, 200, { analyst: JSON.parse(match[0]) });
    } catch (err) {
      console.error('analyst error:', err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ── Commentary mode ───────────────────────────────────────────────────────
  if (!prompt) return send(res, 400, { error: 'No prompt. mode=' + mode });
  try {
    const text = await callGemini(prompt);
    return send(res, 200, { text });
  } catch (err) {
    console.error('commentary error:', err.message);
    return send(res, 500, { error: err.message });
  }
};
