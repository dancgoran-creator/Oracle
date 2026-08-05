const https = require('https');

function yahooFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
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

  const yahooSymbol = { 'RHM': 'RHM.DE' }[ticker] || ticker;

  try {
    // Run all three fetches in parallel
    const [quoteRes, histRes, summaryRes] = await Promise.allSettled([

      // 1. Live quote
      yahooFetch(`/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`),

      // 2. 1 year history — enough for 200d SMA + RSI
      yahooFetch(`/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`),

      // 3. Quote summary — beta, avg volume, earnings date
      yahooFetch(`/v10/finance/quoteSummary/${yahooSymbol}?modules=defaultKeyStatistics,calendarEvents,summaryDetail`),
    ]);

    // ── Quote ────────────────────────────────────────────────────────────
    const chart  = quoteRes.status === 'fulfilled'
      ? quoteRes.value.data?.chart?.result?.[0]
      : null;
    if (!chart) throw new Error(`No quote data for ${yahooSymbol}`);

    const meta      = chart.meta;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const currency  = meta.currency || 'USD';
    const w52high   = meta.fiftyTwoWeekHigh;
    const w52low    = meta.fiftyTwoWeekLow;
    const volume    = meta.regularMarketVolume;
    const changePct = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(2) : null;
    const pos52w    = (price && w52high && w52low && w52high !== w52low)
      ? (((price - w52low) / (w52high - w52low)) * 100).toFixed(1)
      : null;

    // ── Historical closes ────────────────────────────────────────────────
    let rsi = null, sma50 = null, sma200 = null, maSignal = null;
    if (histRes.status === 'fulfilled') {
      const closes = (histRes.value.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(c => c != null);
      console.log(`${ticker} closes count:`, closes.length);
      rsi    = calcRSI(closes);
      sma50  = calcSMA(closes, 50);
      sma200 = calcSMA(closes, 200);
      if (sma50 && sma200) {
        const s50 = parseFloat(sma50), s200 = parseFloat(sma200);
        maSignal = s50 > s200 * 1.01 ? 'golden' : s50 < s200 * 0.99 ? 'death' : 'neutral';
      }
    }

    // ── Quote summary (beta, avg vol, earnings) ──────────────────────────
    let beta = null, avgVolume = null, earningsDate = null;
    if (summaryRes.status === 'fulfilled') {
      const result = summaryRes.value.data?.quoteSummary?.result?.[0];
      console.log(`${ticker} summary keys:`, result ? Object.keys(result).join(',') : 'none');

      // Beta — in defaultKeyStatistics
      beta = result?.defaultKeyStatistics?.beta?.raw ?? null;

      // Avg volume — in summaryDetail
      avgVolume = result?.summaryDetail?.averageVolume?.raw
        || result?.summaryDetail?.averageVolume10days?.raw
        || null;

      // Earnings date — in calendarEvents
      const earningsDates = result?.calendarEvents?.earnings?.earningsDate;
      if (earningsDates && earningsDates.length > 0) {
        const raw = earningsDates[0]?.raw || earningsDates[0];
        if (raw) {
          earningsDate = new Date(raw * 1000).toISOString().split('T')[0];
        }
      }
    } else {
      console.warn(`${ticker} summary failed:`, summaryRes.reason?.message);
    }

    return send(res, 200, {
      ticker,
      price:         price     ? price.toFixed(2)    : null,
      currency,
      change_pct:    changePct,
      w52high:       w52high   ? w52high.toFixed(2)  : null,
      w52low:        w52low    ? w52low.toFixed(2)   : null,
      pos52w,
      rsi,
      volume:        volume    ? volume.toString()   : null,
      avg_volume:    avgVolume ? avgVolume.toString(): null,
      beta:          beta      ? beta.toFixed(2)     : null,
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
