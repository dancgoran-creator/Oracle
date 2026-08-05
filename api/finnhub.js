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
  console.log('finnhub called:', req.method);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'FINNHUB_API_KEY not set' });

  const body = req.body || {};
  const ticker = body.ticker;
  console.log('ticker:', ticker);
  if (!ticker) return send(res, 400, { error: 'ticker required' });

  const sym = { 'RHM': 'RHM.DE' }[ticker] || ticker;

  try {
    const base = `https://finnhub.io/api/v1`;
    const headers = { 'Accept': 'application/json', 'X-Finnhub-Token': apiKey };

    const [recRes, ptRes, calRes] = await Promise.allSettled([
      fetch(`${base}/stock/recommendation?symbol=${sym}&token=${apiKey}`, { headers }).then(r => r.json()),
      fetch(`${base}/stock/price-target?symbol=${sym}&token=${apiKey}`, { headers }).then(r => r.json()),
      fetch(`${base}/calendar/earnings?symbol=${sym}&token=${apiKey}`, { headers }).then(r => r.json()),
    ]);

    console.log('rec:', recRes.status, recRes.status === 'fulfilled' ? JSON.stringify(recRes.value).slice(0,100) : recRes.reason?.message);
    console.log('pt:', ptRes.status, ptRes.status === 'fulfilled' ? JSON.stringify(ptRes.value).slice(0,100) : ptRes.reason?.message);
    console.log('cal:', calRes.status, calRes.status === 'fulfilled' ? JSON.stringify(calRes.value).slice(0,100) : calRes.reason?.message);

    let buy = 0, hold = 0, sell = 0;
    if (recRes.status === 'fulfilled' && Array.isArray(recRes.value) && recRes.value.length > 0) {
      const l = recRes.value[0];
      buy  = (l.strongBuy  || 0) + (l.buy  || 0);
      hold =  l.hold       || 0;
      sell = (l.strongSell || 0) + (l.sell || 0);
    }

    let ptLow = null, ptMedian = null, ptHigh = null;
    if (ptRes.status === 'fulfilled' && ptRes.value && !ptRes.value.error) {
      const pt = ptRes.value;
      ptLow    = pt.targetLow  ? Number(pt.targetLow).toFixed(2)  : null;
      ptMedian = pt.targetMean ? Number(pt.targetMean).toFixed(2) : null;
      ptHigh   = pt.targetHigh ? Number(pt.targetHigh).toFixed(2) : null;
    }

    let earningsDate = null;
    if (calRes.status === 'fulfilled' && calRes.value && !calRes.value.error) {
      const earnings = calRes.value.earningsCalendar || [];
      const today = new Date().toISOString().split('T')[0];
      const upcoming = earnings.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
      if (upcoming.length > 0) earningsDate = upcoming[0].date;
    }

    console.log(`${ticker} result: buy=${buy} hold=${hold} sell=${sell} pt=${ptMedian} earnings=${earningsDate}`);

    return send(res, 200, { ticker, buy: buy.toString(), hold: hold.toString(), sell: sell.toString(), pt_low: ptLow, pt_median: ptMedian, pt_high: ptHigh, earnings_date: earningsDate });

  } catch (err) {
    console.error(`Finnhub error ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
