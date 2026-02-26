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
server/trader.ts    - AI Futures Trader engine (async loop, Polygon.io data, pattern detection)
server/storage.ts   - Stub (in-memory storage in routes.ts)
shared/schema.ts    - Stub
```

## Key Features

- **Create a Skill** - Simple skill CRUD (in-memory)
- **Florida Permit Checker** - County-specific permit logic for Polk/Orange/Hillsborough/Pasco
- **AI Futures Trader** - Based on Jared Wesley's "Trading With An Edge" (Live Traders):
  - **Real Price Data**: Polygon.io API (SPY × 7.8 as ES proxy, free tier compatible)
  - **Force Trading Mode**: Checkbox to ignore 9:30-4PM EST time window
  - 5 patterns: 3 Bar Play, Buy/Sell Setup, Pivot Breakout, Climax Reversal, MA Bounce
  - OHLC bar generation anchored to real prices + noise for pattern variation
  - Both LONG and SHORT directions for all patterns
  - Confluence scoring (multiple concepts converging = higher gate/reward ratio)
  - Fear/Greed sentiment tracking from bar counting & volume analysis
  - Igniting/ending volume, bottoming/topping tails, 7+ bar exhaustion, 21 EMA + 200 SMA
  - SCANNING log entries show live price + data source (POLYGON/SIM badge)
  - Color-coded log: E/SL/TP, bias tag, confluence badge (x/5), sentiment tag, data source
  - Win/loss stats, cumulative P&L ($50/pt ES, $5/pt MES)
  - Rate-limit backoff for Polygon API, 6s cache, 5s fetch timeout

## Environment

- `POLYGON_API_KEY` - Polygon.io API key for real futures data (falls back to simulated if missing)

## Running

`npm run dev` starts the Express server on port 5000.
