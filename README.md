# Sovereign Skill Hub — AI Futures Trader

Modular AI-driven futures trading system built on Jared Wesley's "Trading With An Edge" methodology. Scans 25 futures symbols across 6 timeframes, routes high-confluence signals through Supabase and CrossTrade webhook to NinjaTrader sim execution.

## Features

- **8 Pattern Detectors**: 3-Bar Play, 4-Bar Play, Buy/Sell Setup, Retest (W-Bottom/W-Top/Double Bottom/Double Top), Pivot Breakout, Climax Reversal, Cup & Handle, Wedge Breakout
- **Advanced Confluence Scoring** (0–11pt): Volume surge, igniting vol, candlestick tails, strong body, MA respect, HTF alignment, Level 1/2/3 gaps, W-patterns, double bottom/top
- **Volume Types**: IGNITING, ENDING, RESTING, NORMAL — classified per bar
- **Live Scanner**: 5-min/15-min ES/NQ with ≥8pt high-confluence filter
- **Historical Backtester**: Full pattern testing with adjustable date ranges, R:R ratios, max hold bars, sideways filter, parabolic filter, MTF alignment
- **Supabase Trade Journal**: Auto-logged trades with P&L breakdown, advanced analytics by pattern/symbol/timeframe/confluence
- **Edge Builder Dashboard**: Grouped stats, optimization recommendations, pattern library
- **NinjaTrader Sim Execution**: Via CrossTrade webhook — paper/sim only
- **Safety Guardrails**: 1% max risk per trade, 3% daily loss limit, SIM-only enforcement, ≥8pt confluence gate

## Architecture

```
Replit (Node.js/Express)
├── server/trader.ts        — Live scanner, pattern detection, trade management
├── server/backtest.ts      — Historical backtester with 8 pattern detectors
├── server/supabase.ts      — Signal queue (trade_signals table, status=NEW)
├── server/services/crosstrade.ts — Webhook to NinjaTrader via CrossTrade
├── server/journal.ts       — Trade journal persistence + analytics
├── server/routes.ts        — REST API endpoints
├── public/index.html       — Single-file frontend (tabs: Trader, Backtest, Journal, Edge Builder)
└── data/
    ├── trader_settings.json — Pattern toggles, risk config
    └── trade_journal.json   — Persisted trade history
```

## Signal Flow

```
Scanner detects pattern (≥8pt confluence)
  → emitTradeSignal()
    → enqueueSignal() → Supabase trade_signals (status=NEW)
    → sendToCrossTrade() → NinjaTrader sim order
  → Frontend polls /api/trade-ack/:signalId → shows accepted/rejected/pending
```

## Setup

### 1. Clone Repository

```bash
git clone https://github.com/nearmiss1193-afk/traderskillsagents.git
cd traderskillsagents
```

### 2. Replit Backend

Import the project into Replit, then add these secrets in the Secrets tab:

| Secret | Description |
|--------|-------------|
| `POLYGON_API_KEY` | Polygon.io API key for market data |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `CROSSTRADE_WEBHOOK_URL` | CrossTrade webhook endpoint |
| `CROSSTRADE_KEY` | CrossTrade API key |
| `SESSION_SECRET` | Random string for session security |

Click **Run** or use the workflow to start:

```bash
npm run dev
```

### 3. Supabase Tables

Create these tables in your Supabase project:

```sql
CREATE TABLE trade_signals (
  id BIGSERIAL PRIMARY KEY,
  signal_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'NEW',
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  qty INTEGER DEFAULT 1,
  order_type TEXT DEFAULT 'MARKET',
  entry_price NUMERIC,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  pattern TEXT,
  confluence INTEGER,
  risk_reward NUMERIC,
  account_hint TEXT,
  source TEXT DEFAULT 'replit',
  client_tag TEXT DEFAULT 'v1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trade_acks (
  id BIGSERIAL PRIMARY KEY,
  signal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4. NinjaTrader 8

1. Enable **Tools → Options → AT Interface (ATI)**
2. Load a sim account (e.g., `Sim101`)
3. Install and configure the **CrossTrade add-on**
4. Point the CrossTrade add-on to your webhook URL
5. Verify connection: send a test signal from the Replit UI

### 5. Python Bridge (Optional)

If using the local bridge instead of CrossTrade:

```bash
cd local-bridge
pip install supabase
python bridge.py
```

The bridge polls Supabase `trade_signals` for NEW entries and forwards them to NinjaTrader via TCP.

## Testing

1. Open the Replit app in your browser
2. Go to the **AI Futures Trader** tab
3. Click **Test Signal** — this sends a test order through the full pipeline
4. Watch:
   - Replit console logs: `[trader] Signal queued to Supabase`
   - Supabase `trade_signals` table: new row with `status=NEW`
   - NinjaTrader: sim order placement (if CrossTrade connected)
   - Frontend: ACK polling shows accepted/rejected/pending

## Backtesting

1. Go to the **Backtester** section
2. Select symbol (ES, NQ, GC, CL, SI, etc.)
3. Choose pattern (`all`, `3bar`, `4bar`, `buysetup`, `retest`, `breakout`, `climax`, `cuphandle`, `wedge`)
4. Set date range (YYYY-MM-DD), R:R ratio, max hold bars
5. Results show individual trades with confluence scores, volume types, and P&L

## Safety

- **Paper/sim mode only** — non-SIM accounts are blocked unless `ALLOW_LIVE_TRADES=true` is set
- **1% max risk per trade** — rejects signals where risk exceeds 1% of $50,000 account size
- **3% daily loss limit** — stops all scanning if realized P&L drops below -3% for the day
- **≥8pt confluence gate** — only high-conviction signals pass the live scanner checklist
- **MAX_CONTRACTS=1** — CrossTrade limits order size to 1 contract (configurable via env var)

No live trading until you fully understand the risks. This system is designed for simulation and education.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/trader/start` | Start live scanner session |
| POST | `/api/trader/stop` | Stop scanner session |
| GET | `/api/trader/logs/:id` | Get session logs |
| GET | `/api/trader/status` | Trading hours + force mode status |
| GET | `/api/trader/safety` | Daily P&L, risk limits, confluence min |
| POST | `/api/signal/test` | Send test signal through pipeline |
| GET | `/api/trade-ack/:signalId` | Poll for signal ACK status |
| POST | `/api/backtest/pattern` | Run historical backtest |
| GET | `/api/journal` | Load trade journal |
| GET | `/api/journal/stats` | Journal summary statistics |
| GET | `/api/journal/analytics` | Advanced analytics (grouped) |
| GET | `/api/settings` | Load trader settings |
| POST | `/api/settings` | Save trader settings |

## Version

**v1.0-beta** — March 2026

Full pattern detection, historical backtesting, sim execution, trade journal, Edge Builder analytics, safety guardrails.
