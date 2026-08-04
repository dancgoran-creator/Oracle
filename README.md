[README.md](https://github.com/user-attachments/files/30711412/README.md)
# The Oracle — Deployment Guide

## What's in this folder

```
the-oracle/
├── index.html        ← The full frontend (dark terminal UI)
├── api/
│   └── query.js      ← Vercel serverless proxy (calls Anthropic API)
├── vercel.json       ← Routing config
└── README.md         ← This file
```

## Deploy to Vercel (3 minutes, free)

### Step 1 — Get a free Vercel account
Go to https://vercel.com and sign up with GitHub, GitLab, or email.

### Step 2 — Install Vercel CLI (optional but fastest)
```bash
npm i -g vercel
```

Or skip this and use the web UI in Step 4b.

### Step 3 — Get your Anthropic API key
Go to https://console.anthropic.com → API Keys → Create key.
Copy it — you'll need it in Step 4.

### Step 4a — Deploy via CLI (fastest)
```bash
cd the-oracle
vercel
```
- When asked "Set up and deploy?" → Yes
- Project name → the-oracle (or anything)
- Which directory → ./  (current)
- Override settings? → No

Then add your API key:
```bash
vercel env add ANTHROPIC_API_KEY
```
Paste your key when prompted. Select all environments (Production, Preview, Development).

Then redeploy to pick up the env var:
```bash
vercel --prod
```

### Step 4b — Deploy via web UI (no CLI needed)
1. Zip the `the-oracle` folder
2. Go to https://vercel.com/new
3. Drag and drop the zip file
4. Click "Deploy"
5. Once deployed, go to Project Settings → Environment Variables
6. Add: `ANTHROPIC_API_KEY` = your key from Step 3
7. Go to Deployments → click the three dots → Redeploy

### Step 5 — Your URL
Vercel gives you a URL like `https://the-oracle-abc123.vercel.app`

That's it. The Refresh button now calls the API directly — no pasting needed.

## How it works

```
Browser → /api/query (Vercel function) → api.anthropic.com → response → browser
```

The Anthropic API key lives in Vercel's environment variables, never in the browser.
The proxy adds the key server-side before forwarding to Anthropic.

## Updating the watchlist

Edit the `WATCHLIST` array in `index.html` and redeploy:
```bash
vercel --prod
```

## Costs

- Vercel: Free tier (100GB bandwidth, unlimited deploys)
- Anthropic: ~$0.01–0.03 per Refresh (Sonnet 4.6 with web search, ~4000 tokens)
