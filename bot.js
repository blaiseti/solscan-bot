// ══════════════════════════════════════════════════════════
//  SOLSCAN ALPHA — Telegram Bot Server
//  Run: node bot.js
//  Deploy: Render.com / Fly.io / Railway (free tier)
// ══════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const fetch      = require('node-fetch');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────
// These come from your .env file (see .env.example)
const BOT_TOKEN   = process.env.BOT_TOKEN;
const PORT        = process.env.PORT || 3000;
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';

if (!BOT_TOKEN) {
  console.error('❌  BOT_TOKEN missing — add it to your .env file');
  process.exit(1);
}

// ── BOT INIT ──────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ── USER STATE ────────────────────────────────────────────
// Stores per-user config in memory (persists while server runs)
const users = {};

function getUser(chatId) {
  if (!users[chatId]) {
    users[chatId] = {
      chatId,
      filter:       'HIGH',    // HIGH | MEDIUM | ALL
      threshold:    60,        // 0-100
      minWhale:     500,       // USD
      paused:       false,
      alerts: {
        newCoins:   true,
        whales:     true,
        narrative:  true,
        volume:     false,
        rug:        false,
      },
      watchlist:    [],        // array of { address, symbol }
      trackedNarratives: [],   // array of narrative names
      whaleAlertsOn:    true,
      whaleBuysOn:      true,
      whaleSellsOn:     true,
      newCoinsOn:       true,
      priceAlerts:      [],    // { address, target, symbol }
    };
  }
  return users[chatId];
}

// ── NARRATIVE KEYWORDS ────────────────────────────────────
const NARRATIVES = {
  AI:      ['ai','agent','gpt','llm','neural','intelligence','bot','agi','compute'],
  DePIN:   ['depin','network','node','mesh','sensor','iot','infra','relay','router'],
  RWA:     ['rwa','gold','silver','realestate','bond','equity','tokenized','asset'],
  Gaming:  ['game','play','metaverse','nft','item','loot','rpg','arena','battle'],
  Meme:    ['meme','doge','pepe','shib','cat','dog','inu','frog','moon','bonk','wif'],
  DeFi:    ['defi','swap','yield','lp','farm','stake','vault','liquidity','amm'],
  Social:  ['social','friend','dating','chat','post','feed','creator','fan'],
  PayFi:   ['pay','payment','card','cash','usd','merchant','spend','transfer'],
};

function detectNarratives(name) {
  const n = name.toLowerCase();
  return Object.entries(NARRATIVES)
    .filter(([, kw]) => kw.some(k => n.includes(k)))
    .map(([cat]) => cat);
}

// ── SCORING ───────────────────────────────────────────────
function scorePair(pair, ageH) {
  let s = 0;
  const name = ((pair.baseToken?.name || '') + ' ' + (pair.baseToken?.symbol || '')).toLowerCase();
  if (ageH < 1) s += 40; else if (ageH < 6) s += 28; else if (ageH < 24) s += 18; else if (ageH < 72) s += 8;
  const vol = pair.volume?.h24 || 0;
  if (vol > 500000) s += 20; else if (vol > 100000) s += 14; else if (vol > 20000) s += 8;
  const ch = parseFloat(pair.priceChange?.h24) || 0;
  if (ch > 500) s += 22; else if (ch > 200) s += 16; else if (ch > 50) s += 10;
  const liq = pair.liquidity?.usd || 0;
  if (liq > 100000) s += 10; else if (liq > 20000) s += 6; else if (liq < 1000) s -= 15;
  const b = pair.txns?.h24?.buys || 0, sl = pair.txns?.h24?.sells || 0;
  if (b + sl > 0) { const r = b / (b + sl); if (r > 0.72) s += 14; else if (r > 0.6) s += 7; }
  s += detectNarratives(name).length * 5;
  return Math.min(Math.max(s, 0), 100);
}

function signalFromScore(s) { return s >= 70 ? 'HIGH' : s >= 45 ? 'MEDIUM' : 'WATCH'; }
function potX(s, h) {
  if (s >= 80 && h < 2) return '20x+';
  if (s >= 72) return '10x+'; if (s >= 62) return '7x+';
  if (s >= 52) return '5x+'; if (s >= 42) return '3x+'; return '2x';
}

