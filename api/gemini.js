export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not set' });

  const { prompt, useSearch } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  };

  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  // Retry up to 3 times on 429 with exponential backoff
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 8000; // 8s, 16s
      console.log(`Gemini 429 — retrying in ${wait}ms (attempt ${attempt + 1})`);
      await sleep(wait);
    }

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (upstream.status === 429) {
        const errText = await upstream.text();
        lastErr = errText;
        continue; // retry
      }

      if (!upstream.ok) {
        const err = await upstream.text();
        console.error('Gemini error:', upstream.status, err.slice(0, 300));
        return res.status(upstream.status).json({ error: err.slice(0, 300) });
      }

      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text });

    } catch (err) {
      lastErr = err.message;
      console.error('Gemini fetch error:', err.message);
    }
  }

  // All retries exhausted
  return res.status(429).json({ error: 'Rate limited after 3 retries. Please wait a moment and try again. ' + (lastErr || '') });
}
