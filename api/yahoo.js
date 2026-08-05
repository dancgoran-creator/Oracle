const https = require('https');

function yahooFetch(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
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
        try { resolve({ status: res.statusCode, data: JSON.parse(raw), raw }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw }); }
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

function fmtN(v, dp = 2) {
  return v != null && !isNaN(v) ? parseFloat(v).toFixed(dp) : null;
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
    // Run all fetches in parallel
    const [quoteRes, histRes] = await Promise.allSettled([

      // v7/finance/quote — returns beta, avgVolume, 50d/200d MA, earnings in one shot
      yahooFetch('query1.finance.yahoo.com',
        `/v7/finance/quote?symbols=${sym}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,beta,earningsTimestamp,earningsTimestampStart,earningsTimestampEnd,currency`
      ),

      // 1 year history for RSI + SMA verification
      yahooFetch('query1.finance.yahoo.com',
        `/v8/finance/chart/${sym}?interval=1d&range=1y`
      ),
    ]);

    // ── v7 quote fields ───────────────────────────────────────────────────
    let price = null, changePct = null, volume = null, avgVolume = null;
    let w52high = null, w52low = null, beta = null;
    let sma50 = null, sma200 = null, maSignal = null;
    let earningsDate = null, currency = 'USD';

    if (quoteRes.status === 'fulfilled' && quoteRes.value.data) {
      const q = quoteRes.value.data?.quoteResponse?.result?.[0];
      console.log(`${ticker} v7 quote fields:`, q ? Object.keys(q).join(',') : 'none');

      if (q) {
        price      = q.regularMarketPrice;
        changePct  = q.regularMarketChangePercent?.toFixed(2) ?? null;
        volume     = q.regularMarketVolume;
        avgVolume  = q.averageDailyVolume3Month;
        w52high    = q.fiftyTwoWeekHigh;
        w52low     = q.fiftyTwoWeekLow;
        beta       = q.beta;
        currency   = q.currency || 'USD';

        // SMA from v7 (Yahoo pre-calculates these)
        sma50  = q.fiftyDayAverage  ? q.fiftyDayAverage.toFixed(2)   : null;
        sma200 = q.twoHundredDayAverage ? q.twoHundredDayAverage.toFixed(2) : null;

        if (sma50 && sma200) {
          const s50 = parseFloat(sma50), s200 = parseFloat(sma200);
          maSignal = s50 > s200 * 1.01 ? 'golden' : s50 < s200 * 0.99 ? 'death' : 'neutral';
        }

        // Earnings — Yahoo returns Unix timestamp
        const ets = q.earningsTimestamp || q.earningsTimestampStart;
        if (ets) {
          const d = new Date(ets * 1000);
          // Only use if in the future or recent past (within 3 months)
          const diffDays = (d - new Date()) / 86400000;
          if (diffDays > -90) earningsDate = d.toISOString().split('T')[0];
        }
      }
    } else {
      console.warn(`${ticker} v7 failed:`, quoteRes.reason?.message || quoteRes.value?.raw?.slice(0,100));
    }

    // ── Historical closes — RSI ───────────────────────────────────────────
    let rsi = null;
    if (histRes.status === 'fulfilled' && histRes.value.data) {
      const closes = (histRes.value.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(c => c != null);
      console.log(`${ticker} closes:`, closes.length);
      rsi = calcRSI(closes);
      // Use calculated SMAs if v7 didn't return them
      if (!sma50)  sma50  = calcSMA(closes, 50);
      if (!sma200) sma200 = calcSMA(closes, 200);
    }

    const pos52w = (price && w52high && w52low && w52high !== w52low)
      ? (((price - w52low) / (w52high - w52low)) * 100).toFixed(1)
      : null;

    return send(res, 200, {
      ticker,
      price:         fmtN(price),
      currency,
      change_pct:    changePct,
      w52high:       fmtN(w52high),
      w52low:        fmtN(w52low),
      pos52w,
      rsi,
      volume:        volume    ? volume.toString()    : null,
      avg_volume:    avgVolume ? avgVolume.toString() : null,
      beta:          fmtN(beta),
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