// ── FORMAT HELPERS ────────────────────────────────────────
function fUSD(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fP(p) {
  if (!p) return '—';
  const n = parseFloat(p);
  if (n >= 1) return '$' + n.toFixed(4);
  if (n >= 0.01) return '$' + n.toFixed(6);
  if (n >= 0.0001) return '$' + n.toFixed(8);
  return '$' + n.toExponential(3);
}
function fAge(h) {
  if (h == null) return '?';
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 24) return h.toFixed(1) + 'h';
  return Math.floor(h / 24) + 'd';
}
function sAddr(a) { return a ? a.slice(0, 4) + '...' + a.slice(-4) : '—'; }
function esc(t) { return (t || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

// ── DEXSCREENER FETCH ─────────────────────────────────────
async function fetchSolanaPairs() {
  try {
    const res = await fetch(`${DEXSCREENER}/search?q=solana`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const now  = Date.now();
    return (data?.pairs || [])
      .filter(p => p.chainId === 'solana')
      .map(p => {
        const ageH  = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3600000 : null;
        const score = scorePair(p, ageH ?? 999);
        return { ...p, _ageH: ageH, _score: score, _sig: signalFromScore(score),
                 _nars: detectNarratives((p.baseToken?.name || '') + ' ' + (p.baseToken?.symbol || '')),
                 _pot: potX(score, ageH ?? 999) };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 60);
  } catch (e) {
    console.error('[DexScreener]', e.message);
    return [];
  }
}

// ── BUILD SIGNAL MESSAGE ──────────────────────────────────
function buildSignalMsg(c) {
  const ch  = c.priceChange?.h24;
  const chS = ch != null ? (ch > 0 ? '+' : '') + ch.toFixed(1) + '%' : '—';
  const nars = c._nars.length ? c._nars.join(', ') : 'Solana';
  return [
    `🚨 *SOLSCAN ALPHA — ${esc(c._sig)} SIGNAL*`, ``,
    `🪙 *${esc(c.baseToken?.name)}* \\(${esc(c.baseToken?.symbol)}\\)`,
    `📊 Score: *${c._score}/100* · Signal: *${esc(c._sig)}*`,
    `💰 Price: ${esc(fP(c.priceUsd))}`,
    `📈 24H Change: ${esc(chS)}`,
    `💧 Liquidity: ${esc(fUSD(c.liquidity?.usd))}`,
    `📦 Volume 24H: ${esc(fUSD(c.volume?.h24))}`,
    `🎯 Potential: *${esc(c._pot)}*`,
    `🏷 Narratives: ${esc(nars)}`,
    `⏱ Age: ${esc(fAge(c._ageH))}`, ``,
    `📍 *Contract Address:*`,
    `\`${c.baseToken?.address || '?'}\``, ``,
    `🔗 [DexScreener](https://dexscreener.com/solana/${c.pairAddress})`,
    ``, `⚠️ _DYOR\\. Not financial advice\\._`,
  ].join('\n');
}

function buildWhaleMsg(w) {
  return [
    `🐋 *WHALE ALERT*`, ``,
    `${w.action === 'BUY' ? '🟢' : '🔴'} *${esc(w.action)}* — ${esc(w.coin)}`,
    `💵 Size: *${esc(w.usd)}*`,
    `🏦 Wallet: \`${esc(w.address)}\``,
    `📦 Tokens: ${esc(w.amount)}`, ``,
    `⚠️ _DYOR\\. Not financial advice\\._`,
  ].join('\n');
}

// ── SEND MESSAGE ──────────────────────────────────────────
async function send(chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    console.error('[Send]', e.message);
  }
}

// ── SIGNAL POLLING ────────────────────────────────────────
// Checks for new HIGH signals every 60 seconds and pushes to all active users
const seenPairs = new Set();
let lastPairs   = [];

async function pollSignals() {
  const pairs = await fetchSolanaPairs();
  lastPairs   = pairs;

  for (const [chatId, user] of Object.entries(users)) {
    if (user.paused) continue;

    for (const pair of pairs) {
      const id  = pair.pairAddress;
      const key = `${chatId}:${id}`;
      if (seenPairs.has(key)) continue;

      // Filter check
      const pass =
        (user.filter === 'HIGH'   && pair._sig === 'HIGH') ||
        (user.filter === 'MEDIUM' && ['HIGH','MEDIUM'].includes(pair._sig)) ||
        (user.filter === 'ALL');

      if (!pass || pair._score < user.threshold) continue;

      // New coin alert (< 1H)
      if (user.alerts.newCoins && pair._ageH != null && pair._ageH < 1) {
        seenPairs.add(key);
        await send(chatId, buildSignalMsg(pair));
      }

      // Narrative tracking alert
      if (user.trackedNarratives.length) {
        const match = pair._nars.some(n => user.trackedNarratives.includes(n));
        if (match && pair._sig === 'HIGH') {
          seenPairs.add(key);
          await send(chatId, buildSignalMsg(pair));
        }
      }

      // Price alerts
      for (const pa of user.priceAlerts) {
        if (pa.address === pair.baseToken?.address) {
          const price = parseFloat(pair.priceUsd || 0);
          if (price >= pa.target) {
            await send(chatId,
              `🎯 *PRICE ALERT*\n\n${esc(pa.symbol)} has reached *${esc(fP(pair.priceUsd))}*\\!\n\nTarget: ${esc(fP(pa.target.toString()))}\n\n\`${pa.address}\``
            );
            user.priceAlerts = user.priceAlerts.filter(x => x !== pa);
          }
        }
      }
    }
  }
}

// Poll every 60 seconds
setInterval(pollSignals, 60000);

// ══════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ══════════════════════════════════════════════════════════

// /start
bot.onText(/\/start/, async (msg) => {
  const user = getUser(msg.chat.id);
  await send(msg.chat.id,
    `🟢 *SOLSCAN ALPHA BOT — LIVE*\n\n` +
    `Welcome\\! I'm your personal Solana signal bot\\.\n\n` +
    `*Current settings:*\n` +
    `• Filter: ${esc(user.filter)}\n` +
    `• Threshold: ${user.threshold}/100\n` +
    `• New coin alerts: ${user.alerts.newCoins ? '✅' : '❌'}\n` +
    `• Whale alerts: ${user.whaleAlertsOn ? '✅' : '❌'}\n\n` +
    `Send /help to see all commands\\.\n\n` +
    `⚠️ _Not financial advice\\. DYOR always\\._`
  );
});

// /status
bot.onText(/\/status/, async (msg) => {
  const user = getUser(msg.chat.id);
  let dexStatus = '❌';
  try {
    const r = await fetch(`${DEXSCREENER}/search?q=sol`);
    if (r.ok) dexStatus = '✅';
  } catch(e) {}
  await send(msg.chat.id,
    `📡 *BOT STATUS*\n\n` +
    `DexScreener: ${dexStatus} Live\n` +
    `Signals: ${user.paused ? '⏸ Paused' : '✅ Active'}\n` +
    `Pairs tracked: ${lastPairs.length}\n` +
    `Filter: ${esc(user.filter)}\n` +
    `Threshold: ${user.threshold}/100\n` +
    `Uptime: ${esc(process.uptime().toFixed(0))}s`
  );
});

// /settings
bot.onText(/\/settings/, async (msg) => {
  const u = getUser(msg.chat.id);
  await send(msg.chat.id,
    `⚙️ *YOUR SETTINGS*\n\n` +
    `Filter: *${esc(u.filter)}*\n` +
    `Min score: *${u.threshold}/100*\n` +
    `Min whale size: *${esc(fUSD(u.minWhale))}*\n` +
    `Signals paused: *${u.paused ? 'Yes' : 'No'}*\n\n` +
    `*Alerts:*\n` +
    `• New coins: ${u.alerts.newCoins ? '✅' : '❌'}\n` +
    `• Whale buys: ${u.whaleBuysOn ? '✅' : '❌'}\n` +
    `• Whale sells: ${u.whaleSellsOn ? '✅' : '❌'}\n` +
    `• Narrative: ${u.alerts.narrative ? '✅' : '❌'}\n` +
    `• Volume spikes: ${u.alerts.volume ? '✅' : '❌'}\n\n` +
    `*Tracked narratives:* ${u.trackedNarratives.length ? esc(u.trackedNarratives.join(', ')) : 'None'}\n` +
    `*Watchlist:* ${u.watchlist.length} tokens`
  );
});

// /filter
bot.onText(/\/filter (.+)/, async (msg, match) => {
  const user = getUser(msg.chat.id);
  const val  = match[1].trim().toUpperCase();
  if (!['HIGH','MEDIUM','ALL'].includes(val)) {
    return send(msg.chat.id, `⚠️ Invalid option\\. Use: /filter HIGH, /filter MEDIUM, or /filter ALL`);
  }
  user.filter = val;
  await send(msg.chat.id, `✅ Filter set to *${esc(val)}*\n\n${val === 'HIGH' ? '🔥 Only 5x\\+ potential coins' : val === 'MEDIUM' ? '⚡ 3x\\+ potential coins' : '📡 All tracked coins'}`);
});

// /threshold
bot.onText(/\/threshold (\d+)/, async (msg, match) => {
  const user = getUser(msg.chat.id);
  const val  = parseInt(match[1]);
  if (val < 0 || val > 100) return send(msg.chat.id, `⚠️ Enter a number between 0 and 100`);
  user.threshold = val;
  await send(msg.chat.id, `✅ Minimum score set to *${val}/100*\n\nCoins scoring below ${val} will be ignored\\.`);
});

// /signals
bot.onText(/\/signals/, async (msg) => {
  const pairs = lastPairs.slice(0, 10);
  if (!pairs.length) return send(msg.chat.id, `📡 No signals yet\\. Data refreshes every 60 seconds\\.`);
  const lines = pairs.map((p, i) =>
    `${i + 1}\\. *${esc(p.baseToken?.symbol)}* — ${esc(p._sig)} \\(${p._score}/100\\) ${esc(fAge(p._ageH))} old`
  ).join('\n');
  await send(msg.chat.id, `📊 *LAST SIGNALS*\n\n${lines}\n\nSend /top for full details\\.`);
});

// /top
bot.onText(/\/top/, async (msg) => {
  const pairs = lastPairs.filter(p => p._sig === 'HIGH').slice(0, 5);
  if (!pairs.length) return send(msg.chat.id, `🔍 No HIGH signals right now\\. Try again in 60s\\.`);
  await send(msg.chat.id, `🔥 *TOP 5 HIGH SIGNALS*\n\n_Fetching live data\\.\\.\\._`);
  for (const p of pairs) {
    await send(msg.chat.id, buildSignalMsg(p));
    await new Promise(r => setTimeout(r, 500));
  }
});

// /trending
bot.onText(/\/trending/, async (msg) => {
  const pairs = [...lastPairs].sort((a, b) => (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0)).slice(0, 5);
  if (!pairs.length) return send(msg.chat.id, `🔍 No data yet\\. Try again shortly\\.`);
  const lines = pairs.map((p, i) => {
    const ch = p.priceChange?.h24;
    return `${i + 1}\\. *${esc(p.baseToken?.symbol)}* — ${ch != null ? (ch > 0 ? '+' : '') + ch.toFixed(1) + '%' : '—'} · Age: ${esc(fAge(p._ageH))}`;
  }).join('\n');
  await send(msg.chat.id, `📈 *TOP TRENDING 24H*\n\n${lines}`);
});

// /new
bot.onText(/\/new/, async (msg) => {
  const pairs = [...lastPairs].filter(p => p._ageH != null && p._ageH < 6)
    .sort((a, b) => (a._ageH || 0) - (b._ageH || 0)).slice(0, 5);
  if (!pairs.length) return send(msg.chat.id, `🔍 No new coins under 6H found right now\\.`);
  for (const p of pairs) {
    await send(msg.chat.id, buildSignalMsg(p));
    await new Promise(r => setTimeout(r, 500));
  }
});

// /newcoins
bot.onText(/\/newcoins (on|off)/i, async (msg, match) => {
  const user = getUser(msg.chat.id);
  user.alerts.newCoins = match[1].toLowerCase() === 'on';
  await send(msg.chat.id, `✅ New coin launch alerts: *${user.alerts.newCoins ? 'ON' : 'OFF'}*`);
});

// /pause
bot.onText(/\/pause/, async (msg) => {
  getUser(msg.chat.id).paused = true;
  await send(msg.chat.id, `⏸ *Signals paused*\n\nSend /resume to re\\-enable\\.`);
});

// /resume
bot.onText(/\/resume/, async (msg) => {
  getUser(msg.chat.id).paused = false;
  await send(msg.chat.id, `▶️ *Signals resumed*\n\nYou'll receive alerts again now\\.`);
});

// /stop
bot.onText(/\/stop/, async (msg) => {
  delete users[msg.chat.id];
  await send(msg.chat.id, `🔴 *Bot disconnected*\n\nAll settings cleared\\. Send /start to reconnect\\.`);
});

// /whales
bot.onText(/\/whales/, async (msg) => {
  await send(msg.chat.id,
    `🐋 *WHALE TRACKER*\n\nAdd your Helius API key to enable real\\-time on\\-chain whale detection\\.\n\nGet a free key at: helius\\.dev`
  );
});

// /whalealert
bot.onText(/\/whalealert (on|off)/i, async (msg, match) => {
  const user = getUser(msg.chat.id);
  user.whaleAlertsOn = match[1].toLowerCase() === 'on';
  user.alerts.whales = user.whaleAlertsOn;
  await send(msg.chat.id, `✅ Whale alerts: *${user.whaleAlertsOn ? 'ON' : 'OFF'}*`);
});

// /whalebuys
bot.onText(/\/whalebuys (on|off)/i, async (msg, match) => {
  const user = getUser(msg.chat.id);
  user.whaleBuysOn = match[1].toLowerCase() === 'on';
  await send(msg.chat.id, `✅ Whale BUY alerts: *${user.whaleBuysOn ? 'ON' : 'OFF'}*`);
});

// /whalesells
bot.onText(/\/whalesells (on|off)/i, async (msg, match) => {
  const user = getUser(msg.chat.id);
  user.whaleSellsOn = match[1].toLowerCase() === 'on';
  await send(msg.chat.id, `✅ Whale SELL alerts: *${user.whaleSellsOn ? 'ON' : 'OFF'}*`);
});

// /minwhale
bot.onText(/\/minwhale (\d+)/, async (msg, match) => {
  const user = getUser(msg.chat.id);
  user.minWhale = parseInt(match[1]);
  await send(msg.chat.id, `✅ Minimum whale size set to *${esc(fUSD(user.minWhale))}*`);
});

// /narratives
bot.onText(/\/narratives/, async (msg) => {
  const counts = {};
  lastPairs.forEach(p => p._nars.forEach(n => { counts[n] = (counts[n] || 0) + 1; }));
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return send(msg.chat.id, `📡 Loading narrative data\\. Try again in 60s\\.`);
  const lines = sorted.map(([n, c]) => `• *${esc(n)}* — ${c} active pairs`).join('\n');
  await send(msg.chat.id, `🧠 *ACTIVE NARRATIVES*\n\n${lines}`);
});

// /narrative [name]
bot.onText(/\/narrative (.+)/, async (msg, match) => {
  const name  = match[1].trim();
  const key   = Object.keys(NARRATIVES).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) return send(msg.chat.id, `⚠️ Unknown narrative\\. Options: ${esc(Object.keys(NARRATIVES).join(', '))}`);
  const pairs = lastPairs.filter(p => p._nars.includes(key)).slice(0, 5);
  if (!pairs.length) return send(msg.chat.id, `🔍 No coins found for *${esc(key)}* right now\\.`);
  for (const p of pairs) {
    await send(msg.chat.id, buildSignalMsg(p));
    await new Promise(r => setTimeout(r, 500));
  }
});

// /tracknarrative
bot.onText(/\/tracknarrative (.+)/, async (msg, match) => {
  const user = getUser(msg.chat.id);
  const name = match[1].trim();
  const key  = Object.keys(NARRATIVES).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) return send(msg.chat.id, `⚠️ Unknown narrative\\. Options: ${esc(Object.keys(NARRATIVES).join(', '))}`);
  if (!user.trackedNarratives.includes(key)) user.trackedNarratives.push(key);
  await send(msg.chat.id, `✅ Now tracking *${esc(key)}* narrative\\. You'll get HIGH signal alerts for new ${esc(key)} coins\\.`);
});

// /untracknarrative
bot.onText(/\/untracknarrative (.+)/, async (msg, match) => {
  const user = getUser(msg.chat.id);
  const name = match[1].trim();
  user.trackedNarratives = user.trackedNarratives.filter(n => n.toLowerCase() !== name.toLowerCase());
  await send(msg.chat.id, `✅ Removed *${esc(name)}* from tracked narratives\\.`);
});

// /watchlist
bot.onText(/\/watchlist/, async (msg) => {
  const user = getUser(msg.chat.id);
  if (!user.watchlist.length) return send(msg.chat.id, `📋 Your watchlist is empty\\.\n\nAdd tokens with /watch \\[contract address\\]`);
  const lines = user.watchlist.map((t, i) =>
    `${i + 1}\\. *${esc(t.symbol || 'Unknown')}* — \`${esc(t.address)}\``
  ).join('\n');
  await send(msg.chat.id, `👁 *YOUR WATCHLIST*\n\n${lines}\n\nUse /price \\[address\\] for live stats\\.`);
});

// /watch
bot.onText(/\/watch (.+)/, async (msg, match) => {
  const user    = getUser(msg.chat.id);
  const address = match[1].trim();
  if (address.length < 32) return send(msg.chat.id, `⚠️ That doesn't look like a valid Solana contract address\\.`);
  const existing = user.watchlist.find(t => t.address === address);
  if (existing) return send(msg.chat.id, `ℹ️ Already on your watchlist\\.`);
  // Try to find token name from current data
  const found = lastPairs.find(p => p.baseToken?.address === address);
  const symbol = found?.baseToken?.symbol || sAddr(address);
  user.watchlist.push({ address, symbol });
  await send(msg.chat.id, `✅ Added *${esc(symbol)}* to your watchlist\\.\n\n\`${esc(address)}\``);
});

// /unwatch
bot.onText(/\/unwatch (.+)/, async (msg, match) => {
  const user    = getUser(msg.chat.id);
  const address = match[1].trim();
  const before  = user.watchlist.length;
  user.watchlist = user.watchlist.filter(t => t.address !== address);
  if (user.watchlist.length === before) return send(msg.chat.id, `⚠️ Token not found in your watchlist\\.`);
  await send(msg.chat.id, `✅ Removed from watchlist\\.`);
});

// /price
bot.onText(/\/price (.+)/, async (msg, match) => {
  const address = match[1].trim();
  const found   = lastPairs.find(p => p.baseToken?.address === address);
  if (!found) {
    // Try fetching directly
    try {
      const res  = await fetch(`${DEXSCREENER}/tokens/${address}`);
      const data = await res.json();
      const pair = data?.pairs?.[0];
      if (pair) {
        const ch = pair.priceChange?.h24;
        return send(msg.chat.id,
          `💰 *${esc(pair.baseToken?.name)}* \\(${esc(pair.baseToken?.symbol)}\\)\n\n` +
          `Price: ${esc(fP(pair.priceUsd))}\n` +
          `24H: ${ch != null ? (ch > 0 ? '+' : '') + ch.toFixed(1) + '%' : '—'}\n` +
          `Liquidity: ${esc(fUSD(pair.liquidity?.usd))}\n` +
          `Volume: ${esc(fUSD(pair.volume?.h24))}\n\n` +
          `\`${esc(address)}\``
        );
      }
    } catch (e) {}
    return send(msg.chat.id, `⚠️ Token not found\\. Make sure the contract address is correct\\.`);
  }
  const ch = found.priceChange?.h24;
  await send(msg.chat.id,
    `💰 *${esc(found.baseToken?.name)}* \\(${esc(found.baseToken?.symbol)}\\)\n\n` +
    `Price: ${esc(fP(found.priceUsd))}\n` +
    `24H Change: ${ch != null ? (ch > 0 ? '+' : '') + ch.toFixed(1) + '%' : '—'}\n` +
    `Market Cap: ${esc(fUSD(found.fdv))}\n` +
    `Liquidity: ${esc(fUSD(found.liquidity?.usd))}\n` +
    `Volume 24H: ${esc(fUSD(found.volume?.h24))}\n` +
    `Age: ${esc(fAge(found._ageH))}\n` +
    `Signal: ${esc(found._sig)} \\(${found._score}/100\\)\n` +
    `Potential: ${esc(found._pot)}\n\n` +
    `\`${esc(address)}\`\n\n` +
    `[DexScreener](https://dexscreener.com/solana/${found.pairAddress})`
  );
});

// /alert
bot.onText(/\/alert (\S+) (.+)/, async (msg, match) => {
  const user    = getUser(msg.chat.id);
  const address = match[1].trim();
  const target  = parseFloat(match[2].trim());
  if (isNaN(target)) return send(msg.chat.id, `⚠️ Invalid price\\. Example: /alert 7xKp\\.\\.\\.3qR2 0\\.0005`);
  const found = lastPairs.find(p => p.baseToken?.address === address);
  const symbol = found?.baseToken?.symbol || sAddr(address);
  user.priceAlerts.push({ address, target, symbol });
  await send(msg.chat.id, `🎯 Price alert set for *${esc(symbol)}* at *${esc(fP(target.toString()))}*\n\nI'll notify you once when the price is reached\\.`);
});

// /help
bot.onText(/\/help/, async (msg) => {
  await send(msg.chat.id,
    `📖 *SOLSCAN ALPHA — COMMANDS*\n\n` +
    `*Core*\n` +
    `/start — Welcome & settings\n` +
    `/status — Feed connection status\n` +
    `/settings — View all config\n` +
    `/pause — Mute all signals\n` +
    `/resume — Restore signals\n` +
    `/stop — Disconnect bot\n\n` +
    `*Signals*\n` +
    `/filter HIGH|MEDIUM|ALL\n` +
    `/threshold 0\\-100\n` +
    `/signals — Last 10 signals\n` +
    `/top — Top 5 HIGH now\n` +
    `/trending — Top 5 by 24H change\n` +
    `/new — Newest launches\n` +
    `/newcoins on|off\n\n` +
    `*Whales*\n` +
    `/whales — Last whale txns\n` +
    `/whalealert on|off\n` +
    `/minwhale \\[amount\\]\n` +
    `/whalebuys on|off\n` +
    `/whalesells on|off\n\n` +
    `*Watchlist*\n` +
    `/watchlist — View saved tokens\n` +
    `/watch \\[address\\]\n` +
    `/unwatch \\[address\\]\n` +
    `/price \\[address\\]\n` +
    `/alert \\[address\\] \\[price\\]\n\n` +
    `*Narratives*\n` +
    `/narratives — Active categories\n` +
    `/narrative \\[name\\]\n` +
    `/tracknarrative \\[name\\]\n` +
    `/untracknarrative \\[name\\]\n\n` +
    `⚠️ _Not financial advice\\. DYOR always\\._`
  );
});

// ── EXPRESS HEALTH CHECK ──────────────────────────────────
// Required by Render/Fly to keep the server alive
app.get('/', (req, res) => res.json({ status: 'ok', bot: 'SOLSCAN ALPHA', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`✅  SOLSCAN ALPHA bot running on port ${PORT}`));

// Initial poll on startup
setTimeout(pollSignals, 3000);
console.log('🚀  Bot started — polling DexScreener every 60s');
