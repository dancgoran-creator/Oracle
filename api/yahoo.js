const https = require('https');

function yahooFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
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
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function calcRSI(closes) {
  if (!closes || closes.length < 15) return null;
  const slice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  const n = slice.length - 1;
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return '100';
  return (100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

function calcSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  return (slice.reduce((a, b) => a + b, 0) / period).toFixed(2);
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

  const { ticker } = req.body || {};
  if (!ticker) return send(res, 400, { error: 'ticker required' });

  const sym = { 'RHM': 'RHM.DE' }[ticker] || ticker;

  try {
    // Two fetches in parallel — quote for today, 1y history for SMAs/RSI
    const [quoteRes, histRes] = await Promise.allSettled([
      yahooFetch(`/v8/finance/chart/${sym}?interval=1d&range=1d`),
      yahooFetch(`/v8/finance/chart/${sym}?interval=1d&range=1y`),
    ]);

    // ── Live quote ────────────────────────────────────────────────────────
    if (quoteRes.status !== 'fulfilled' || !quoteRes.value.data) {
      throw new Error(`Quote failed for ${sym}`);
    }
    const chart = quoteRes.value.data?.chart?.result?.[0];
    if (!chart) throw new Error(`No data for ${sym}`);

    const meta      = chart.meta;
    // Log ALL meta keys so we can see everything available
    console.log(`${ticker} meta keys:`, Object.keys(meta).join(','));

    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.regularMarketPreviousClose;
    const currency  = meta.currency || 'USD';
    const w52high   = meta.fiftyTwoWeekHigh;
    const w52low    = meta.fiftyTwoWeekLow;
    const volume    = meta.regularMarketVolume;

    // These fields exist in meta but we weren't reading them
    const avgVolume    = meta.averageDailyVolume3Month
                      || meta.averageDailyVolume10Day
                      || null;
    const beta         = meta.beta ?? null;
    const sma50meta    = meta.fiftyDayAverage ?? null;
    const sma200meta   = meta.twoHundredDayAverage ?? null;

    // Earnings — Yahoo stores as Unix timestamp in meta
    let earningsDate = null;
    const ets = meta.earningsTimestamp
             || meta.earningsTimestampStart
             || null;
    if (ets) {
      const d = new Date(ets * 1000);
      const diffDays = (d - new Date()) / 86400000;
      if (diffDays > -90 && diffDays < 365) {
        earningsDate = d.toISOString().split('T')[0];
      }
    }

    const changePct = prevClose
      ? (((price - prevClose) / prevClose) * 100).toFixed(2)
      : null;

    const pos52w = (price && w52high && w52low && w52high !== w52low)
      ? (((price - w52low) / (w52high - w52low)) * 100).toFixed(1)
      : null;

    // ── Historical closes — RSI + SMA ─────────────────────────────────────
    let rsi = null, sma50 = null, sma200 = null, maSignal = null;
    if (histRes.status === 'fulfilled' && histRes.value.data) {
      const closes = (histRes.value.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(c => c != null);
      console.log(`${ticker} closes:`, closes.length);
      rsi = calcRSI(closes);
      // Use pre-calculated from meta if available, else calculate
      sma50  = sma50meta  ? sma50meta.toFixed(2)  : calcSMA(closes, 50);
      sma200 = sma200meta ? sma200meta.toFixed(2) : calcSMA(closes, 200);
    }

    if (sma50 && sma200) {
      const s50 = parseFloat(sma50), s200 = parseFloat(sma200);
      maSignal = s50 > s200 * 1.01 ? 'golden' : s50 < s200 * 0.99 ? 'death' : 'neutral';
    }

    return send(res, 200, {
      ticker,
      price:         price   != null ? price.toFixed(2)   : null,
      currency,
      change_pct:    changePct,
      w52high:       w52high != null ? w52high.toFixed(2) : null,
      w52low:        w52low  != null ? w52low.toFixed(2)  : null,
      pos52w,
      rsi,
      volume:        volume    ? volume.toString()    : null,
      avg_volume:    avgVolume ? avgVolume.toString() : null,
      beta:          beta      ? parseFloat(beta).toFixed(2) : null,
      sma50,
      sma200,
      ma_signal:     maSignal,
      earnings_date: earningsDate,
    });

  } catch (err) {
    console.error(`Yahoo ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
