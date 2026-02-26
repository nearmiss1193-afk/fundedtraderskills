# Sovereign Skill Hub

Minimal Node.js + Express starter for a skill marketplace with autonomous AI skills.

## Endpoints

- `GET /health` - Returns "OK"
- `POST /api/create-skill` - Create a skill `{ name, description }` (in-memory)
- `GET /api/skills` - List all skills
- `POST /api/florida-permit-checker` - Check FL permit requirements `{ renovationType, propertyType, county, details }`
- `GET /api/trader/status` - Check if trading window is open
- `POST /api/trader/start` - Start autonomous trader `{ markets, timeframes, riskPct, patterns, customCondition }`
- `POST /api/trader/stop` - Stop trader `{ sessionId }`
- `GET /api/trader/logs/:sessionId` - Poll trade logs (optional `?after=id`)

## Structure

```
public/index.html   - Static frontend (3 tabs: Create Skill, Permit Checker, AI Futures Trader)
server/routes.ts    - API endpoints
server/trader.ts    - AI Futures Trader simulation engine (background loop, pattern detection)
server/storage.ts   - Stub (in-memory storage in routes.ts)
shared/schema.ts    - Stub
```

## Key Features

- **Create a Skill** - Simple skill CRUD (in-memory)
- **Florida Permit Checker** - County-specific permit logic for Polk/Orange/Hillsborough/Pasco
- **AI Futures Trader** - Based on Jared Wesley's "Trading With An Edge" (Live Traders):
  - 5 patterns: 3 Bar Play, Buy/Sell Setup, Pivot Breakout, Climax Reversal, MA Bounce
  - OHLC bar simulation with 21 EMA + 200 SMA indicators
  - Both LONG and SHORT directions for all patterns
  - Confluence scoring (multiple concepts converging = higher gate/reward ratio)
  - Fear/Greed sentiment tracking from bar counting & volume analysis
  - Igniting/ending volume, bottoming/topping tails, 7+ bar exhaustion
  - 9:30-4PM EST window, background loop (8-15s), polling-based live log
  - Color-coded log: E/SL/TP, bias tag, confluence badge (x/5), sentiment tag
  - Win/loss stats, cumulative P&L ($50/pt ES, $5/pt MES)

## Running

`npm run dev` starts the Express server on port 5000.
