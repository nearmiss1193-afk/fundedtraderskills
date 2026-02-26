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
- `POST /api/trade-signal` - NinjaTrader API bridge endpoint `{ symbol, direction, entryPrice, stopLoss, takeProfit, riskReward, confluence, pattern }` — auto-POSTed on every trade entry in Force Trading mode
- `GET /api/trade-signals` - List recent trade signals (up to 200)
- **Signal Bridge**: `emitTradeSignal()` in trader.ts POSTs to `http://localhost:5000/api/trade-signal` on every trade entry; logs `[trader] Signal sent to bridge` + `[trader] Bridge confirmed signal received`
- **Test Signal Button**: UI button sends sample ES Long signal to bridge for connectivity testing
- `GET /api/tradovate/status` - Tradovate connection status
- `POST /api/tradovate/connect` - Attempt Tradovate connection

## Structure

```
public/index.html   - Static frontend (4 tabs: Create Skill, Permit Checker, AI Futures Trader, Edge Builder)
server/routes.ts    - API endpoints
server/trader.ts    - AI Futures Trader engine (async loop, Polygon.io data, pattern detection, trailing stops)
server/journal.ts   - Trade journal + settings persistence + advanced analytics
server/tradovate.ts - Tradovate API integration (auth, bracket orders, position mgmt)
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
  - **5 Core Patterns**: 3 Bar Play (10-factor), Buy/Sell Setup (12-factor), Pivot Breakout (10-factor), Climax Reversal (9-factor), MA Bounce (8-factor)
  - **Granular Pattern Control**: 10 individual toggles for each pattern direction (3Bar Long, 3Bar Short, Buy Setup, Sell Setup, Breakout Long, Breakout Short, Climax Long, Climax Short, MA Bounce Long, MA Bounce Short)
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
  - Settings panel: Risk %, R:R ratio, 10 granular pattern toggles, 6 timeframe toggles — persisted to `data/trader_settings.json`
  - Settings sync to main trader form on save
- **Edge Builder Dashboard** (Tab 4) - Advanced analytics based on Live Traders philosophy:
  - **Overall Metrics**: Total Trades, Win Rate, Profit Factor, Expectancy, Total P&L
  - **Grouped Statistics**: Performance by Pattern, Symbol, Timeframe, and Confluence Level
  - **Setup Heatmap**: Color-coded cells showing top/bottom performing setups (hot=green, warm=yellow, cold=red)
  - **Optimize My Edge**: AI-generated recommendations (e.g. "Increase size on Buy Setup - 59% win rate")
  - **Pattern Library**: 10 cards covering all long + short patterns from the manual with entry/stop/target rules and confluence tips
  - **Filtered Analytics**: Edge Builder stats reflect only currently enabled patterns/timeframes from settings
  - API: GET `/api/journal/analytics?patterns=...&timeframes=...`

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
- `TRADOVATE_USERNAME` - Tradovate demo account username
- `TRADOVATE_PASSWORD` - Tradovate demo account password
- `TRADOVATE_APP_ID` - Tradovate application ID
- `TRADOVATE_CID` - Tradovate client ID
- `TRADOVATE_SECRET` - Tradovate client secret

## Running

`npm run dev` starts the Express server on port 5000.
