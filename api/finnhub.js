const https = require('https');

function finnhubFetch(path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'finnhub.io',
      path: `/api/v1${path}&token=${apiKey}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Finnhub-Token': apiKey,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'FINNHUB_API_KEY not set' });

  const { ticker } = req.body || {};
  if (!ticker) return send(res, 400, { error: 'ticker required' });

  // Finnhub uses different symbols for non-US stocks
  const sym = {
    'RHM':   'RHM.DE',   // Rheinmetall XETRA
    'BAESY': 'BAESY',    // BAE Systems ADR — US listed, works as-is
    'ASML':  'ASML',     // US ADR
    'NVO':   'NVO',      // US ADR
  }[ticker] || ticker;

  try {
    // Fetch all three in parallel
    const [recRes, ptRes, calRes] = await Promise.allSettled([

      // 1. Analyst recommendations (buy/hold/sell counts)
      finnhubFetch(`/stock/recommendation?symbol=${sym}`, apiKey),

      // 2. Price target (low/median/high)
      finnhubFetch(`/stock/price-target?symbol=${sym}`, apiKey),

      // 3. Earnings calendar
      finnhubFetch(`/calendar/earnings?symbol=${sym}`, apiKey),
    ]);

    // ── Analyst recommendations ───────────────────────────────────────────
    // Finnhub returns array of monthly snapshots — use the most recent
    let buy = 0, hold = 0, sell = 0;
    if (recRes.status === 'fulfilled' && Array.isArray(recRes.value.data) && recRes.value.data.length > 0) {
      const latest = recRes.value.data[0];
      buy  = (latest.strongBuy || 0) + (latest.buy  || 0);
      hold = latest.hold || 0;
      sell = (latest.strongSell || 0) + (latest.sell || 0);
    }

    // ── Price targets ─────────────────────────────────────────────────────
    let ptLow = null, ptMedian = null, ptHigh = null, upsidePct = null;
    if (ptRes.status === 'fulfilled' && ptRes.value.data) {
      const pt = ptRes.value.data;
      ptLow    = pt.targetLow    ? pt.targetLow.toFixed(2)    : null;
      ptMedian = pt.targetMean   ? pt.targetMean.toFixed(2)   : null;
      ptHigh   = pt.targetHigh   ? pt.targetHigh.toFixed(2)   : null;

      // Upside % requires current price — we'll calculate in frontend
      // but also store the raw mean so frontend can recalc if needed
    }

    // ── Earnings calendar ─────────────────────────────────────────────────
    let earningsDate = null;
    if (calRes.status === 'fulfilled' && calRes.value.data) {
      const earnings = calRes.value.data.earningsCalendar || [];
      // Find next upcoming earnings date
      const today = new Date().toISOString().split('T')[0];
      const upcoming = earnings
        .filter(e => e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (upcoming.length > 0) earningsDate = upcoming[0].date;
    }

    console.log(`${ticker}: buy=${buy} hold=${hold} sell=${sell} pt=${ptMedian} earnings=${earningsDate}`);

    return send(res, 200, {
      ticker,
      buy:           buy.toString(),
      hold:          hold.toString(),
      sell:          sell.toString(),
      pt_low:        ptLow,
      pt_median:     ptMedian,
      pt_high:       ptHigh,
      earnings_date: earningsDate,
    });

  } catch (err) {
    console.error(`Finnhub ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
