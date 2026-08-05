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

async function redis(url, token, command, ...args) {
  // Upstash REST API: POST {url}/{command}/{args...}
  const path = [command, ...args.map(a => encodeURIComponent(a))].join('/');
  const r = await fetch(`${url}/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function redisSet(url, token, key, value, exSeconds) {
  // SET with EX needs POST with body
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([value, 'EX', exSeconds]),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
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

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return send(res, 500, { error: 'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set' });
  }

  // ── GET: load ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const raw = await redis(url, token, 'GET', KEY);
      if (!raw) return send(res, 200, { data: null, timestamp: null });
      return send(res, 200, JSON.parse(raw));
    } catch (e) {
      console.error('store GET:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // ── POST: save ────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { data, timestamp } = req.body || {};
      if (!data) return send(res, 400, { error: 'data required' });
      const payload = JSON.stringify({ data, timestamp });
      await redisSet(url, token, KEY, payload, 172800); // 48h TTL
      return send(res, 200, { ok: true });
    } catch (e) {
      console.error('store POST:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed' });
};
