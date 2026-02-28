# Sovereign Skill Hub

Minimal Node.js + Express starter for a skill marketplace with autonomous AI skills.

## Endpoints

- `GET /health` - Returns "OK"
- `POST /api/create-skill` - Create a skill `{ name, description }` (in-memory)
- `GET /api/skills` - List all skills
- `POST /api/florida-permit-checker` - Check FL permit requirements `{ renovationType, propertyType, county, details }`
- `GET /api/trader/status` - Check trading window + force mode `{ tradingOpen, forceActive }`
- `POST /api/trader/start` - Start autonomous trader `{ markets, timeframes, riskPct, patterns, customCondition, forceTrading }`
- `POST /api/trader/stop` - Stop trader `{ sessionId }`
- `GET /api/trader/logs/:sessionId` - Poll trade logs (optional `?after=id`)
- `GET /api/journal` - Get journal entries + stats
- `DELETE /api/journal` - Clear all journal entries
- `GET /api/journal/csv` - Download journal as CSV
- `PATCH /api/journal/:id/notes` - Update trade notes
- `GET /api/journal/analytics` - Advanced analytics (grouped by pattern/symbol/timeframe/confluence + recommendations)
- `GET /api/settings` - Load trader settings
- `POST /api/settings` - Save trader settings
- `POST /api/trade-signal` - Trade signal endpoint `{ symbol, direction, entryPrice, stopLoss, takeProfit, riskReward, confluence, pattern, qty }` — awaits Supabase insert, returns `signalId` for ACK polling
- `GET /api/trade-signals` - List recent trade signals from memory (up to 200)
- `GET /api/trade-ack/:signalId` - Poll Supabase `trade_acks` table for ACK on a signal (accepted/rejected/pending)
- `POST /api/backtest/pattern` - Run historical backtest `{ symbol, pattern, from, to, rrRatio, maxHold }` — returns full metrics + trade list
- **Signal Queue (Supabase)**: All signals inserted directly into Supabase `trade_signals` table (no HTTP bridge). Each signal gets a unique `signalId`. Local bridge polls Supabase for NEW signals, forwards to NinjaTrader, writes ACK back to `trade_acks`.
- **Test Signal Button**: UI button sends MES Long qty=1 test signal, queues to Supabase, then polls `/api/trade-ack/:signalId` for ACK status (accepted/rejected/pending)
- `GET /api/tradovate/status` - Tradovate connection status
- `POST /api/tradovate/connect` - Attempt Tradovate connection
- `POST /api/crosstrade/test` - Send order to CrossTrade `{ symbol, direction, account }` — forwards to NinjaTrader via CrossTrade webhook

## Structure

```
public/index.html   - Static frontend (4 tabs: Create Skill, Permit Checker, AI Futures Trader, Edge Builder)
server/routes.ts    - API endpoints
server/trader.ts    - AI Futures Trader engine (async loop, Polygon.io data, pattern detection, trailing stops)
server/supabase.ts  - Supabase client, enqueueSignal(), getTradeAck()
server/backtest.ts  - Historical backtesting engine (Polygon data, pattern detection, trade simulation, metrics)
server/journal.ts   - Trade journal + settings persistence + advanced analytics
server/tradovate.ts - Tradovate API integration (auth, bracket orders, position mgmt)
server/services/crosstrade.ts - CrossTrade webhook integration (sends orders to NinjaTrader via CrossTrade)
server/storage.ts   - Stub (in-memory storage in routes.ts)
shared/schema.ts    - Stub
data/               - Persistent JSON files (trade_journal.json, trader_settings.json)
```

## Key Features

