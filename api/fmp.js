const FMP_BASE = 'https://financialmodelingprep.com/api';

async function fmpFetch(path) {
  const apiKey = process.env.FMP_API_KEY;
  const url = `${FMP_BASE}${path}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${path}`);
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

    // Batch fetch: quotes + price targets + analyst ratings
    const [quotes, targets, ratings] = await Promise.all([
      fmpFetch(`/v3/quote/${symbols}?`),
      fmpFetch(`/v4/price-target-consensus?symbol=${symbols}&`),
      fmpFetch(`/v3/analyst-stock-recommendations/${symbols}?limit=1&`),
    ]);

    // Historical prices for RSI (daily, last 30 days is enough for 14-day RSI)
    // Fetch per-ticker in parallel (FMP v3 historical-price-full is per-symbol)
    const histResults = await Promise.allSettled(
      tickers.map(t =>
        fmpFetch(`/v3/historical-price-full/${t}?timeseries=30&`)
          .then(d => ({ ticker: t, data: d?.historical || [] }))
      )
    );

    const histMap = {};
    for (const r of histResults) {
      if (r.status === 'fulfilled') {
        histMap[r.value.ticker] = r.value.data;
      }
    }

    // Index by symbol
    const quoteMap = {};
    for (const q of (quotes || [])) quoteMap[q.symbol] = q;

    const targetMap = {};
    for (const t of (targets || [])) targetMap[t.symbol] = t;

    // Ratings come back as an array of recent recommendations per symbol
    // We want the most recent one — sum last 1 month
    const ratingsMap = {};
    for (const r of (ratings || [])) {
      const sym = r.symbol;
      if (!ratingsMap[sym]) {
        ratingsMap[sym] = { buy: 0, hold: 0, sell: 0 };
      }
      ratingsMap[sym].buy  += (r.analystRatingsbuy  || 0);
      ratingsMap[sym].hold += (r.analystRatingsHold || 0);
      ratingsMap[sym].sell += (r.analystRatingsSell || 0);
    }

    // Build per-ticker payload
    const result = tickers.map(ticker => {
      const q  = quoteMap[ticker]  || {};
      const t  = targetMap[ticker] || {};
      const ra = ratingsMap[ticker] || {};
      const hist = histMap[ticker]  || [];

      // 52-week position
      const price   = q.price        || null;
      const w52high = q.yearHigh      || null;
      const w52low  = q.yearLow       || null;
      let pos52w = null;
      if (price && w52high && w52low && w52high !== w52low) {
        pos52w = (((price - w52low) / (w52high - w52low)) * 100).toFixed(1);
      }

      // RSI-14 from historical closes
      let rsi = null;
      if (hist.length >= 15) {
        const closes = hist.slice(0, 15).map(d => d.close).reverse(); // oldest→newest
        let gains = 0, losses = 0;
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff; else losses += Math.abs(diff);
        }
        const periods = closes.length - 1;
        const avgGain = gains / periods;
        const avgLoss = losses / periods;
        if (avgLoss === 0) {
          rsi = '100';
        } else {
          const rs = avgGain / avgLoss;
          rsi = (100 - 100 / (1 + rs)).toFixed(1);
        }
      }

      return {
        ticker,
        price:      price     ? price.toFixed(2)                    : null,
        currency:   q.currency || (ticker === 'RHM' ? 'EUR' : 'USD'),
        change_pct: q.changesPercentage ? q.changesPercentage.toFixed(2) : null,
        pt_low:     t.priceTargetLow    ? t.priceTargetLow.toFixed(2)    : null,
        pt_median:  t.priceTargetAverage? t.priceTargetAverage.toFixed(2): null,
        pt_high:    t.priceTargetHigh   ? t.priceTargetHigh.toFixed(2)   : null,
        upside_pct: (price && t.priceTargetAverage)
                      ? (((t.priceTargetAverage - price) / price) * 100).toFixed(1)
                      : null,
        buy:        ra.buy  || 0,
        hold:       ra.hold || 0,
        sell:       ra.sell || 0,
        rsi,
        pos52w,
        w52high:    w52high ? w52high.toFixed(2) : null,
        w52low:     w52low  ? w52low.toFixed(2)  : null,
      };
    });

    return res.status(200).json({ data: result });

  } catch (err) {
    console.error('FMP error:', err);
    return res.status(500).json({ error: err.message });
  }
}
