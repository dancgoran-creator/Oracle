# The Oracle — Stock Research Terminal

Live market data terminal using **Financial Modeling Prep** for prices/targets and **Gemini 2.5 Flash** for signal analysis.

## Repo structure

```
/
├── index.html        ← Frontend (single file, no build step)
├── api/
│   ├── fmp.js        ← Serverless proxy for FMP API
│   └── gemini.js     ← Serverless proxy for Google Gemini
├── vercel.json       ← Vercel config
└── README.md
```

## Environment variables (set in Vercel dashboard)

| Variable            | Value                            |
|---------------------|----------------------------------|
| FMP_API_KEY         | Your Financial Modeling Prep key |
| GOOGLE_AI_API_KEY   | Your Google AI Studio key        |

## Deploy

1. Push this repo to GitHub
2. Go to vercel.com → New Project → import your GitHub repo
3. Vercel auto-detects the api/ folder — no framework config needed
4. Add the two environment variables in Project Settings → Environment Variables
5. Deploy — done

## Data flow on Refresh

Browser
  → POST /api/fmp    (Vercel serverless function)
      → FMP /v3/quote                        (prices, day %, 52W high/low)
      → FMP /v4/price-target-consensus       (PT low / median / high)
      → FMP /v3/analyst-stock-recommendations (buy / hold / sell counts)
      → FMP /v3/historical-price-full         (30 days, for RSI-14 calc)
  → POST /api/gemini (Vercel serverless function)
      → Gemini 2.5 Flash                     (signal commentary + deep dive)

## RSI

RSI-14 is computed server-side in api/fmp.js from the last 15 daily closes.
Uses the simple Wilder method.

## Modifying the watchlist

Edit the WL array in index.html and push to GitHub — Vercel redeploys automatically.