- **Create a Skill** - Simple skill CRUD (in-memory)
- **Florida Permit Checker** - County-specific permit logic for Polk/Orange/Hillsborough/Pasco
- **AI Futures Trader** - Based on Jared Wesley's "Trading With An Edge" (Live Traders):
  - **25 Futures Symbols**: ES, MES, NQ, MNQ, YM, MYM, RTY, M2K, CL, MCL, GC, MGC, SI, HG, PL, PA, BTC, ETH, ZB, ZN, ZT, ZF, ZC, ZS, ZW
  - **6 Timeframes**: 2min, 5min, 15min, 1hr, 4hr, Daily
  - **Futures Session Hours**: Sunday 6PM – Friday 5PM EST with daily 5-6PM maintenance break
  - **Per-Symbol Specs**: Base price, point value, tick size, volatility profile, avg volume (FUTURES_SPECS map)
  - **Real Price Data**: Polygon.io API (SPY x 7.8 as ES/MES proxy, free tier prev-day aggregates); all other symbols use SIM
  - **Configurable Risk:Reward**: Dropdown (1:1 through 1:5, default 1:2); TP = risk × R:R ratio; shown in stats panel
  - **Force Trading Mode**: Checkbox to override time window during development
  - **Moving Averages**: 9 EMA + 21 EMA + 200 SMA for trend confirmation and entry filtering
  - **4 Core Patterns** (manual-approved only): 3 Bar Play (10-factor), Buy/Sell Setup (12-factor), Pivot Breakout (10-factor), Climax/Exhaustion Reversal (9-factor)
  - **Granular Pattern Control**: 8 individual toggles for each pattern direction (3Bar Long, 3Bar Short, Buy Setup, Sell Setup, Breakout Long, Breakout Short, Climax Long, Climax Short)
  - **Strict Pre-Trade Checklist** (all 6 must pass before signal fires): HTF alignment (EMA9>EMA21 + price vs SMA200), volume >1.5× avg, MA confluence (near 9 or 21 EMA), R:R ≥ 1:2, no choppy market (bar ranges not all <50% avg), confluence ≥ 4
  - **Timeframe Control**: 6 individually toggleable timeframes (2min, 5min, 15min, 1hr, 4hr, Daily) persisted in settings
  - **Short Selling**: All patterns support both LONG and SHORT entries
  - **Full Manual Integration** (Trading With An Edge):
    - 3 Chart Keys: How bar formed (barFormationQuality), where it formed (pivot proximity), how it got here (howDidItGetHere)
    - 6 Reversal Signs from p.37: bars down, wide range bars, pivot support, volume, green bar, bottoming tail
    - Multiple concepts converging = higher odds (confluence scoring)
    - Prior pivots: "where buyers stepped up in the past, they'll likely do it again"
    - Climactic moves: extended + ending volume + distance from 21 EMA
    - Consolidation then breakout with igniting volume
  - **Entry Reason Logging**: Every signal shows WHY (e.g. "at pivot support + increased volume + green bar + bottoming tail + at 21 EMA")
  - **Confluence Scoring**: Up to 12 factors per pattern with descriptive labels (A+ Setup, High Probability, Moderate, etc.)
  - **Confluence Checklist**: Each trade records 5 checklist items: Pattern Match, Volume Confirmation, MA Respect, Prior Pivot/SR, Bar Formation
  - **Volume Classification**: Igniting (starts move), Ending (exhaustion), Resting (consolidation) — all relative to avgRange not hardcoded
  - **Bar Analysis**: isWideRangeBar, isNarrowRangeBar, hasMultipleWideRangeBars, barFormationQuality, distanceFromMA, isExtendedFromMA
  - **Trailing Stops**: Activates after 1R move, trails at 0.6R from high/low, breakeven management — all relative to riskPoints
  - **Trend Detection**: HPH/HPL counting for uptrend, LPH/LPL for downtrend, with pivot decay
  - **Fear/Greed Dynamics**: Sentiment-biased price movement (BUYERS_CONTROL amplifies upward, SELLERS_CONTROL amplifies downward)
  - **Trade Management**: Entry from recent swing, SL/TP/Trail shown in log, TRAILED OUT vs STOPPED OUT
  - **Price Scaling**: All thresholds (isNearMA, isNearPivot, hasBottomingTail, classifyVolume) use relative % not hardcoded points
  - **Log Fields**: trail, confluenceLabel, volumeType, reason, dataSource badges, color-coded actions
- **Trade Journal**: Persistent JSON-backed trade history with sortable/filterable spreadsheet UI
  - Every completed trade auto-saved to `data/trade_journal.json`
  - Columns: Timestamp, Symbol, TF, Pattern, Direction, Entry, SL, TP, Exit, P&L, Confluence Checklist (5 dots), Outcome, R:R, Notes
  - Summary stats: Total Trades, Win Rate, Profit Factor, Total P&L, Best Symbol, Best Pattern, Avg R:R
  - Toolbar: Search, filter by symbol/pattern/outcome, CSV export, clear all
  - Sortable columns (click headers), color-coded outcomes (green=WIN, red=LOSS)
  - Editable notes per trade (click to add)
  - Confluence checklist dots with hover tooltip (Pattern, Volume, MA, Pivot/SR, Bar Formation)
  - Settings panel: Risk $, R:R ratio, 8 granular pattern toggles, 6 timeframe toggles — persisted to `data/trader_settings.json`
  - Settings sync to main trader form on save
