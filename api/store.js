// Upstash Redis REST API — stores and retrieves watchlist data
// No npm packages needed — Upstash has a simple HTTP REST API

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

async function redisCommand(url, token, ...args) {
  const r = await fetch(`${url}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await r.json();
  if (data.error) throw new Error('Redis error: ' + data.error);
  return data.result;
}

const REDIS_KEY = 'oracle:watchlist';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return send(res, 500, { error: 'Upstash env vars not set (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)' });
  }

  // ── GET: load data ───────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const raw = await redisCommand(url, token, 'GET', REDIS_KEY);
      if (!raw) return send(res, 200, { data: null });
      const parsed = JSON.parse(raw);
      return send(res, 200, parsed);
    } catch (e) {
      console.error('store GET error:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // ── POST: save data ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const { data, timestamp } = body;
      if (!data) return send(res, 400, { error: 'data required' });

      const payload = JSON.stringify({ data, timestamp });

      // Store with 48h TTL (auto-expires stale data)
      await redisCommand(url, token, 'SET', REDIS_KEY, payload, 'EX', 172800);

      return send(res, 200, { ok: true });
    } catch (e) {
      console.error('store POST error:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed' });
};
