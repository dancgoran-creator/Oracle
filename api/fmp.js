module.exports = async function handler(req, res) {
  res.status(410).json({ error: 'FMP endpoint deprecated. Use /api/gemini.' });
};
