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
    // All three fetches in parallel
    const [quoteRes, histRes, detailRes] = await Promise.allSettled([

      // 1. v8 chart — price, volume, 52w (proven working)
      yahooFetch('query1.finance.yahoo.com',
        `/v8/finance/chart/${sym}?interval=1d&range=1d`
      ),

      // 2. v8 chart 1y history — RSI + SMA calculation
      yahooFetch('query1.finance.yahoo.com',
        `/v8/finance/chart/${sym}?interval=1d&range=1y`
      ),

      // 3. v11 quoteSummary — beta, avg volume, earnings (newer endpoint, no crumb needed)
      yahooFetch('query2.finance.yahoo.com',
        `/v11/finance/quoteSummary/${sym}?modules=summaryDetail%2CdefaultKeyStatistics%2CcalendarEvents`
      ),
    ]);

    // ── 1. Live quote (v8 — proven) ───────────────────────────────────────
    if (quoteRes.status !== 'fulfilled' || !quoteRes.value.data) {
      throw new Error(`Quote fetch failed for ${sym}`);
    }
    const chart = quoteRes.value.data?.chart?.result?.[0];
    if (!chart) throw new Error(`No chart result for ${sym}`);

    const meta      = chart.meta;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.regularMarketPreviousClose;
    const currency  = meta.currency || 'USD';
    const w52high   = meta.fiftyTwoWeekHigh;
    const w52low    = meta.fiftyTwoWeekLow;
    const volume    = meta.regularMarketVolume;

    const changePct = prevClose
      ? (((price - prevClose) / prevClose) * 100).toFixed(2)
      : null;

    const pos52w = (price && w52high && w52low && w52high !== w52low)
      ? (((price - w52low) / (w52high - w52low)) * 100).toFixed(1)
      : null;

    // ── 2. Historical closes — RSI + SMA ─────────────────────────────────
    let rsi = null, sma50 = null, sma200 = null, maSignal = null;
    if (histRes.status === 'fulfilled' && histRes.value.data) {
      const closes = (histRes.value.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(c => c != null);
      console.log(`${ticker} closes:`, closes.length);
      rsi    = calcRSI(closes);
      sma50  = calcSMA(closes, 50);
      sma200 = calcSMA(closes, 200);
      if (sma50 && sma200) {
        const s50 = parseFloat(sma50), s200 = parseFloat(sma200);
        maSignal = s50 > s200 * 1.01 ? 'golden' : s50 < s200 * 0.99 ? 'death' : 'neutral';
      }
    }

    // ── 3. Summary detail — beta, avg vol, earnings ───────────────────────
    let beta = null, avgVolume = null, earningsDate = null;
    if (detailRes.status === 'fulfilled' && detailRes.value.data) {
      const r = detailRes.value.data?.quoteSummary?.result?.[0];
      console.log(`${ticker} summary modules:`, r ? Object.keys(r).join(',') : 'none');

      if (r) {
        // summaryDetail has beta and avgVolume
        beta      = r.summaryDetail?.beta?.raw ?? null;
        avgVolume = r.summaryDetail?.averageVolume?.raw
                 || r.summaryDetail?.averageVolume10days?.raw
                 || null;

        // calendarEvents has earnings
        const earningsDates = r.calendarEvents?.earnings?.earningsDate;
        if (earningsDates?.length > 0) {
          const ts = earningsDates[0]?.raw || earningsDates[0];
          if (ts) {
            const d = new Date(ts * 1000);
            const diffDays = (d - new Date()) / 86400000;
            if (diffDays > -90) earningsDate = d.toISOString().split('T')[0];
          }
        }
      }
    } else {
      console.warn(`${ticker} detail failed:`, detailRes.reason?.message || 'no data');
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
