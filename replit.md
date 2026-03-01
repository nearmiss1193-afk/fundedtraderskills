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
    *   **Pattern Detection:** Detects 8 key trading patterns (e.g., 3 Bar Play, Retest Buy/Sell, Pivot Breakout, Climax/Exhaustion Reversal, Cup & Handle, Wedge Breakout) with individual long/short toggles.
    *   **Pre-Trade Checklist:** Enforces a strict 6-point checklist (HTF alignment, volume, MA confluence, R:R, market choppiness, confluence score) before signal generation.
    *   **Confluence Scoring:** Assigns a score (0-12) to each potential trade based on multiple factors (e.g., volume, MA respect, pivot proximity, bar formation, HTF alignment, candlestick tails, gaps). Provides descriptive labels (A+ Setup, High Probability).
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
    *   **Configuration:** Allows adjustable date ranges, R:R ratios, and max hold bars.
    *   **Metrics:** Calculates detailed performance metrics (Win Rate, Profit Factor, Max Drawdown).
    *   **Advanced Filters:** Incorporates sideways filters, MTF alignment, gap detection, parabolic filters, and enhanced pattern recognition (e.g., Double Bottom/Top Retest, 4 Bar Play).
    *   **Output:** Shows individual trade details with confluence scores and volume types.
*   **Risk Management:** Implements fixed dollar risk per trade, strict R:R adherence (no trailing stops affecting final P&L), and a configurable maximum number of open trades.
*   **CrossTrade Integration:** Connects to CrossTrade webhook for sending orders to NinjaTrader.

**System Design Choices:**
*   **Modularity:** Code is organized into distinct files for routes, trader logic, Supabase interaction, backtesting, journaling, and external API integrations.
*   **Data Persistence:** Uses JSON files (`data/trade_journal.json`, `data/trader_settings.json`) for local data persistence.
*   **Asynchronous Processing:** The AI Futures Trader operates as an asynchronous loop.
*   **External Bridge (Local):** Employs a Python bridge for communication with NinjaTrader via TCP, enabling real-time order execution and acknowledgment.

## External Dependencies

*   **Polygon.io:** Market data API for real futures data and historical backtesting.
*   **Supabase:** Used as a message queue for trade signals and acknowledgments (`trade_signals` and `trade_acks` tables).
*   **Tradovate API:** For paper trading and order execution with bracket orders (entry, stop loss, take profit).
*   **CrossTrade Webhook:** Used to forward orders to NinjaTrader.
*   **NinjaTrader 8 AddOn:** A custom C# AddOn (`SovereignBridgeAddon.cs`) to listen for trade signals from the local Python bridge and execute simulated orders.
*   **Python (local-bridge/bridge.py):** A local script that polls Supabase and communicates with NinjaTrader via TCP.