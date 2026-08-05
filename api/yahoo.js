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

// RSI-14 from closes oldest→newest
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

// Simple moving average from last N closes
function calcSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / period;
  return avg.toFixed(2);
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

  const yahooSymbol = { 'RHM': 'RHM.DE' }[ticker] || ticker;

  try {
    // ── 1. Quote (price, meta fields) ────────────────────────────────────
    const quoteRes = await yahooFetch(
      `/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d&includePrePost=false`
    );
    if (quoteRes.status !== 200) throw new Error(`Yahoo quote ${quoteRes.status}`);

    const chart = quoteRes.data?.chart?.result?.[0];
    if (!chart) throw new Error(`No quote data for ${yahooSymbol}`);

    const meta      = chart.meta;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const currency  = meta.currency || 'USD';
    const w52high   = meta.fiftyTwoWeekHigh;
    const w52low    = meta.fiftyTwoWeekLow;
    const volume    = meta.regularMarketVolume;
    const avgVolume = meta.averageDailyVolume3Month || meta.averageDailyVolume10Day;
    const beta      = meta.beta ?? null;

    const changePct = prevClose
      ? (((price - prevClose) / prevClose) * 100).toFixed(2)
      : null;

    let pos52w = null;
    if (price && w52high && w52low && w52high !== w52low) {
      pos52w = (((price - w52low) / (w52high - w52low)) * 100).toFixed(1);
    }

    // ── 2. Historical — 6 months for 200d SMA + RSI ──────────────────────
    const histRes = await yahooFetch(
      `/v8/finance/chart/${yahooSymbol}?interval=1d&range=6mo`
    );

    let rsi = null, sma50 = null, sma200 = null, maSignal = null;

    if (histRes.status === 200) {
      const closes = (histRes.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(c => c != null);

      rsi    = calcRSI(closes);
      sma50  = calcSMA(closes, 50);
      sma200 = calcSMA(closes, 200);

      // Moving average signal
      if (sma50 && sma200) {
        const s50 = parseFloat(sma50);
        const s200 = parseFloat(sma200);
        if (s50 > s200 * 1.02) maSignal = 'golden';       // 50d >2% above 200d
        else if (s50 < s200 * 0.98) maSignal = 'death';   // 50d >2% below 200d
        else maSignal = 'neutral';
      }
    }

    // ── 3. Earnings date — quoteSummary calendarEvents ───────────────────
    let earningsDate = null;
    try {
      const earningsRes = await yahooFetch(
        `/v10/finance/quoteSummary/${yahooSymbol}?modules=calendarEvents`
      );
      if (earningsRes.status === 200) {
        const events = earningsRes.data?.quoteSummary?.result?.[0]?.calendarEvents;
        const dates  = events?.earnings?.earningsDate;
        if (dates && dates.length > 0) {
          // Yahoo returns Unix timestamps
          const next = dates[0]?.raw || dates[0];
          if (next) {
            const d = new Date(next * 1000);
            earningsDate = d.toISOString().split('T')[0]; // YYYY-MM-DD
          }
        }
      }
    } catch (e) {
      console.warn(`Earnings date for ${ticker}:`, e.message);
    }

    return send(res, 200, {
      ticker,
      price:       price     ? price.toFixed(2)     : null,
      currency,
      change_pct:  changePct,
      w52high:     w52high   ? w52high.toFixed(2)   : null,
      w52low:      w52low    ? w52low.toFixed(2)     : null,
      pos52w,
      rsi,
      volume:      volume    ? volume.toString()     : null,
      avg_volume:  avgVolume ? avgVolume.toString()  : null,
      beta:        beta      ? beta.toFixed(2)       : null,
      sma50,
      sma200,
      ma_signal:   maSignal,
      earnings_date: earningsDate,
    });

  } catch (err) {
    console.error(`Yahoo ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
