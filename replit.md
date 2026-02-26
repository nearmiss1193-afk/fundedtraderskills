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

## Structure

```
public/index.html   - Static frontend (3 tabs: Create Skill, Permit Checker, AI Futures Trader)
server/routes.ts    - API endpoints
server/trader.ts    - AI Futures Trader engine (async loop, Polygon.io data, pattern detection, trailing stops)
server/storage.ts   - Stub (in-memory storage in routes.ts)
shared/schema.ts    - Stub
```

## Key Features

- **Create a Skill** - Simple skill CRUD (in-memory)
- **Florida Permit Checker** - County-specific permit logic for Polk/Orange/Hillsborough/Pasco
- **AI Futures Trader** - Based on Jared Wesley's "Trading With An Edge" (Live Traders):
  - **25 Futures Symbols**: ES, MES, NQ, MNQ, YM, MYM, RTY, M2K, CL, MCL, GC, MGC, SI, HG, PL, PA, BTC, ETH, ZB, ZN, ZT, ZF, ZC, ZS, ZW
  - **6 Timeframes**: 2min, 5min, 15min, 1hr, 4hr, Daily
  - **Futures Session Hours**: Sunday 6PM – Friday 5PM EST with daily 5-6PM maintenance break
  - **Per-Symbol Specs**: Base price, point value, tick size, volatility profile, avg volume (FUTURES_SPECS map)
  - **Real Price Data**: Polygon.io API (SPY x 7.8 as ES/MES proxy, free tier compatible)
  - **Force Trading Mode**: Checkbox to override time window during development
  - **Moving Averages**: 9 EMA + 21 EMA + 200 SMA for trend confirmation and entry filtering
  - **5 Core Patterns**: 3 Bar Play (10-factor), Buy/Sell Setup (12-factor), Pivot Breakout (10-factor), Climax Reversal (9-factor), MA Bounce (8-factor)
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
  - **Volume Classification**: Igniting (starts move), Ending (exhaustion), Resting (consolidation) — all relative to avgRange not hardcoded
  - **Bar Analysis**: isWideRangeBar, isNarrowRangeBar, hasMultipleWideRangeBars, barFormationQuality, distanceFromMA, isExtendedFromMA
  - **Trailing Stops**: Activates after 1R move, trails at 0.6R from high/low, breakeven management — all relative to riskPoints
  - **Trend Detection**: HPH/HPL counting for uptrend, LPH/LPL for downtrend, with pivot decay
  - **Fear/Greed Dynamics**: Sentiment-biased price movement (BUYERS_CONTROL amplifies upward, SELLERS_CONTROL amplifies downward)
  - **Trade Management**: Entry from recent swing, SL/TP/Trail shown in log, TRAILED OUT vs STOPPED OUT
  - **Price Scaling**: All thresholds (isNearMA, isNearPivot, hasBottomingTail, classifyVolume) use relative % not hardcoded points
  - **Log Fields**: trail, confluenceLabel, volumeType, reason, dataSource badges, color-coded actions

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

## Environment

- `POLYGON_API_KEY` - Polygon.io API key for real futures data (falls back to simulated if missing)

## Running

`npm run dev` starts the Express server on port 5000.
