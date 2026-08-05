// FMP Stable API proxy
// All endpoints use https://financialmodelingprep.com/stable/

const FMP_BASE = 'https://financialmodelingprep.com/stable';

function buildUrl(path, params = {}) {
  const apiKey = process.env.FMP_API_KEY;
  const url = new URL(`${FMP_BASE}${path}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function fmpFetch(path, params = {}) {
  const url = buildUrl(path, params);
  console.log('FMP →', path, params);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('FMP error:', res.status, body.slice(0, 200));
    throw new Error(`FMP ${res.status} on ${path}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return data;
}

// RSI-14 from array of closes (oldest → newest)
function calcRSI(closes) {
  if (closes.length < 15) return null;
  const slice = closes.slice(-15); // last 15
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tickers } = req.body;
  if (!tickers || !Array.isArray(tickers)) {
    return res.status(400).json({ error: 'tickers array required' });
  }
  if (!process.env.FMP_API_KEY) {
    return res.status(500).json({ error: 'FMP_API_KEY not configured' });
  }

  try {
    const symbols = tickers.join(',');

    // ── 1. Batch quote (prices, day%, 52W high/low) ──────────────────────
    const quotes = await fmpFetch('/batch-quote', { symbols });

    // ── 2. Price targets + analyst ratings — per ticker in parallel ──────
    // stable endpoint is per-symbol for these
    const [targetResults, ratingResults, histResults] = await Promise.all([

      // Price target consensus — one call per ticker
      Promise.allSettled(
        tickers.map(t =>
          fmpFetch('/price-target-consensus', { symbol: t })
            .then(d => ({ ticker: t, data: Array.isArray(d) ? d[0] : d }))
            .catch(e => ({ ticker: t, data: null, error: e.message }))
        )
      ),

      // Analyst grades summary (buy/hold/sell counts)
      Promise.allSettled(
        tickers.map(t =>
          fmpFetch('/grades-consensus', { symbol: t })
            .then(d => ({ ticker: t, data: Array.isArray(d) ? d[0] : d }))
            .catch(e => ({ ticker: t, data: null, error: e.message }))
        )
      ),

      // Historical daily prices for RSI (last 30 trading days)
      Promise.allSettled(
        tickers.map(t =>
          fmpFetch('/historical-price-eod/light', { symbol: t, limit: 30 })
            .then(d => ({ ticker: t, data: Array.isArray(d) ? d : [] }))
            .catch(e => ({ ticker: t, data: [], error: e.message }))
        )
      ),
    ]);

    // ── Index results by ticker ──────────────────────────────────────────
    const quoteMap = {};
    for (const q of (Array.isArray(quotes) ? quotes : [])) {
      quoteMap[q.symbol] = q;
    }

    const targetMap = {};
    for (const r of targetResults) {
      if (r.status === 'fulfilled' && r.value.data) {
        targetMap[r.value.ticker] = r.value.data;
      }
    }

    const ratingsMap = {};
    for (const r of ratingResults) {
      if (r.status === 'fulfilled' && r.value.data) {
        ratingsMap[r.value.ticker] = r.value.data;
      }
    }

    const histMap = {};
    for (const r of histResults) {
      if (r.status === 'fulfilled') {
        // FMP returns newest first — reverse for RSI calc (oldest→newest)
        histMap[r.value.ticker] = (r.value.data || []).map(d => d.close).reverse();
      }
    }

    // ── Build per-ticker result ──────────────────────────────────────────
    const result = tickers.map(ticker => {
      const q  = quoteMap[ticker]  || {};
      const t  = targetMap[ticker] || {};
      const ra = ratingsMap[ticker] || {};
      const closes = histMap[ticker] || [];

      const price   = q.price    ?? null;
      const w52high = q.yearHigh  ?? null;
      const w52low  = q.yearLow   ?? null;

      // 52-week position %
      let pos52w = null;
      if (price != null && w52high && w52low && w52high !== w52low) {
        pos52w = (((price - w52low) / (w52high - w52low)) * 100).toFixed(1);
      }

      // Price targets — stable API field names
      const ptLow    = t.priceTargetLow    ?? t.targetLow    ?? null;
      const ptMedian = t.priceTargetMedian ?? t.targetMedian ?? t.priceTarget ?? null;
      const ptHigh   = t.priceTargetHigh   ?? t.targetHigh   ?? null;

      // Analyst ratings — stable grades-consensus field names
      const buy  = ra.strongBuy  != null ? (ra.strongBuy  + (ra.buy  || 0)) : (ra.buy  || 0);
      const hold = ra.hold       || 0;
      const sell = ra.strongSell != null ? (ra.strongSell + (ra.sell || 0)) : (ra.sell || 0);

      return {
        ticker,
        price:      price     != null ? price.toFixed(2)              : null,
        currency:   q.currency || (ticker === 'RHM' ? 'EUR' : 'USD'),
        change_pct: q.changesPercentage != null ? q.changesPercentage.toFixed(2) : null,
        pt_low:     ptLow    != null ? Number(ptLow).toFixed(2)    : null,
        pt_median:  ptMedian != null ? Number(ptMedian).toFixed(2) : null,
        pt_high:    ptHigh   != null ? Number(ptHigh).toFixed(2)   : null,
        upside_pct: (price && ptMedian)
          ? (((Number(ptMedian) - price) / price) * 100).toFixed(1)
          : null,
        buy,
        hold,
        sell,
        rsi:    calcRSI(closes),
        pos52w,
        w52high: w52high != null ? w52high.toFixed(2) : null,
        w52low:  w52low  != null ? w52low.toFixed(2)  : null,
      };
    });

    return res.status(200).json({ data: result });

  } catch (err) {
    console.error('FMP handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
