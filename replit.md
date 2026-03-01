# Sovereign Skill Hub

## Overview

The Sovereign Skill Hub is a web-based platform designed to host and manage autonomous AI skills, with a primary focus on financial market analysis and automated trading. It aims to provide users with tools for developing, testing, and deploying AI-driven trading strategies, alongside utilities like a permit checker. The project's vision is to empower users with sophisticated, data-driven insights and automated execution capabilities in financial markets, fostering a new generation of personal trading autonomy.

## User Preferences

I prefer clear and concise information. When making changes, please explain the reasoning and potential impact. For complex features, an iterative development approach with regular check-ins is preferred. I value detailed explanations, especially for trading logic and system behavior.

## System Architecture

The application is built on a Node.js and Express.js backend, serving a static frontend (`public/index.html`).

**UI/UX Decisions:**
The frontend is organized into four main tabs: "Create Skill," "Permit Checker," "AI Futures Trader," and "Edge Builder," providing a clear separation of functionalities. The UI includes sortable/filterable tables, graphical representations for analytics, and intuitive forms for configuration. Color-coding is used for trade outcomes (green for win, red for loss) and log entries.

**Technical Implementations & Feature Specifications:**

*   **API Endpoints:** A RESTful API handles skill creation, listing, permit checking, trader management (start, stop, logs, settings), trade journaling, signal processing, and backtesting.
*   **Skill Management:** Basic CRUD operations for in-memory skills.
*   **Florida Permit Checker:** Implements county-specific permit logic for various renovation and property types.
*   **AI Futures Trader:**
    *   **Core Logic:** An asynchronous trading engine processes real-time or simulated data.
    *   **Market Data:** Utilizes Polygon.io for real futures data (or ETF proxies for free tier) across 25 futures symbols and 6 timeframes.
    *   **Strategy Configuration:** Configurable risk-to-reward ratios, force trading mode, and granular pattern/timeframe toggles persisted in settings.
    *   **Technical Indicators:** Incorporates 9 EMA, 21 EMA, and 200 SMA for trend confirmation.
    *   **Pattern Detection (Live Scanner):** Detects 9 live patterns: 3 Bar Play, Buy/Sell Setup, Pivot Breakout, Climax/Exhaustion Reversal, Wedge Breakout (falling wedge long / rising wedge short), Cup & Handle (bullish), Inverse Cup & Handle (bearish), Double Bottom (bullish), and Double Top (bearish). All use linear regression, local peak/trough detection, volume surge confirmation, and confluence scoring. Backtester additionally supports Retest and 4 Bar Play. All patterns have individual long/short toggles.
    *   **Pre-Trade Checklist:** Enforces a strict 6-point checklist (HTF alignment, volume, MA confluence, R:R, market choppiness, confluence score) before signal generation.
    *   **Confluence Scoring:** Assigns a score (0-11) per signal based on: volume surge, igniting vol type, candlestick tail, strong body, MA respect, HTF alignment, tail/wick quality, Level 1 gap (0.5%), Level 2/3 gap (1%), W-Bottom/W-Top, double bottom/top. Provides descriptive labels (A+ Setup, High Probability).
    *   **Trade Management:** Includes trailing stops (activates after 1R move, trails at 0.6R from high/low), breakeven management, and detailed logging of entry reasons and confluence.
    *   **Sentiment Analysis:** Incorporates fear/greed dynamics to bias price movement.
    *   **Price Scaling:** Uses relative percentages for thresholds (e.g., near MA, near pivot) instead of hardcoded points.
*   **Trade Journal:**
    *   **Persistence:** Auto-saves completed trades to a JSON file (`data/trade_journal.json`).
    *   **UI:** Provides a sortable, filterable spreadsheet interface with editable notes.
    *   **Analytics:** Displays summary statistics (win rate, profit factor, P&L) and offers advanced analytics grouped by pattern, symbol, timeframe, and confluence level.
*   **Edge Builder Dashboard:**
    *   **Advanced Analytics:** Provides overall metrics and grouped statistics to identify profitable trading setups.
    *   **Optimization:** Offers AI-generated recommendations for improving trading edge.
    *   **Pattern Library:** Detailed descriptions of trading patterns with rules and confluence tips.
