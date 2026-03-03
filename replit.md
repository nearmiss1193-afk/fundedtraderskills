# Sovereign Skill Hub

## Overview

The Sovereign Skill Hub is a web-based platform designed to host and manage autonomous AI skills, primarily focused on financial market analysis and automated trading. Its core purpose is to provide users with tools for developing, testing, and deploying AI-driven trading strategies, aiming to empower them with sophisticated, data-driven insights and automated execution capabilities in financial markets. The platform also includes utilities like a permit checker.

## User Preferences

I prefer clear and concise information. When making changes, please explain the reasoning and potential impact. For complex features, an iterative development approach with regular check-ins is preferred. I value detailed explanations, especially for trading logic and system behavior.

## System Architecture

The application is built on a Node.js and Express.js backend, serving a static frontend.

**UI/UX Decisions:**
The frontend is organized into distinct tabs: "Create Skill," "Permit Checker," "AI Futures Trader," and "Edge Builder." It incorporates sortable/filterable tables, graphical representations for analytics, intuitive configuration forms, and color-coding for trade outcomes and log entries.

**Technical Implementations & Feature Specifications:**

*   **API Endpoints:** A RESTful API supports skill management, permit checking, trader operations (start, stop, logs, settings), trade journaling, signal processing, and backtesting.
*   **Skill Management:** Basic CRUD operations for in-memory AI skills.
*   **Florida Permit Checker:** Logic for county-specific renovation and property permits.
*   **AI Futures Trader:** An asynchronous trading engine processing real-time or simulated data. It uses Polygon.io for market data, configurable strategy settings (risk-to-reward, force trading, pattern/timeframe toggles), and technical indicators (9 EMA, 21 EMA, 200 SMA, RSI-14). The trader includes a live scanner for 24 pattern variants (12 pattern types × long/short) with local peak/trough detection, linear regression, volume surge confirmation, and multi-factor confluence scoring (Volume Profile +2 cap, Order Flow +3 cap, VWAP +1, RSI ±2, Edge Boost combos). Patterns: 3 Bar Play, 4 Bar Play, Buy/Sell Setup, Pivot Breakout, Climax Reversal, Wedge Breakout, Cup & Handle / Inverse, Double Top/Bottom, Head & Shoulders / Inverse, Bull/Bear Flag, Bear Trap Reversal, VWAP Bounce, Retest Buy/Sell (W-Bottom/Double Bottom Retest variants). A pre-trade checklist and trailing stops are also implemented.
*   **Trade Journal:** Automatically saves completed trades, offers a sortable/filterable UI, and provides summary statistics and advanced analytics grouped by various parameters.
*   **Edge Builder Dashboard:** Provides advanced analytics to identify profitable trading setups, offers AI-generated optimization recommendations, and includes a pattern library.
*   **Historical Backtester:** Tests trading patterns against historical data with adjustable date ranges, R:R ratios, and timeframe selections. It supports multi-symbol edge scans, backtest edge heatmaps, and a historical scan archive with persistent storage. An Apex Trader Funding Simulator is integrated for evaluating performance against specific funding program rules. Backtest results can be exported as CSV.
*   **Risk Management:** Implements fixed dollar risk per trade, strict R:R adherence, and configurable maximum open trades.
*   **Safety Guardrails:** Includes a live confluence filter, data-driven edge boosts, multi-pattern convergence logic, volume profile confluence bonuses (POC/VAH/VAL, capped +2), order flow confluence (cumulative delta, imbalance, absorption, capped +3), VWAP confluence (price above/below VWAP aligned with direction, +1), news filter (Polygon news API, blocks ALL scanning for 30 min during high-impact events like FOMC/CPI/NFP/GDP — not just orders), maximum risk per trade, configurable daily loss limits ($100-$10000, default $1500), and SIM-only enforcement with an account selector. Apex Trader Funding rules are integrated for compliance checking.
*   **Per-Symbol Market Hours:** Scanners skip symbols whose markets are closed using `MARKET_SESSIONS_CT` (Central Time session windows per symbol). Grains (ZC/ZS/ZW) have split sessions (7pm-7:45am + 8:30am-1:20pm CT). Equity indices/energy/crypto trade 5pm-4pm CT. Saturdays fully blocked, Sundays before 5pm CT blocked. `isMarketOpen()` gates both scanning and order emission (defense-in-depth). `forceTrading` flag bypasses for testing.
*   **Order Rejection Handling:** CrossTrade response bodies are parsed for `error` fields. If an order is accepted by CrossTrade webhook but rejected by NinjaTrader, the system: (1) removes the trade from `openTrades`, (2) logs "ORDER REJECTED", (3) sends `CLOSEPOSITION` to CrossTrade to keep both sides in sync. Prevents phantom open positions from rejected orders.
*   **Apex Account Auto-Removal:** Per-account status tracking in `server/account-status.ts` (shared module, no circular deps). `GET /api/apex/eval-status` returns all accounts with status (active/failed). Funded accounts auto-fail when daily loss limit breached or trailing drawdown exceeds -3%. Failed accounts: (1) removed from dropdown, (2) signals blocked in `emitTradeSignal`, (3) cannot be selected via set-account. `POST /api/apex/reset-account` resets a failed account. Frontend polls every 60s and shows toast when accounts are removed. `POST /api/config/set-account` blocks selecting failed accounts.
*   **Trading Plan & Daily Routine:** Features a daily routine checklist, configurable personal trading goals, live performance statistics (Win Rate, Profit Factor, P&L, Expectancy, Sharpe Ratio, Recovery Factor), and a weekly progress bar.
*   **Edge Optimizer:** Runs full optimization scans across various trading parameters, provides real-time progress polling, and ranks setups based on a composite scoring algorithm to identify profitable trading edges. Results are auto-archived.
*   **Close All Positions:** Provides an API endpoint and UI functionality to close all active trading positions via CrossTrade.
*   **Multi-Account Trading:** Supports trading on a single selected account OR all accounts simultaneously. A "Trade All Accounts Simultaneously" checkbox sends every signal to all configured accounts (Sim101, APEX22106300000111, APEX22106300000114). When unchecked, only the selected account in the dropdown receives signals. The `accounts` array is stored in the `TraderSession` and `emitTradeSignal` loops through all accounts in the array.
*   **Funding Mode:** A selective trading mode optimized for passing Apex Trader Funding evaluations. Updated Mar 2026: **Tradovate-only symbols enforced** — GC, MGC, SI, HG, ZN, ZB, ZF, ZT removed (not available on Tradovate/Apex). BTC→MBT, ETH→MET symbol mapping applied. 35 whitelisted combos across Tradovate-supported symbols (ES, MES, NQ, MNQ, YM, MYM, RTY, M2K, CL, MCL, ZC, ZS, ZW, MBT, MET) with per-entry minimum confluence requirements (FUNDING_MIN_CONFLUENCE=6 default). `POLYGON_TO_NT_SYMBOL` mapping in trader.ts converts Polygon symbols to NinjaTrader/Tradovate format. `TRADOVATE_SUPPORTED` set blocks non-Tradovate symbols on funded accounts. The whitelist is defined in `FUNDING_MODE_WHITELIST` in `server/trader.ts` and exposed via `GET /api/trader/funding-whitelist`.
*   **Contract Month Mapping:** `getNTInstrument()` in trader.ts and `getNinjaTraderInstrument()` in crosstrade.ts use per-symbol contract cycles (not just quarterly/monthly). Matches CME/CBOT/NYMEX expiry calendars exactly. BTC→MBT, ETH→MET applied before cycle lookup.

