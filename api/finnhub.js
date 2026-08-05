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

    const [recRes, calRes] = await Promise.allSettled([
      fetch(`${base}/stock/recommendation?symbol=${sym}&token=${apiKey}`, { headers }).then(r => r.json()),
      fetch(`${base}/calendar/earnings?symbol=${sym}&token=${apiKey}`, { headers }).then(r => r.json()),
    ]);

    console.log('rec:', recRes.status === 'fulfilled' ? JSON.stringify(recRes.value).slice(0,80) : recRes.reason?.message);
    console.log('cal:', calRes.status === 'fulfilled' ? JSON.stringify(calRes.value).slice(0,80) : calRes.reason?.message);

    let buy = 0, hold = 0, sell = 0;
    if (recRes.status === 'fulfilled' && Array.isArray(recRes.value) && recRes.value.length > 0) {
      const l = recRes.value[0];
      buy  = (l.strongBuy  || 0) + (l.buy  || 0);
      hold =  l.hold       || 0;
      sell = (l.strongSell || 0) + (l.sell || 0);
    }

    let earningsDate = null;
    if (calRes.status === 'fulfilled' && calRes.value && !calRes.value.error) {
      const earnings = calRes.value.earningsCalendar || [];
      const today = new Date().toISOString().split('T')[0];
      const upcoming = earnings
        .filter(e => e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (upcoming.length > 0) earningsDate = upcoming[0].date;
      // If no future date found, leave as null — frontend will show N/A
    }

    console.log(`${ticker} result: buy=${buy} hold=${hold} sell=${sell} earnings=${earningsDate}`);

    return send(res, 200, { ticker, buy: buy.toString(), hold: hold.toString(), sell: sell.toString(), earnings_date: earningsDate });

  } catch (err) {
    console.error(`Finnhub error ${ticker}:`, err.message);
    return send(res, 500, { error: err.message });
  }
};
