// Yahoo Finance proxy — fetches live quotes for all watchlist tickers
// Uses Yahoo Finance v8 quote endpoint (no API key required)

const https = require('https');

function yahooFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Oracle/1.0)',
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(new Error('JSON parse failed: ' + raw.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Calculate RSI-14 from array of closes (oldest to newest)
function calcRSI(closes) {
  if (!closes || closes.length < 15) return null;
  const slice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const n = slice.length - 1;
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return '100';
  return (100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
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

  const body = req.body || {};
  const { ticker } = body;
  if (!ticker) return send(res, 400, { error: 'ticker required' });

  // Yahoo Finance uses different symbols for some tickers
  const yahooSymbol = {
    'RHM':   'RHM.DE',   // Rheinmetall on XETRA
    'BAESY': 'BAESY',    // BAE Systems ADR
  }[ticker] || ticker;

  try {
    // ── 1. Live quote ────────────────────────────────────────────────────
    const quoteRes = await yahooFetch(
      `/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`
    );

    if (quoteRes.status !== 200) {
      throw new Error(`Yahoo quote ${quoteRes.status} for ${yahooSymbol}`);
    }

    const chart = quoteRes.data?.chart?.result?.[0];
    if (!chart) throw new Error(`No quote data for ${yahooSymbol}`);

    const meta = chart.meta;
    const price       = meta.regularMarketPrice;
    const prevClose   = meta.chartPreviousClose || meta.previousClose;
    const currency    = meta.currency || 'USD';
    const w52high     = meta.fiftyTwoWeekHigh;
    const w52low      = meta.fiftyTwoWeekLow;
    const changePct   = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(2) : null;

    // 52-week position
    let pos52w = null;
    if (price && w52high && w52low && w52high !== w52low) {
      pos52w = (((price - w52low) / (w52high - w52low)) * 100).toFixed(1);
    }

    // ── 2. Historical prices for RSI (last 30 days) ──────────────────────
    const histRes = await yahooFetch(
      `/v8/finance/chart/${yahooSymbol}?interval=1d&range=1mo`
    );

    let rsi = null;
    if (histRes.status === 200) {
      const closes = histRes.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const validCloses = closes.filter(c => c != null);
      rsi = calcRSI(validCloses);
    }

    return send(res, 200, {
      ticker,
      price:      price ? price.toFixed(2) : null,
      currency,
      change_pct: changePct,
      w52high:    w52high ? w52high.toFixed(2) : null,
      w52low:     w52low  ? w52low.toFixed(2)  : null,
      pos52w,
      rsi,
    });

  } catch (err) {
    console.error(`Yahoo ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
