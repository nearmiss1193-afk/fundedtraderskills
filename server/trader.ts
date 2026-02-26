interface TradeLog {
  id: number;
  timestamp: string;
  market: string;
  timeframe: string;
  pattern: string;
  action: string;
  direction: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  pnl: number | null;
  cumPnl: number;
  volume: number | null;
  bias: string | null;
  confluence: number | null;
  sentiment: string | null;
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tail: number;
  wick: number;
  body: number;
  bullish: boolean;
}

interface OpenTrade {
  entry: number;
  stop: number;
  target: number;
  market: string;
  timeframe: string;
  pattern: string;
  direction: "LONG" | "SHORT";
  riskPoints: number;
}

interface MarketState {
  price: number;
  bias: "UPTREND" | "DOWNTREND" | "SIDEWAYS";
  biasStrength: number;
  ema21: number;
  sma200: number;
  pivotHigh: number;
  pivotLow: number;
  pivotHighAge: number;
  pivotLowAge: number;
  volatility: number;
  trendDuration: number;
  consecutiveBars: number;
  lastBarDirection: boolean;
  avgVolume: number;
  sentiment: "BUYERS_CONTROL" | "SELLERS_CONTROL" | "NEUTRAL";
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
  marketState: Record<string, MarketState>;
  bars: Record<string, Bar[]>;
  tickCount: Record<string, number>;
  openTrades: Record<string, OpenTrade>;
  createdAt: number;
  wins: number;
  losses: number;
}

const sessions: Record<string, TraderSession> = {};
let logIdCounter = 1;

const TF_TICKS: Record<string, number> = { "2min": 1, "5min": 2, "15min": 4, "1hour": 8 };

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].running && now - sessions[id].createdAt > 3600000) delete sessions[id];
  }
}, 60000);

function isTradingHours(): boolean {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const t = est.getHours() * 60 + est.getMinutes();
  return t >= 570 && t < 960;
}

