module.exports = async function handler(req, res) {
  console.log('finnhub handler called');
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ ok: true, key: !!process.env.FINNHUB_API_KEY }));
};