- **Edge Builder Dashboard** (Tab 4) - Advanced analytics based on Live Traders philosophy:
  - **Overall Metrics**: Total Trades, Win Rate, Profit Factor, Expectancy, Total P&L
  - **Grouped Statistics**: Performance by Pattern, Symbol, Timeframe, and Confluence Level
  - **Setup Heatmap**: Color-coded cells showing top/bottom performing setups (hot=green, warm=yellow, cold=red)
  - **Optimize My Edge**: AI-generated recommendations (e.g. "Increase size on Buy Setup - 59% win rate")
  - **Pattern Library**: 8 cards covering all long + short patterns from the manual with entry/stop/target rules and confluence tips
  - **Filtered Analytics**: Edge Builder stats reflect only currently enabled patterns/timeframes from settings
  - **Historical Backtester**: Test any of the 4 patterns against real Polygon historical data
    - Symbols: ES, NQ, YM, RTY, CL, GC, ZB, ZN (SPY proxy for ES/MES)
    - Configurable date range, R:R ratio (1:1.5 to 1:3), max hold bars (3-10)
    - Metrics: Win Rate, Profit Factor, Expectancy, Total P&L, Max Drawdown, Best/Worst Trade
    - Shows last 50 trades with entry/SL/TP/exit/outcome
    - ATR-based stop loss and take profit calculation
    - Contract stitching for futures continuous data
  - API: GET `/api/journal/analytics?patterns=...&timeframes=...`
  - API: POST `/api/backtest/pattern` `{ symbol, pattern, from, to, rrRatio, maxHold }`

## Symbol Categories (UI)

| Category | Symbols |
|----------|---------|
| Equity Index | ES, MES, NQ, MNQ, YM, MYM, RTY, M2K |
| Energy | CL, MCL |
| Metals | GC, MGC, SI, HG, PL, PA |
| Crypto | BTC, ETH |
| Treasury | ZB, ZN, ZF, ZT |
| Agriculture | ZC, ZS, ZW |

## Log TradeLog Fields

| Field | Description |
|-------|-------------|
| trail | Current trailing stop level (amber) |
| confluenceLabel | e.g. "6/8 - High Probability" |
| volumeType | IGNITING / ENDING / RESTING / NORMAL |
| dataSource | POLYGON (real) / SIM (simulated) |
| sentiment | GREED / FEAR / NEUTRAL |

- **Tradovate Integration** - Paper trading via Tradovate demo API:
  - Auto-connects on startup if credentials are set
  - Places bracket orders (entry + SL + TP) when trader signals entries
  - Status badge shows connection state in UI
  - API: `GET /api/tradovate/status`, `POST /api/tradovate/connect`
  - Falls back gracefully to simulation-only mode when credentials are missing

## Environment

- `POLYGON_API_KEY` - Polygon.io API key for real futures data (falls back to simulated if missing)
- `SUPABASE_URL` - Supabase project URL for trade signal queue
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key for server-side inserts

## Risk Management
- **Risk Per Trade**: Dollar amount (e.g. $100), not percentage. Stop loss is calculated as risk_dollars / point_value from entry.
- **R:R Hard Rule**: Trades exit ONLY at exact stop loss or exact target. No trailing stops. If you risk $100 at 1:2 R:R, you either lose $100 or make $200.
- **Max Open Trades**: Selectable before starting (1-10). New entries are blocked when limit is reached.
- `TRADOVATE_USERNAME` - Tradovate demo account username
- `TRADOVATE_PASSWORD` - Tradovate demo account password
- `TRADOVATE_APP_ID` - Tradovate application ID
- `TRADOVATE_CID` - Tradovate client ID
- `TRADOVATE_SECRET` - Tradovate client secret
- `CROSSTRADE_WEBHOOK_URL` - CrossTrade webhook URL for order forwarding
- `CROSSTRADE_KEY` - CrossTrade API key for authentication
- `CROSSTRADE_ACCOUNT` - Default CrossTrade account name (default: SIM101)
- `MAX_CONTRACTS` - Maximum contracts per CrossTrade order (default: 1)
- `ALLOW_LIVE_TRADES` - Set to "true" to allow non-SIM accounts (safety guard)

## Local Components (run on your PC, not Replit)

- `local-bridge/bridge.py` - Python bridge that polls Supabase `trade_signals` for NEW rows, forwards to NinjaTrader via TCP port 7777, writes ACK to `trade_acks`
- `ninjatrader-addon/SovereignBridgeAddon.cs` - NinjaTrader 8 AddOn that listens on TCP 7777, places SIM orders, returns ACK with orderId
- See `local-bridge/README.md` for setup instructions

## Running

`npm run dev` starts the Express server on port 5000.
