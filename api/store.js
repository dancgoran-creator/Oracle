function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

const KEY = 'oracle:watchlist:v1';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Debug: log all env vars that mention upstash or redis (redact values)
  const envKeys = Object.keys(process.env)
    .filter(k => k.toLowerCase().includes('upstash') || k.toLowerCase().includes('redis') || k.toLowerCase().includes('kv'))
    .map(k => `${k}=${process.env[k] ? '[SET]' : '[EMPTY]'}`);
  console.log('Redis env vars found:', envKeys.join(', ') || 'NONE');

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    const msg = `Missing env vars. Found: ${envKeys.join(', ') || 'none'}`;
    console.error(msg);
    return send(res, 500, { error: msg });
  }

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const r = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      if (!data.result) return send(res, 200, { data: null, timestamp: null });
      return send(res, 200, JSON.parse(data.result));
    } catch (e) {
      console.error('GET error:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { data, timestamp } = req.body || {};
      if (!data) return send(res, 400, { error: 'data required' });

      const payload = JSON.stringify({ data, timestamp });

      // SET with EX using pipeline format
      const r = await fetch(`${url}/set/${encodeURIComponent(KEY)}/${encodeURIComponent(payload)}?EX=172800`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await r.json();
      if (result.error) throw new Error(result.error);
      return send(res, 200, { ok: true });
    } catch (e) {
      console.error('POST error:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed' });
};
