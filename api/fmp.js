const FMP_BASE = 'https://financialmodelingprep.com/api';

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
  // Log the URL (key will be visible in Vercel logs — rotate key if concerned)
  console.log('FMP request:', url.replace(process.env.FMP_API_KEY, 'REDACTED'));
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('FMP error body:', body.slice(0, 300));
    throw new Error(`FMP ${res.status} on ${path}: ${body.slice(0, 120)}`);
  }
  return res.json();
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

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FMP_API_KEY not set' });

  try {
    const symbols = tickers.join(',');

    // Fetch all three endpoints in parallel
    const [quotes, targets, ratings] = await Promise.all([
      fmpFetch(`/v3/quote/${symbols}`),
      fmpFetch(`/v4/price-target-consensus`, { symbol: symbols }),
      fmpFetch(`/v3/analyst-stock-recommendations/${symbols}`, { limit: 1 }),
    ]);

    // Historical prices for RSI — batch all tickers in parallel
    const histResults = await Promise.allSettled(
      tickers.map(t =>
        fmpFetch(`/v3/historical-price-full/${t}`, { timeseries: 30 })
          .then(d => ({ ticker: t, data: d?.historical || [] }))
      )
    );

    const histMap = {};
    for (const r of histResults) {
      if (r.status === 'fulfilled') {
        histMap[r.value.ticker] = r.value.data;
      }
    }

    // Index quotes by symbol
    const quoteMap = {};
    for (const q of (Array.isArray(quotes) ? quotes : [])) {
      quoteMap[q.symbol] = q;
    }

    // Index price targets by symbol
    const targetMap = {};
    for (const t of (Array.isArray(targets) ? targets : [])) {
      targetMap[t.symbol] = t;
    }

    // Sum analyst ratings (most recent batch)
    const ratingsMap = {};
    for (const r of (Array.isArray(ratings) ? ratings : [])) {
      const sym = r.symbol;
      if (!ratingsMap[sym]) ratingsMap[sym] = { buy: 0, hold: 0, sell: 0 };
      ratingsMap[sym].buy  += (r.analystRatingsbuy  || 0);
      ratingsMap[sym].hold += (r.analystRatingsHold || 0);
      ratingsMap[sym].sell += (r.analystRatingsSell || 0);
    }

    // Build per-ticker result
    const result = tickers.map(ticker => {
      const q  = quoteMap[ticker]  || {};
      const t  = targetMap[ticker] || {};
      const ra = ratingsMap[ticker] || {};
      const hist = histMap[ticker]  || [];

      // 52-week position %
      const price   = q.price    ?? null;
      const w52high = q.yearHigh  ?? null;
      const w52low  = q.yearLow   ?? null;
      let pos52w = null;
      if (price != null && w52high && w52low && w52high !== w52low) {
        pos52w = (((price - w52low) / (w52high - w52low)) * 100).toFixed(1);
      }

      // RSI-14 from last 15 closes (simple Wilder method)
      let rsi = null;
      if (hist.length >= 15) {
        const closes = hist.slice(0, 15).map(d => d.close).reverse();
        let gains = 0, losses = 0;
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff; else losses += Math.abs(diff);
        }
        const periods = closes.length - 1;
        const avgGain = gains / periods;
        const avgLoss = losses / periods;
        rsi = avgLoss === 0 ? '100' : (100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
      }

      return {
        ticker,
        price:      price != null ? price.toFixed(2) : null,
        currency:   q.currency || (ticker === 'RHM' ? 'EUR' : 'USD'),
        change_pct: q.changesPercentage != null ? q.changesPercentage.toFixed(2) : null,
        pt_low:     t.priceTargetLow     != null ? Number(t.priceTargetLow).toFixed(2)     : null,
        pt_median:  t.priceTargetAverage != null ? Number(t.priceTargetAverage).toFixed(2) : null,
        pt_high:    t.priceTargetHigh    != null ? Number(t.priceTargetHigh).toFixed(2)    : null,
        upside_pct: (price && t.priceTargetAverage)
          ? (((t.priceTargetAverage - price) / price) * 100).toFixed(1)
          : null,
        buy:   ra.buy  || 0,
        hold:  ra.hold || 0,
        sell:  ra.sell || 0,
        rsi,
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