*   **Bulk Historical Cache:** One-time download system that pre-fetches ETF proxy data from Polygon for all 21 futures symbols across 4 timeframes (5min, 15min, 1hour, daily) and saves to disk (`/data/` folder). Uses disk-backed cache that persists across server restarts. Backtest cache (`getCachedBars`) checks memory first, then disk, eliminating Polygon API calls for repeat scans. Download triggered via Edge Builder tab button or `POST /api/backtest/download-bulk`. Progress polled via `GET /api/backtest/cache-status`.

**System Design Choices:**
The system emphasizes modularity, with code organized into distinct files for routes, trader logic, backtesting, journaling, and API integrations. Data persistence is managed using local JSON files and disk-backed cache (`/data/` directory for historical bar data). The AI Futures Trader operates asynchronously. A Supabase signal queue is used for trade signals and acknowledgments.

## External Dependencies

*   **Polygon.io:** Market data API (primary source; free tier rate-limited to ~5 calls/min).
*   **Yahoo Finance (`yahoo-finance2` npm):** Secondary/fallback data source for backtesting. No rate limits. Supports stocks (AAPL, SPY, etc.) and futures via Yahoo symbols (ES=F, NQ=F, CL=F, GC=F, BTC-USD, etc.). Used when `dataSource: "yahoo"` is passed to backtest endpoints, or automatically as fallback when Polygon returns 0 bars (`dataSource: "auto"`). Symbol mapping in `YAHOO_SYMBOL_MAP` in `server/backtest.ts`. Interval mapping in `YAHOO_INTERVAL_MAP`.
*   **Supabase:** Message queue for trade signals and acknowledgments.
*   **Tradovate API:** For paper trading and order execution.
*   **CrossTrade Webhook:** Used to forward orders to NinjaTrader. Payload format: semicolon-delimited key-value pairs with `Content-Type: text/plain`. Instrument format is `SYMBOL MM-YY` (e.g., `MES 03-26`). Commands: `PLACE` (with account/instrument/action/qty/order_type/tif), `FLATTENEVERYTHING` (no account param), `CLOSEPOSITION` (with account/instrument). The `getNinjaTraderInstrument()` function in `server/services/crosstrade.ts` auto-maps root symbols to the correct front-month contract format.
*   **NinjaTrader 8 AddOn:** Custom C# AddOn for polling Supabase and executing orders.
*   **Python (local-bridge/bridge.py):** Optional local bridge for forwarding signals to NinjaTrader via TCP.