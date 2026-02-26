interface TradeLog {
  id: number;
  timestamp: string;
  market: string;
  timeframe: string;
  pattern: string;
  action: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  pnl: number | null;
  cumPnl: number;
}

interface TraderSession {
  id: string;
  running: boolean;
  markets: string[];
  timeframes: string[];
  riskPct: number;
  patterns: string[];
  customCondition: string;
  logs: TradeLog[];
  cumPnl: number;
  timeout: ReturnType<typeof setTimeout> | null;
  prices: Record<string, number>;
  bars: Record<string, number[]>;
  tickCount: Record<string, number>;
  openTrades: Record<string, { entry: number; stop: number; target: number; market: string; timeframe: string; pattern: string }>;
  createdAt: number;
}

const sessions: Record<string, TraderSession> = {};
let logIdCounter = 1;

const TF_TICKS: Record<string, number> = { "2min": 1, "5min": 2, "15min": 4, "1hour": 8 };

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (!s.running && now - s.createdAt > 3600000) {
      delete sessions[id];
    }
  }
}, 60000);

function isTradingHours(): boolean {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = est.getHours();
  const m = est.getMinutes();
  const t = h * 60 + m;
  return t >= 570 && t < 960;
}

function getESTTime(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function initPrice(market: string): number {
  if (market === "ES") return 5400 + rand(-50, 50);
  return 5400 + rand(-50, 50);
}

function simulateTick(session: TraderSession) {
  const ts = getESTTime();
  const tradingOpen = isTradingHours();

  if (!tradingOpen) {
    if (session.logs.length === 0 || session.logs[session.logs.length - 1].action !== "MARKET CLOSED") {
      session.logs.push({
        id: logIdCounter++, timestamp: ts,
        market: "--", timeframe: "--", pattern: "--",
        action: "MARKET CLOSED",
        entry: null, stop: null, target: null, pnl: null,
        cumPnl: session.cumPnl,
      });
    }
    return;
  }

  for (const market of session.markets) {
    const mk = market === "MES" ? "MES" : "ES";
    const pointValue = mk === "ES" ? 50 : 5;

    if (!session.prices[mk]) session.prices[mk] = initPrice(mk);

    const move = rand(-3.5, 3.5);
    session.prices[mk] = Math.round((session.prices[mk] + move) * 100) / 100;

    const tradeKey = mk;
    if (session.openTrades[tradeKey]) {
      const t = session.openTrades[tradeKey];
      const price = session.prices[mk];
      if (price <= t.stop) {
        const pnl = Math.round((t.stop - t.entry) * pointValue * 100) / 100;
        session.cumPnl = Math.round((session.cumPnl + pnl) * 100) / 100;
        session.logs.push({
          id: logIdCounter++, timestamp: ts, market: mk,
          timeframe: t.timeframe, pattern: t.pattern,
          action: "STOPPED OUT",
          entry: t.entry, stop: t.stop, target: t.target,
          pnl, cumPnl: session.cumPnl,
        });
        delete session.openTrades[tradeKey];
      } else if (price >= t.target) {
        const pnl = Math.round((t.target - t.entry) * pointValue * 100) / 100;
        session.cumPnl = Math.round((session.cumPnl + pnl) * 100) / 100;
        session.logs.push({
          id: logIdCounter++, timestamp: ts, market: mk,
          timeframe: t.timeframe, pattern: t.pattern,
          action: "TARGET HIT",
          entry: t.entry, stop: t.stop, target: t.target,
          pnl, cumPnl: session.cumPnl,
        });
        delete session.openTrades[tradeKey];
      }
      continue;
    }

    for (const tf of session.timeframes) {
      const barKey = `${mk}_${tf}`;
      if (!session.bars[barKey]) session.bars[barKey] = [];
      if (!session.tickCount[barKey]) session.tickCount[barKey] = 0;

      session.tickCount[barKey]++;
      const interval = TF_TICKS[tf] || 1;
      if (session.tickCount[barKey] % interval !== 0) continue;

      session.bars[barKey].push(session.prices[mk]);
      if (session.bars[barKey].length > 20) session.bars[barKey].shift();

      const bars = session.bars[barKey];
      if (bars.length < 5) continue;

      let detectedPattern = "";

      if (session.patterns.includes("3bar") && bars.length >= 4) {
        const [b1, b2, b3, b4] = bars.slice(-4);
        if (b2 < b1 && b3 < b2 && b4 > b3 && b4 > b2) {
          detectedPattern = "3 Bar Play";
        }
      }

      if (!detectedPattern && session.patterns.includes("buysetup") && bars.length >= 5) {
        const recent = bars.slice(-5);
        const low = Math.min(...recent);
        const curr = recent[recent.length - 1];
        if (curr > low && (curr - low) / low > 0.001 && recent[recent.length - 2] <= low * 1.0005) {
          detectedPattern = "Buy Setup";
        }
      }

      if (detectedPattern && Math.random() < 0.35 && !session.openTrades[tradeKey]) {
        const entry = session.prices[mk];
        const riskPoints = Math.round(rand(2, 6) * 4) / 4;
        const rewardRatio = rand(1.5, 3.0);
        const stop = Math.round((entry - riskPoints) * 100) / 100;
        const target = Math.round((entry + riskPoints * rewardRatio) * 100) / 100;

        session.openTrades[tradeKey] = { entry, stop, target, market: mk, timeframe: tf, pattern: detectedPattern };

        session.logs.push({
          id: logIdCounter++, timestamp: ts, market: mk,
          timeframe: tf, pattern: detectedPattern,
          action: "LONG ENTERED",
          entry, stop, target,
          pnl: null, cumPnl: session.cumPnl,
        });
        break;
      }

      if (detectedPattern && Math.random() < 0.6) {
        session.logs.push({
          id: logIdCounter++, timestamp: ts, market: mk,
          timeframe: tf, pattern: detectedPattern,
          action: "SIGNAL (no entry)",
          entry: session.prices[mk], stop: null, target: null,
          pnl: null, cumPnl: session.cumPnl,
        });
      }
    }
  }

  if (session.logs.length > 200) {
    session.logs = session.logs.slice(-200);
  }
}

export function startTrader(config: {
  markets: string[];
  timeframes: string[];
  riskPct: number;
  patterns: string[];
  customCondition: string;
}): string {
  const id = "session_" + Date.now();
  const session: TraderSession = {
    id, running: true,
    markets: config.markets,
    timeframes: config.timeframes,
    riskPct: config.riskPct,
    patterns: config.patterns,
    customCondition: config.customCondition,
    logs: [], cumPnl: 0, timeout: null,
    prices: {}, bars: {}, tickCount: {},
    openTrades: {},
    createdAt: Date.now(),
  };

  session.logs.push({
    id: logIdCounter++, timestamp: getESTTime(),
    market: "--", timeframe: "--", pattern: "--",
    action: "TRADER STARTED",
    entry: null, stop: null, target: null, pnl: null, cumPnl: 0,
  });

  const delay = () => Math.floor(rand(8000, 15000));
  function loop() {
    if (!session.running) return;
    simulateTick(session);
    session.timeout = setTimeout(loop, delay());
  }
  session.timeout = setTimeout(loop, 2000);
  sessions[id] = session;
  return id;
}

export function stopTrader(id: string): boolean {
  const s = sessions[id];
  if (!s) return false;
  s.running = false;
  if (s.timeout) { clearTimeout(s.timeout); s.timeout = null; }

  s.logs.push({
    id: logIdCounter++, timestamp: getESTTime(),
    market: "--", timeframe: "--", pattern: "--",
    action: "TRADER STOPPED",
    entry: null, stop: null, target: null, pnl: null, cumPnl: s.cumPnl,
  });

  return true;
}

export function getTraderLogs(id: string, after?: number): TradeLog[] {
  const s = sessions[id];
  if (!s) return [];
  if (after) return s.logs.filter(l => l.id > after);
  return s.logs;
}

export function getTraderStatus(id: string): { running: boolean; cumPnl: number; tradeCount: number; openPositions: number } | null {
  const s = sessions[id];
  if (!s) return null;
  return {
    running: s.running,
    cumPnl: s.cumPnl,
    tradeCount: s.logs.filter(l => l.action === "LONG ENTERED").length,
    openPositions: Object.keys(s.openTrades).length,
  };
}

export function isTradingOpen(): boolean {
  return isTradingHours();
}
