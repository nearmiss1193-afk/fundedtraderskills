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
  - **Real Price Data**: Polygon.io API (SPY x 7.8 as ES proxy, free tier compatible)
  - **Force Trading Mode**: Checkbox to ignore 9:30-4PM EST time window
  - **Moving Averages**: 9 EMA + 21 EMA + 200 SMA for trend confirmation and entry filtering
  - **5 Core Patterns**: 3 Bar Play (3 consecutive + reversal + volume), Buy/Sell Setup (10-factor confluence), Pivot Breakout (prior pivot levels), Climax Reversal (7+ bars extended + ending volume), MA Bounce (9/21 EMA touch + reversal)
  - **Confluence Scoring**: Multi-factor scoring with descriptive labels (A+ Setup, High Probability, Moderate, etc.)
  - **Volume Classification**: Igniting (starts move), Ending (exhaustion), Resting (consolidation) per manual
  - **Trailing Stops**: Activates after 1R move, trails at 0.6R from high/low, breakeven management
  - **Trend Detection**: HPH/HPL counting for uptrend, LPH/LPL for downtrend, with pivot decay
  - **Fear/Greed Dynamics**: Sentiment-biased price movement (BUYERS_CONTROL amplifies upward, SELLERS_CONTROL amplifies downward)
  - **Trade Management**: Entry from recent swing, SL/TP/Trail shown in log, TRAILED OUT vs STOPPED OUT
  - **Log Fields**: trail, confluenceLabel, volumeType, dataSource badges, color-coded actions

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