function getESTTime(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function r2(v: number): number { return Math.round(v * 100) / 100; }

function makeBar(open: number, close: number, vol: number): Bar {
  const spread = Math.abs(close - open);
  const high = r2(Math.max(open, close) + rand(0.25, spread * 0.5 + 1));
  const low = r2(Math.min(open, close) - rand(0.25, spread * 0.5 + 1));
  const bullish = close >= open;
  const body = Math.abs(close - open);
  const tail = bullish ? (open - low) : (close - low);
  const wick = bullish ? (high - close) : (high - open);
  return { open: r2(open), high, low, close: r2(close), volume: vol, tail: r2(tail), wick: r2(wick), body: r2(body), bullish };
}

function initMarketState(market: string): MarketState {
  const base = market === "MES" ? 5400 + rand(-40, 40) : 5400 + rand(-50, 50);
  const biases: Array<"UPTREND" | "DOWNTREND" | "SIDEWAYS"> = ["UPTREND", "DOWNTREND", "SIDEWAYS"];
  return {
    price: r2(base), bias: biases[Math.floor(Math.random() * 3)],
    biasStrength: rand(0.3, 0.8), ema21: base, sma200: base - rand(-8, 8),
    pivotHigh: r2(base + rand(5, 15)), pivotLow: r2(base - rand(5, 15)),
    pivotHighAge: 0, pivotLowAge: 0,
    volatility: rand(0.5, 2.0), trendDuration: 0,
    consecutiveBars: 0, lastBarDirection: true,
    avgVolume: 1800, sentiment: "NEUTRAL",
  };
}

function generateBar(state: MarketState): Bar {
  state.trendDuration++;
  state.pivotHighAge++;
  state.pivotLowAge++;

  if (state.trendDuration > rand(12, 35)) {
    const biases: Array<"UPTREND" | "DOWNTREND" | "SIDEWAYS"> = ["UPTREND", "DOWNTREND", "SIDEWAYS"];
    state.bias = biases[Math.floor(Math.random() * 3)];
    state.biasStrength = rand(0.3, 0.8);
    state.trendDuration = 0;
    state.volatility = rand(0.5, 2.0);
  }

  let drift = 0;
  if (state.bias === "UPTREND") drift = rand(0.1, 1.5) * state.biasStrength;
  else if (state.bias === "DOWNTREND") drift = -rand(0.1, 1.5) * state.biasStrength;
  else drift = rand(-0.5, 0.5) * 0.3;

  const meanRev = (state.ema21 - state.price) * 0.025;
  drift += meanRev;

  if (state.consecutiveBars >= 7) {
    drift += state.lastBarDirection ? -rand(1, 3) : rand(1, 3);
  }

  const noise = rand(-2.5, 2.5) * state.volatility;
  let move = drift + noise;

  const isClimax = Math.random() < 0.04;
  if (isClimax) move *= rand(2.5, 4.0);

  const open = state.price;
  const close = r2(open + move);

  let volume = Math.round(rand(800, 3000));
  if (isClimax) volume = Math.round(volume * rand(3, 6));
  if (Math.abs(move) > 3) volume = Math.round(volume * rand(1.5, 2.5));
  if (state.bias === "UPTREND" && close > open) volume = Math.round(volume * 1.3);
  if (state.bias === "DOWNTREND" && close < open) volume = Math.round(volume * 1.3);

  if (Math.abs(state.price - state.pivotHigh) < 2 || Math.abs(state.price - state.pivotLow) < 2) {
    volume = Math.round(volume * rand(1.3, 1.8));
  }

  const bar = makeBar(open, close, volume);

  state.price = close;
  state.ema21 = r2((state.ema21 * 20 + close) / 21);
  state.sma200 = r2((state.sma200 * 199 + close) / 200);
  state.avgVolume = Math.round((state.avgVolume * 14 + volume) / 15);

  if (bar.high > state.pivotHigh) { state.pivotHigh = bar.high; state.pivotHighAge = 0; }
  if (bar.low < state.pivotLow) { state.pivotLow = bar.low; state.pivotLowAge = 0; }
  if (Math.random() < 0.06) { state.pivotHigh = bar.high; state.pivotHighAge = 0; }
  if (Math.random() < 0.06) { state.pivotLow = bar.low; state.pivotLowAge = 0; }

  if (bar.bullish === state.lastBarDirection) { state.consecutiveBars++; }
  else { state.consecutiveBars = 1; state.lastBarDirection = bar.bullish; }

  const recentBullish = bar.bullish;
  if (state.consecutiveBars >= 3 && recentBullish) state.sentiment = "BUYERS_CONTROL";
  else if (state.consecutiveBars >= 3 && !recentBullish) state.sentiment = "SELLERS_CONTROL";
  else if (state.consecutiveBars < 2) state.sentiment = "NEUTRAL";

  return bar;
}

function hasBottomingTail(bar: Bar): boolean {
  return bar.tail > bar.body * 1.5 && bar.tail > 0.5;
}

function hasToppingTail(bar: Bar): boolean {
  return bar.wick > bar.body * 1.5 && bar.wick > 0.5;
}

function isEndingVolume(bars: Bar[], avgVol: number): boolean {
  if (bars.length < 3) return false;
  const curr = bars[bars.length - 1];
  return curr.volume > avgVol * 2.5 && curr.body > 2;
}

function isIgnitingVolume(bars: Bar[], avgVol: number): boolean {
  if (bars.length < 2) return false;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  return curr.volume > avgVol * 1.5 && curr.volume > prev.volume * 1.3;
}

function countConsecutiveDown(bars: Bar[]): number {
  let count = 0;
  for (let i = bars.length - 2; i >= 0; i--) {
    if (bars[i].close < bars[i].open) count++;
    else break;
  }
  return count;
}

function countConsecutiveUp(bars: Bar[]): number {
  let count = 0;
  for (let i = bars.length - 2; i >= 0; i--) {
    if (bars[i].close > bars[i].open) count++;
    else break;
  }
  return count;
}

function calcConfluence(factors: boolean[]): number {
  return factors.filter(Boolean).length;
}

function detect3BarPlayBuy(bars: Bar[]): boolean {
  if (bars.length < 4) return false;
  const [b1, b2, b3, b4] = bars.slice(-4);
  return b2.close < b1.close && b3.close < b2.close && b4.close > b3.high && b4.bullish;
}

function detect3BarPlaySell(bars: Bar[]): boolean {
  if (bars.length < 4) return false;
  const [b1, b2, b3, b4] = bars.slice(-4);
  return b2.close > b1.close && b3.close > b2.close && b4.close < b3.low && !b4.bullish;
}

function detectBuySetup(bars: Bar[], state: MarketState): { detected: boolean; confluence: number } {
  if (bars.length < 5) return { detected: false, confluence: 0 };
  const recent = bars.slice(-5);
  const curr = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const low = Math.min(...recent.map(b => b.low));

  if (prev.low <= low * 1.002 && curr.close > prev.high && curr.bullish) {
    const factors = [
      curr.close > state.ema21,
      curr.close > state.sma200,
      hasBottomingTail(prev) || hasBottomingTail(curr),
      isIgnitingVolume(bars, state.avgVolume),
      Math.abs(state.price - state.pivotLow) < 5,
      state.bias === "UPTREND",
      countConsecutiveDown(bars) >= 3,
    ];
    return { detected: true, confluence: calcConfluence(factors) };
  }
  return { detected: false, confluence: 0 };
}

function detectSellSetup(bars: Bar[], state: MarketState): { detected: boolean; confluence: number } {
  if (bars.length < 5) return { detected: false, confluence: 0 };
  const recent = bars.slice(-5);
  const curr = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const high = Math.max(...recent.map(b => b.high));

  if (prev.high >= high * 0.998 && curr.close < prev.low && !curr.bullish) {
    const factors = [
      curr.close < state.ema21,
      curr.close < state.sma200,
      hasToppingTail(prev) || hasToppingTail(curr),
      isIgnitingVolume(bars, state.avgVolume),
      Math.abs(state.price - state.pivotHigh) < 5,
      state.bias === "DOWNTREND",
      countConsecutiveUp(bars) >= 3,
    ];
    return { detected: true, confluence: calcConfluence(factors) };
  }
  return { detected: false, confluence: 0 };
}

function detectBreakoutLong(bars: Bar[], state: MarketState): { detected: boolean; confluence: number } {
  if (bars.length < 3) return { detected: false, confluence: 0 };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (curr.close > state.pivotHigh && prev.close <= state.pivotHigh && curr.bullish) {
    const factors = [
      isIgnitingVolume(bars, state.avgVolume),
      curr.close > state.ema21,
      curr.close > state.sma200,
      state.bias !== "DOWNTREND",
      curr.body > 1.5,
      state.pivotHighAge > 5,
    ];
    return { detected: true, confluence: calcConfluence(factors) };
  }
  return { detected: false, confluence: 0 };
}

function detectBreakoutShort(bars: Bar[], state: MarketState): { detected: boolean; confluence: number } {
  if (bars.length < 3) return { detected: false, confluence: 0 };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (curr.close < state.pivotLow && prev.close >= state.pivotLow && !curr.bullish) {
    const factors = [
      isIgnitingVolume(bars, state.avgVolume),
      curr.close < state.ema21,
      curr.close < state.sma200,
      state.bias !== "UPTREND",
      curr.body > 1.5,
      state.pivotLowAge > 5,
    ];
    return { detected: true, confluence: calcConfluence(factors) };
  }
  return { detected: false, confluence: 0 };
}

function detectClimaxReversal(bars: Bar[], state: MarketState): { detected: boolean; direction: "LONG" | "SHORT"; confluence: number } {
  if (bars.length < 6) return { detected: false, direction: "LONG", confluence: 0 };
  const recent = bars.slice(-6);
  const curr = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  const downBars = countConsecutiveDown(bars);
  const upBars = countConsecutiveUp(bars);

  if (isEndingVolume(bars, state.avgVolume) && downBars >= 5 && curr.bullish && hasBottomingTail(curr)) {
    const factors = [
      downBars >= 7,
      Math.abs(state.price - state.pivotLow) < 5,
      curr.close > state.ema21 || Math.abs(curr.close - state.ema21) < 3,
      hasBottomingTail(prev),
      curr.volume > state.avgVolume * 3,
    ];
    return { detected: true, direction: "LONG", confluence: calcConfluence(factors) };
  }

  if (isEndingVolume(bars, state.avgVolume) && upBars >= 5 && !curr.bullish && hasToppingTail(curr)) {
    const factors = [
      upBars >= 7,
      Math.abs(state.price - state.pivotHigh) < 5,
      curr.close < state.ema21 || Math.abs(curr.close - state.ema21) < 3,
      hasToppingTail(prev),
      curr.volume > state.avgVolume * 3,
    ];
    return { detected: true, direction: "SHORT", confluence: calcConfluence(factors) };
  }
  return { detected: false, direction: "LONG", confluence: 0 };
}

function detectMABounce(bars: Bar[], state: MarketState): { detected: boolean; direction: "LONG" | "SHORT"; confluence: number } {
  if (bars.length < 4) return { detected: false, direction: "LONG", confluence: 0 };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const emaZone = state.ema21 * 0.002;

  if (prev.low <= state.ema21 + emaZone && prev.low >= state.ema21 - emaZone && curr.close > prev.high && curr.bullish && state.bias === "UPTREND") {
    const factors = [
      hasBottomingTail(prev),
      isIgnitingVolume(bars, state.avgVolume),
      curr.body > 1,
      Math.abs(state.price - state.pivotLow) < 8,
    ];
    return { detected: true, direction: "LONG", confluence: calcConfluence(factors) };
  }

  if (prev.high >= state.ema21 - emaZone && prev.high <= state.ema21 + emaZone && curr.close < prev.low && !curr.bullish && state.bias === "DOWNTREND") {
    const factors = [
      hasToppingTail(prev),
      isIgnitingVolume(bars, state.avgVolume),
      curr.body > 1,
      Math.abs(state.price - state.pivotHigh) < 8,
    ];
    return { detected: true, direction: "SHORT", confluence: calcConfluence(factors) };
  }
  return { detected: false, direction: "LONG", confluence: 0 };
}

function sentimentLabel(s: MarketState): string {
  if (s.sentiment === "BUYERS_CONTROL") return "GREED";
  if (s.sentiment === "SELLERS_CONTROL") return "FEAR";
  return "NEUTRAL";
}

function simulateTick(session: TraderSession) {
  const ts = getESTTime();
  if (!isTradingHours()) {
    if (session.logs.length === 0 || session.logs[session.logs.length - 1].action !== "MARKET CLOSED") {
      session.logs.push({
        id: logIdCounter++, timestamp: ts,
        market: "--", timeframe: "--", pattern: "--",
        action: "MARKET CLOSED", direction: "--",
        entry: null, stop: null, target: null, pnl: null,
        cumPnl: session.cumPnl, volume: null, bias: null,
        confluence: null, sentiment: null,
      });
    }
    return;
  }

  for (const market of session.markets) {
    const mk = market === "MES" ? "MES" : "ES";
    const pointValue = mk === "ES" ? 50 : 5;

    if (!session.marketState[mk]) session.marketState[mk] = initMarketState(mk);
    const state = session.marketState[mk];
    const tradeKey = mk;

    if (session.openTrades[tradeKey]) {
      const t = session.openTrades[tradeKey];
      const bar = generateBar(state);

      let hit = false;
      if (t.direction === "LONG") {
        if (bar.low <= t.stop) {
          const pnl = r2((t.stop - t.entry) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.losses++;
          session.logs.push({ id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe, pattern: t.pattern, action: "STOPPED OUT", direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias, confluence: null, sentiment: sentimentLabel(state) });
          delete session.openTrades[tradeKey]; hit = true;
        } else if (bar.high >= t.target) {
          const pnl = r2((t.target - t.entry) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.wins++;
          session.logs.push({ id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe, pattern: t.pattern, action: "TARGET HIT", direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias, confluence: null, sentiment: sentimentLabel(state) });
          delete session.openTrades[tradeKey]; hit = true;
        }
      } else {
        if (bar.high >= t.stop) {
          const pnl = r2((t.entry - t.stop) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.losses++;
          session.logs.push({ id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe, pattern: t.pattern, action: "STOPPED OUT", direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias, confluence: null, sentiment: sentimentLabel(state) });
          delete session.openTrades[tradeKey]; hit = true;
        } else if (bar.low <= t.target) {
          const pnl = r2((t.entry - t.target) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.wins++;
          session.logs.push({ id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe, pattern: t.pattern, action: "TARGET HIT", direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias, confluence: null, sentiment: sentimentLabel(state) });
          delete session.openTrades[tradeKey]; hit = true;
        }
      }
      if (!hit) continue;
    }

    for (const tf of session.timeframes) {
      const barKey = `${mk}_${tf}`;
      if (!session.bars[barKey]) session.bars[barKey] = [];
      if (!session.tickCount[barKey]) session.tickCount[barKey] = 0;
      session.tickCount[barKey]++;
      if (session.tickCount[barKey] % (TF_TICKS[tf] || 1) !== 0) continue;

      const bar = generateBar(state);
      session.bars[barKey].push(bar);
      if (session.bars[barKey].length > 30) session.bars[barKey].shift();

      const bars = session.bars[barKey];
      if (bars.length < 6) continue;

      let detectedPattern = "";
      let direction: "LONG" | "SHORT" = "LONG";
      let confluence = 0;

      if (session.patterns.includes("3bar")) {
        if (detect3BarPlayBuy(bars)) {
          detectedPattern = "3 Bar Play";
          direction = "LONG";
          confluence = calcConfluence([
            isIgnitingVolume(bars, state.avgVolume),
            bar.close > state.ema21,
            bar.close > state.sma200,
            state.bias !== "DOWNTREND",
            hasBottomingTail(bars[bars.length - 2]),
          ]);
        } else if (detect3BarPlaySell(bars)) {
          detectedPattern = "3 Bar Play Sell";
          direction = "SHORT";
          confluence = calcConfluence([
            isIgnitingVolume(bars, state.avgVolume),
            bar.close < state.ema21,
            bar.close < state.sma200,
            state.bias !== "UPTREND",
            hasToppingTail(bars[bars.length - 2]),
          ]);
        }
      }

      if (!detectedPattern && session.patterns.includes("buysetup")) {
        const buy = detectBuySetup(bars, state);
        if (buy.detected) { detectedPattern = "Buy Setup"; direction = "LONG"; confluence = buy.confluence; }
        else {
          const sell = detectSellSetup(bars, state);
          if (sell.detected) { detectedPattern = "Sell Setup"; direction = "SHORT"; confluence = sell.confluence; }
        }
      }

      if (!detectedPattern && session.patterns.includes("breakout")) {
        const bl = detectBreakoutLong(bars, state);
        if (bl.detected) { detectedPattern = "Breakout Long"; direction = "LONG"; confluence = bl.confluence; }
        else {
          const bs = detectBreakoutShort(bars, state);
          if (bs.detected) { detectedPattern = "Breakout Short"; direction = "SHORT"; confluence = bs.confluence; }
        }
      }

      if (!detectedPattern && session.patterns.includes("climax")) {
        const c = detectClimaxReversal(bars, state);
        if (c.detected) { detectedPattern = "Climax Reversal"; direction = c.direction; confluence = c.confluence; }
      }

      if (!detectedPattern && session.patterns.includes("mabounce")) {
        const m = detectMABounce(bars, state);
        if (m.detected) { detectedPattern = "MA Bounce"; direction = m.direction; confluence = m.confluence; }
      }

      if (detectedPattern && !session.openTrades[tradeKey]) {
        const minConf = 2;
        const entryGate = confluence >= 4 ? 0.55 : confluence >= minConf ? 0.35 : 0.12;

        if (confluence >= minConf && Math.random() < entryGate) {
          const entry = state.price;
          const baseRisk = rand(2, 5);
          const riskPoints = Math.round(baseRisk * 4) / 4;
          const rewardRatio = confluence >= 4 ? rand(2.0, 3.5) : rand(1.5, 2.5);
          let stop: number, target: number;

          if (direction === "LONG") {
            stop = r2(entry - riskPoints);
            target = r2(entry + riskPoints * rewardRatio);
          } else {
            stop = r2(entry + riskPoints);
            target = r2(entry - riskPoints * rewardRatio);
          }

          session.openTrades[tradeKey] = { entry, stop, target, market: mk, timeframe: tf, pattern: detectedPattern, direction, riskPoints };

          session.logs.push({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: tf, pattern: detectedPattern,
            action: direction === "LONG" ? "LONG ENTERED" : "SHORT ENTERED", direction,
            entry, stop, target, pnl: null, cumPnl: session.cumPnl,
            volume: bar.volume, bias: state.bias, confluence, sentiment: sentimentLabel(state),
          });
          break;
        }

        if (Math.random() < 0.45) {
          session.logs.push({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: tf, pattern: detectedPattern,
            action: "SIGNAL (no entry)", direction,
            entry: state.price, stop: null, target: null,
            pnl: null, cumPnl: session.cumPnl,
            volume: bar.volume, bias: state.bias, confluence, sentiment: sentimentLabel(state),
          });
        }
      }
    }
  }

  if (session.logs.length > 300) session.logs = session.logs.slice(-300);
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
    markets: config.markets, timeframes: config.timeframes,
    riskPct: config.riskPct, patterns: config.patterns,
    customCondition: config.customCondition,
    logs: [], cumPnl: 0, timeout: null,
    marketState: {}, bars: {}, tickCount: {},
    openTrades: {}, createdAt: Date.now(),
    wins: 0, losses: 0,
  };

  session.logs.push({
    id: logIdCounter++, timestamp: getESTTime(),
    market: "--", timeframe: "--", pattern: "--",
    action: "TRADER STARTED", direction: "--",
    entry: null, stop: null, target: null, pnl: null, cumPnl: 0,
    volume: null, bias: null, confluence: null, sentiment: null,
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
    action: "TRADER STOPPED", direction: "--",
    entry: null, stop: null, target: null, pnl: null, cumPnl: s.cumPnl,
    volume: null, bias: null, confluence: null, sentiment: null,
  });
  return true;
}

export function getTraderLogs(id: string, after?: number): TradeLog[] {
  const s = sessions[id];
  if (!s) return [];
  if (after) return s.logs.filter(l => l.id > after);
  return s.logs;
}

export function getTraderStatus(id: string): { running: boolean; cumPnl: number; tradeCount: number; openPositions: number; wins: number; losses: number } | null {
  const s = sessions[id];
  if (!s) return null;
  return {
    running: s.running, cumPnl: s.cumPnl,
    tradeCount: s.logs.filter(l => l.action === "LONG ENTERED" || l.action === "SHORT ENTERED").length,
    openPositions: Object.keys(s.openTrades).length,
    wins: s.wins, losses: s.losses,
  };
}

export function isTradingOpen(): boolean { return isTradingHours(); }
