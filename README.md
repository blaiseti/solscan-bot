# SOLSCAN ALPHA — Telegram Bot

Live Solana signal bot. Polls DexScreener every 60s, scores new pairs,
and pushes HIGH signals directly to your Telegram.

## Deploy to Render.com (Free — Recommended)

1. Push this folder to a GitHub repo (see step-by-step below)
2. Go to render.com → sign up free
3. New → Web Service → connect your GitHub repo
4. Settings:
   - Build Command: `npm install`
   - Start Command: `node bot.js`
   - Environment: Node
5. Add environment variable:
   - Key: `BOT_TOKEN`
   - Value: your bot token from @BotFather
6. Click Deploy
7. Done — your bot runs 24/7 for free

## Push to GitHub (first time)

```bash
cd solscan-bot
git init
git add .
git commit -m "SOLSCAN ALPHA bot"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOURUSERNAME/solscan-bot.git
git push -u origin main
```

## Run locally (for testing)

```bash
# 1. Install dependencies
npm install

# 2. Create .env file
cp .env.example .env
# Edit .env and paste your BOT_TOKEN

# 3. Start the bot
node bot.js
```

## Commands

Send any of these to your bot in Telegram:

/start        — Welcome message
/top          — Top 5 HIGH signal coins now
/new          — Newest launched coins
/trending     — Top gainers 24H
/signals      — Last 10 signals
/filter HIGH  — Only HIGH signals (5x+)
/filter MEDIUM — MEDIUM + HIGH (3x+)
/threshold 65 — Min score threshold
/narratives   — Active narrative categories
/narrative AI — Top AI coins now
/tracknarrative DePIN — Auto-alerts for DePIN
/watchlist    — Your saved tokens
/watch [CA]   — Add token to watchlist
/price [CA]   — Live price for any token
/alert [CA] [price] — Price target alert
/pause        — Mute all signals
/resume       — Restore signals
/settings     — View all config
/help         — Full command list
/stop         — Disconnect

## Notes

- Bot polls DexScreener every 60 seconds (free, no key needed)
- Add HELIUS_API_KEY to .env for real whale tracking
- Add BIRDEYE_API_KEY to .env for enriched price data
- NOT financial advice. DYOR always.