*   **Historical Backtester:**
    *   **Functionality:** Tests trading patterns against historical data from Polygon.io.
    *   **Configuration:** Allows adjustable date ranges, R:R ratios, max hold bars, and timeframe selection (daily, 5min, 15min, 1hour, 4hour).
    *   **Multi-Symbol Edge Scan:** `POST /api/backtest/multi` accepts `symbols[]`, `patterns[]`, `minConfluence`, date range; runs batch backtests across up to 25 symbols × 8 patterns. Returns `summary`, `patternBreakdown` (aggregated by pattern), `heatmap` (Symbol × Pattern cells with winRate/PF/pnl/expectancy), and `results` ranked by P&L.
    *   **Backtest Edge Heatmap:** Color-coded Symbol × Pattern performance grid auto-populates after multi-scan. Includes Pattern Breakdown table, visual heatmap grid (green/yellow/red cells), and full sortable detail table.
    *   **CSV Export:** Download backtest results as CSV for external analysis (Google Sheets, Excel pivot tables).
    *   **Metrics:** Calculates detailed performance metrics (Win Rate, Profit Factor, Max Drawdown).
    *   **Advanced Filters:** Sideways filter (EMA9≈EMA21 <0.3%), MTF pivot alignment, gap detection (Level 1: 0.5%, Level 2/3: 1%), parabolic filter (7+ consecutive bars >3% from EMA), W-Bottom/W-Top detection (2+ touches within 0.3% + bottoming/topping tail), and enhanced pattern recognition (Double Bottom/Top Retest, W-Bottom Retest, 4 Bar Play).
    *   **Bar Caching Layer:** In-memory cache with 5-min TTL reduces Polygon API calls. ETF proxy deduplication (ES/MES share SPY, NQ/MNQ share QQQ, etc.) means ~12 unique fetches for 18 ETF-proxied symbols. Rate limit guard (4 calls/min proactive pause) + 429 retry with 30-65s backoff (3 attempts).
    *   **Output:** Shows individual trade details with confluence scores and volume types.
*   **Risk Management:** Implements fixed dollar risk per trade, strict R:R adherence (no trailing stops affecting final P&L), and a configurable maximum number of open trades.
*   **Safety Guardrails:**
    *   **Live confluence filter:** ≥8pt required (`LIVE_CONFLUENCE_MIN = 8` in trader.ts)
    *   **Edge boost:** Data-driven confluence bonus for proven combos: NQ/Wedge +2, SI/BuySetup|Breakout|3Bar +2, ZS/3Bar +1, ZW/3Bar +1, CL/Wedge +1. Logged as `[EDGE+N]` in confluence label.
    *   **Multi-pattern convergence:** All patterns checked on each bar; if 2+ fire simultaneously, highest-confluence pattern is selected and gets +1.5pt per extra pattern (max +3). Logged as `[CONVERGE+N w/ Pattern1, Pattern2]`.
    *   **Max risk per trade:** 1% of $50,000 account (`MAX_RISK_PCT = 0.01`)
    *   **Daily loss limit:** -3% stops all scanning (`DAILY_LOSS_LIMIT_PCT = -0.03`)
    *   **SIM-only enforcement:** Non-SIM accounts blocked unless `ALLOW_LIVE_TRADES=true`
    *   **Contract limit:** `MAX_CONTRACTS` env var (default 1) in CrossTrade
    *   **Safety status API:** `GET /api/trader/safety` returns daily P&L, limits, confluence min
*   **CrossTrade Integration:** Connects to CrossTrade webhook for sending orders to NinjaTrader.

**System Design Choices:**
*   **Modularity:** Code is organized into distinct files for routes, trader logic, Supabase interaction, backtesting, journaling, and external API integrations.
*   **Data Persistence:** Uses JSON files (`data/trade_journal.json`, `data/trader_settings.json`) for local data persistence.
*   **Asynchronous Processing:** The AI Futures Trader operates as an asynchronous loop.
*   **Supabase Signal Queue:** Signals are inserted directly into the Supabase `trade_signals` table (status="NEW", source="replit", client_tag="v1"). ACK polling via `trade_acks` table returns accepted/rejected/pending status.

## External Dependencies

*   **Polygon.io:** Market data API for real futures data and historical backtesting.
*   **Supabase:** Used as a message queue for trade signals and acknowledgments (`trade_signals` and `trade_acks` tables).
*   **Tradovate API:** For paper trading and order execution with bracket orders (entry, stop loss, take profit).
*   **CrossTrade Webhook:** Used to forward orders to NinjaTrader.
*   **NinjaTrader 8 AddOn:** A custom C# AddOn polls Supabase `trade_signals` for NEW signals and executes orders, writing ACKs back to `trade_acks`.
*   **Python (local-bridge/bridge.py):** Optional local bridge that polls Supabase and forwards signals to NinjaTrader via TCP.