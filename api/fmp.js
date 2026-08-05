// This file is now a stub — data fetching moved to /api/gemini with Search grounding.
// Kept so existing routes don't 404 during deployment transition.
export default async function handler(req, res) {
  res.status(410).json({ error: 'This endpoint is deprecated. Use /api/gemini instead.' });
}
