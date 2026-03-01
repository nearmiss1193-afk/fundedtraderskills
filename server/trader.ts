import { addJournalEntry, type JournalEntry } from "./journal";
import { connectTradovate, isTradovateConnected, getTradovateStatus, placeBracketOrder } from "./tradovate";
import { enqueueSignal } from "./supabase";
import { sendToCrossTrade } from "./services/crosstrade";
import { randomBytes } from "crypto";

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_BASE = "https://api.polygon.io";

const LIVE_CONFLUENCE_MIN = 8;
const MAX_RISK_PCT = 0.01;
const DAILY_LOSS_LIMIT_PCT = -0.03;
const DEFAULT_ACCOUNT_SIZE = 50000;

let dailyPnlTracker = 0;
let dailyPnlDate = new Date().toDateString();

function resetDailyPnlIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyPnlDate) {
    dailyPnlTracker = 0;
    dailyPnlDate = today;
    console.log("[safety] Daily P&L tracker reset for new trading day");
  }
}

function isDailyLossLimitHit(accountSize: number = DEFAULT_ACCOUNT_SIZE): boolean {
  resetDailyPnlIfNeeded();
  const limitDollars = accountSize * DAILY_LOSS_LIMIT_PCT;
  if (dailyPnlTracker <= limitDollars) {
    console.log(`[safety] DAILY LOSS LIMIT HIT: $${dailyPnlTracker.toFixed(2)} <= ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(1)}% of $${accountSize} ($${limitDollars.toFixed(2)})`);
    return true;
  }
  return false;
}

function isRiskTooHigh(riskDollars: number, accountSize: number = DEFAULT_ACCOUNT_SIZE): boolean {
  const maxRiskDollars = accountSize * MAX_RISK_PCT;
  if (riskDollars > maxRiskDollars) {
    console.log(`[safety] RISK TOO HIGH: $${riskDollars.toFixed(2)} > ${(MAX_RISK_PCT * 100).toFixed(1)}% of $${accountSize} ($${maxRiskDollars.toFixed(2)})`);
    return true;
  }
  return false;
}

function generateSignalId(): string {
  return `sig-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

const APEX_RULES = {
  dailyLossLimit: -0.03,
  rthOnly: true,
  rthStart: { hour: 9, minute: 30 },
  rthEnd: { hour: 16, minute: 0 },
  maxContracts: 10,
  minTradeDays: 5,
  profitTarget: 1000,
};

function isRTH(now?: Date): boolean {
  const d = now || new Date();
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = et.getHours();
  const m = et.getMinutes();
  const totalMin = h * 60 + m;
  const startMin = APEX_RULES.rthStart.hour * 60 + APEX_RULES.rthStart.minute;
  const endMin = APEX_RULES.rthEnd.hour * 60 + APEX_RULES.rthEnd.minute;
  return totalMin >= startMin && totalMin < endMin;
}

function checkApexRules(direction: string, qty: number, accountSize: number = DEFAULT_ACCOUNT_SIZE): { allowed: boolean; reason?: string; adjustedQty: number } {
  if (isDailyLossLimitHit(accountSize)) {
    return { allowed: false, reason: "Apex daily loss limit hit", adjustedQty: qty };
  }
  if (APEX_RULES.rthOnly && !isRTH()) {
    const now = new Date();
    const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
    return { allowed: false, reason: `Outside RTH (${etStr} ET)`, adjustedQty: qty };
  }
  let adjQty = qty;
  if (adjQty > APEX_RULES.maxContracts) {
    console.log(`[apex] Size limit enforced: qty ${adjQty} → ${APEX_RULES.maxContracts}`);
    adjQty = APEX_RULES.maxContracts;
  }
  return { allowed: true, adjustedQty: adjQty };
}

export { isRTH, checkApexRules, APEX_RULES };

export function forwardSignalToSupabase(payload: { symbol: string; direction: string; entryPrice: number; stopLoss: number; takeProfit: number; riskReward: string; confluence: number; pattern: string; qty?: number; source?: string }): Promise<{ status: string; signalId: string }> {
  const signalId = generateSignalId();
  const dir = (payload.direction === "Long" || payload.direction === "LONG") ? "BUY" : "SELL";

  console.log(`[trader] Queuing signal ${signalId} to Supabase: ${dir} ${payload.symbol} qty=${payload.qty || 1} @ ${payload.entryPrice} | SL: ${payload.stopLoss} TP: ${payload.takeProfit} | ${payload.pattern} (confluence: ${payload.confluence}) | R:R ${payload.riskReward}`);

  return enqueueSignal({
    signalId,
    symbol: payload.symbol,
    direction: dir,
    qty: payload.qty || 1,
    orderType: "MARKET",
    entryPrice: payload.entryPrice,
    stopLoss: payload.stopLoss,
    takeProfit: payload.takeProfit,
    pattern: payload.pattern,
    confluence: payload.confluence,
    riskReward: payload.riskReward,
  });
}

function emitTradeSignal(symbol: string, direction: "LONG" | "SHORT", entry: number, stop: number, target: number, rewardRatio: number, confluence: number, pattern: string, account: string): void {
  if (!account.toUpperCase().startsWith("SIM") && process.env.ALLOW_LIVE_TRADES !== "true") {
    console.warn(`[safety] BLOCKED: Non-SIM account "${account}" requires ALLOW_LIVE_TRADES=true`);
    return;
  }

  const apexCheck = checkApexRules(direction, 1);
  if (!apexCheck.allowed) {
    console.warn(`[apex] BLOCKED: ${apexCheck.reason} — ${direction} ${symbol} ${pattern}`);
    return;
  }

  const signalId = generateSignalId();
  const dir = direction === "LONG" ? "BUY" : "SELL";
  const instrument = getNTInstrument(symbol);

  const signalPayload = {
    symbol: instrument,
    direction: dir === "BUY" ? "Long" : "Short",
    quantity: apexCheck.adjustedQty,
    account,
    strategy: pattern,
    entry_price: entry,
    sl: stop,
    tp: target,
    rr: `1:${rewardRatio}`,
    timestamp: new Date().toISOString(),
  };

  console.log(`[trader] Signal queued to Supabase + CrossTrade for account ${account}: ${JSON.stringify(signalPayload)}`);

  enqueueSignal({
    signalId,
    symbol: instrument,
    direction: dir,
    qty: 1,
    orderType: "MARKET",
    entryPrice: entry,
    stopLoss: stop,
    takeProfit: target,
    pattern,
    confluence,
    riskReward: `1:${rewardRatio}`,
    accountHint: account,
  }).catch((err) => {
    console.error(`[trader] Failed to queue signal ${signalId}: ${err.message}`);
  });

  sendToCrossTrade({ symbol: instrument, direction: dir, orderType: "MARKET", account })
    .then((res) => {
      if (res.success) {
        console.log(`[trader] CrossTrade order sent: ${dir} ${instrument} → ${res.message}`);
      } else {
        console.warn(`[trader] CrossTrade skipped: ${res.message}`);
      }
    })
    .catch((err) => {
      console.error(`[trader] CrossTrade error: ${err.message}`);
    });
}

interface PolygonPrice {
  price: number;
  volume: number;
  timestamp: number;
}

const lastPolygonFetch: Record<string, { price: PolygonPrice; fetchedAt: number }> = {};

const SPY_TO_ES_RATIO = 7.8;
let polygonErrorCount = 0;
let polygonBackoffUntil = 0;

interface FuturesSpec {
  name: string;
  basePrice: number;
  pointValue: number;
  tickSize: number;
  volatility: number;
  avgVolume: number;
  category: string;
}

const FUTURES_SPECS: Record<string, FuturesSpec> = {
  ES:  { name: "E-mini S&P 500",     basePrice: 5400, pointValue: 50,    tickSize: 0.25,  volatility: 1.2, avgVolume: 2000, category: "equity" },
  MES: { name: "Micro E-mini S&P",   basePrice: 5400, pointValue: 5,     tickSize: 0.25,  volatility: 1.2, avgVolume: 1500, category: "equity" },
  NQ:  { name: "E-mini Nasdaq 100",  basePrice: 19200,pointValue: 20,    tickSize: 0.25,  volatility: 1.8, avgVolume: 1800, category: "equity" },
  MNQ: { name: "Micro E-mini Nasdaq",basePrice: 19200,pointValue: 2,     tickSize: 0.25,  volatility: 1.8, avgVolume: 1400, category: "equity" },
  YM:  { name: "E-mini Dow",         basePrice: 39500,pointValue: 5,     tickSize: 1.0,   volatility: 1.0, avgVolume: 1200, category: "equity" },
  MYM: { name: "Micro E-mini Dow",   basePrice: 39500,pointValue: 0.50,  tickSize: 1.0,   volatility: 1.0, avgVolume: 1000, category: "equity" },
  RTY: { name: "E-mini Russell 2000",basePrice: 2050, pointValue: 50,    tickSize: 0.10,  volatility: 1.5, avgVolume: 1000, category: "equity" },
  M2K: { name: "Micro Russell 2000", basePrice: 2050, pointValue: 5,     tickSize: 0.10,  volatility: 1.5, avgVolume: 800,  category: "equity" },
  CL:  { name: "Crude Oil",          basePrice: 72,   pointValue: 1000,  tickSize: 0.01,  volatility: 0.8, avgVolume: 2500, category: "energy" },
  MCL: { name: "Micro Crude Oil",    basePrice: 72,   pointValue: 100,   tickSize: 0.01,  volatility: 0.8, avgVolume: 1500, category: "energy" },
  GC:  { name: "Gold",               basePrice: 2650, pointValue: 100,   tickSize: 0.10,  volatility: 1.0, avgVolume: 2000, category: "metals" },
  MGC: { name: "Micro Gold",         basePrice: 2650, pointValue: 10,    tickSize: 0.10,  volatility: 1.0, avgVolume: 1500, category: "metals" },
  SI:  { name: "Silver",             basePrice: 31,   pointValue: 5000,  tickSize: 0.005, volatility: 1.5, avgVolume: 1200, category: "metals" },
  HG:  { name: "Copper",             basePrice: 4.2,  pointValue: 25000, tickSize: 0.0005,volatility: 1.0, avgVolume: 1000, category: "metals" },
  PL:  { name: "Platinum",           basePrice: 980,  pointValue: 50,    tickSize: 0.10,  volatility: 1.2, avgVolume: 600,  category: "metals" },
  PA:  { name: "Palladium",          basePrice: 1050, pointValue: 100,   tickSize: 0.05,  volatility: 2.0, avgVolume: 400,  category: "metals" },
  BTC: { name: "Bitcoin Futures",    basePrice: 97000,pointValue: 5,     tickSize: 5.0,   volatility: 3.0, avgVolume: 800,  category: "crypto" },
  ETH: { name: "Ether Futures",      basePrice: 3400, pointValue: 50,    tickSize: 0.25,  volatility: 3.5, avgVolume: 600,  category: "crypto" },
  ZB:  { name: "30-Year T-Bond",     basePrice: 118,  pointValue: 1000,  tickSize: 0.03125,volatility:0.4,avgVolume: 1500, category: "bonds" },
  ZN:  { name: "10-Year T-Note",     basePrice: 110,  pointValue: 1000,  tickSize: 0.015625,volatility:0.3,avgVolume:2000, category: "bonds" },
  ZT:  { name: "2-Year T-Note",      basePrice: 103,  pointValue: 2000,  tickSize: 0.0078125,volatility:0.15,avgVolume:1500,category: "bonds" },
  ZF:  { name: "5-Year T-Note",      basePrice: 107,  pointValue: 1000,  tickSize: 0.0078125,volatility:0.2,avgVolume:1800, category: "bonds" },
  ZC:  { name: "Corn",               basePrice: 450,  pointValue: 50,    tickSize: 0.25,  volatility: 0.8, avgVolume: 1500, category: "ags" },
  ZS:  { name: "Soybeans",           basePrice: 1020, pointValue: 50,    tickSize: 0.25,  volatility: 1.0, avgVolume: 1200, category: "ags" },
  ZW:  { name: "Wheat",              basePrice: 560,  pointValue: 50,    tickSize: 0.25,  volatility: 1.2, avgVolume: 1000, category: "ags" },
};

function getSpec(market: string): FuturesSpec {
  return FUTURES_SPECS[market] || FUTURES_SPECS["ES"];
}

function getNTInstrument(symbol: string): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear() % 100;
  const contractMonths: Record<string, number[]> = {
    quarterly: [3, 6, 9, 12],
    monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  };
  const quarterlySymbols = ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K", "ZB", "ZN", "ZT", "ZF"];
  const months = quarterlySymbols.includes(symbol) ? contractMonths.quarterly : contractMonths.monthly;
  let contractMonth = months.find(m => m > month + 1) || months[0];
  let contractYear = year;
  if (contractMonth <= month + 1) contractYear = year + 1;
  const mm = String(contractMonth).padStart(2, "0");
  const specific = `${symbol} ${mm}-${contractYear}`;
  const continuous = `${symbol} 1!`;
  const useContinuous = process.env.NT_USE_CONTINUOUS === "true";
  return useContinuous ? continuous : specific;
}

function getNTInstrumentContinuous(symbol: string): string {
  return `${symbol} 1!`;
}

export { getNTInstrument };

function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

async function fetchPolygonPrice(market: string): Promise<PolygonPrice | null> {
  if (!POLYGON_API_KEY) return null;

  const now = Date.now();
  if (now < polygonBackoffUntil) return null;

  const cacheKey = "SPY_BASE";
  const cached = lastPolygonFetch[cacheKey];
  if (cached && now - cached.fetchedAt < 6000) {
    const esPrice = r2(cached.price.price * SPY_TO_ES_RATIO);
    return { price: esPrice, volume: cached.price.volume, timestamp: now };
  }

  try {
    const tradeUrl = `${POLYGON_BASE}/v2/last/trade/SPY?apiKey=${POLYGON_API_KEY}`;
    const resp = await fetchWithTimeout(tradeUrl);
    if (resp.status === 429) {
      polygonErrorCount++;
      polygonBackoffUntil = now + Math.min(60000, polygonErrorCount * 15000);
      return null;
    }
    if (resp.ok) {
      const data = await resp.json();
      if (data?.results?.p) {
        polygonErrorCount = 0;
        const spyPrice = data.results.p;
        const volume = 5000;
        lastPolygonFetch[cacheKey] = { price: { price: spyPrice, volume, timestamp: now }, fetchedAt: now };
        const esPrice = r2(spyPrice * SPY_TO_ES_RATIO);
        return { price: esPrice, volume, timestamp: now };
      }
    }
  } catch {}

  try {
    const aggUrl = `${POLYGON_BASE}/v2/aggs/ticker/SPY/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`;
    const resp = await fetchWithTimeout(aggUrl);
    if (resp.status === 429) {
      polygonErrorCount++;
      polygonBackoffUntil = now + Math.min(60000, polygonErrorCount * 15000);
      return null;
    }
    if (resp.ok) {
      const data = await resp.json();
      if (data?.results?.length > 0) {
        polygonErrorCount = 0;
        const r = data.results[0];
        const spyPrice = r.c;
        const volume = Math.round((r.v || 50000) / 100);
        lastPolygonFetch[cacheKey] = { price: { price: spyPrice, volume, timestamp: now }, fetchedAt: now };
        const esPrice = r2(spyPrice * SPY_TO_ES_RATIO);
        return { price: esPrice, volume, timestamp: now };
      }
    }
  } catch {}

  return null;
}

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
  trail: number | null;
  pnl: number | null;
  cumPnl: number;
  volume: number | null;
  bias: string | null;
  confluence: number | null;
  confluenceLabel: string | null;
  sentiment: string | null;
  dataSource: string | null;
  volumeType: string | null;
  reason: string | null;
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
  range: number;
}

interface OpenTrade {
  entry: number;
  stop: number;
  target: number;
  trail: number;
  initialStop: number;
  market: string;
  timeframe: string;
  pattern: string;
  direction: "LONG" | "SHORT";
  riskPoints: number;
  highSinceEntry: number;
  lowSinceEntry: number;
  barsSinceEntry: number;
  trailActivated: boolean;
  confluence: number;
  confluenceLabel: string;
  entryReason: string;
  checklist: { patternMatch: boolean; volumeConfirmation: boolean; maRespect: boolean; priorPivotSR: boolean; barFormation: boolean };
}

interface MarketState {
  price: number;
  bias: "UPTREND" | "DOWNTREND" | "SIDEWAYS";
  biasStrength: number;
  ema9: number;
  ema21: number;
  sma200: number;
  pivotHigh: number;
  pivotLow: number;
  pivotHighAge: number;
  pivotLowAge: number;
  priorPivotHigh: number;
  priorPivotLow: number;
  volatility: number;
  trendDuration: number;
  consecutiveBars: number;
  lastBarDirection: boolean;
  avgVolume: number;
  sentiment: "BUYERS_CONTROL" | "SELLERS_CONTROL" | "NEUTRAL";
  recentSwingHigh: number;
  recentSwingLow: number;
  higherPivotHighs: number;
  higherPivotLows: number;
  lowerPivotHighs: number;
  lowerPivotLows: number;
}

interface TraderSession {
  id: string;
  running: boolean;
  markets: string[];
  timeframes: string[];
  riskDollars: number;
  rewardRatio: number;
  maxOpenTrades: number;
  account: string;
  patterns: string[];
  customCondition: string;
  forceTrading: boolean;
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

const TF_TICKS: Record<string, number> = { "2min": 1, "5min": 2, "15min": 4, "1hour": 8, "4hour": 24, "daily": 60 };

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].running && now - sessions[id].createdAt > 3600000) delete sessions[id];
  }
}, 60000);

function isTradingHours(): boolean {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = est.getDay();
  const t = est.getHours() * 60 + est.getMinutes();
  if (day === 6) return false;
  if (day === 0 && t < 1080) return false;
  if (day === 5 && t >= 1020) return false;
  if (t >= 1020 && t < 1080) return false;
  return true;
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

function makeBar(open: number, close: number, vol: number, priceScale: number = 1): Bar {
  const spread = Math.abs(close - open);
  const wickNoise = Math.max(0.01, spread * 0.5 + priceScale * 0.001);
  const high = r2(Math.max(open, close) + rand(priceScale * 0.0001, wickNoise));
  const low = r2(Math.min(open, close) - rand(priceScale * 0.0001, wickNoise));
  const bullish = close >= open;
  const body = Math.abs(close - open);
  const tail = bullish ? (open - low) : (close - low);
  const wick = bullish ? (high - close) : (high - open);
  const range = high - low;
  return { open: r2(open), high, low, close: r2(close), volume: vol, tail: r2(tail), wick: r2(wick), body: r2(body), bullish, range: r2(range) };
}

function initMarketState(market: string): MarketState {
  const spec = getSpec(market);
  const pctRange = spec.basePrice * 0.01;
  const base = r2(spec.basePrice + rand(-pctRange, pctRange));
  const pivotRange = spec.basePrice * 0.003;
  const swingRange = spec.basePrice * 0.002;
  const biases: Array<"UPTREND" | "DOWNTREND" | "SIDEWAYS"> = ["UPTREND", "DOWNTREND", "SIDEWAYS"];
  return {
    price: base, bias: biases[Math.floor(Math.random() * 3)],
    biasStrength: rand(0.3, 0.8), ema9: base, ema21: base, sma200: r2(base - rand(-pctRange * 0.5, pctRange * 0.5)),
    pivotHigh: r2(base + rand(pivotRange * 0.5, pivotRange * 1.5)), pivotLow: r2(base - rand(pivotRange * 0.5, pivotRange * 1.5)),
    pivotHighAge: 0, pivotLowAge: 0,
    priorPivotHigh: r2(base + rand(pivotRange, pivotRange * 2.5)), priorPivotLow: r2(base - rand(pivotRange, pivotRange * 2.5)),
    volatility: rand(0.3, 1.5) * spec.volatility, trendDuration: 0,
    consecutiveBars: 0, lastBarDirection: true,
    avgVolume: spec.avgVolume, sentiment: "NEUTRAL",
    recentSwingHigh: r2(base + rand(swingRange * 0.5, swingRange * 1.5)), recentSwingLow: r2(base - rand(swingRange * 0.5, swingRange * 1.5)),
    higherPivotHighs: 0, higherPivotLows: 0,
    lowerPivotHighs: 0, lowerPivotLows: 0,
  };
}

function updateTrendFromPivots(state: MarketState) {
  if (state.higherPivotHighs >= 2 && state.higherPivotLows >= 2) {
    state.bias = "UPTREND";
    state.biasStrength = Math.min(1.0, (state.higherPivotHighs + state.higherPivotLows) * 0.15);
  } else if (state.lowerPivotHighs >= 2 && state.lowerPivotLows >= 2) {
    state.bias = "DOWNTREND";
    state.biasStrength = Math.min(1.0, (state.lowerPivotHighs + state.lowerPivotLows) * 0.15);
  } else {
    state.bias = "SIDEWAYS";
    state.biasStrength = rand(0.1, 0.4);
  }
}

function generateBar(state: MarketState, market: string = "ES", livePrice?: PolygonPrice | null): Bar {
  const spec = getSpec(market);
  const scale = spec.basePrice / 5400;
  state.trendDuration++;
  state.pivotHighAge++;
  state.pivotLowAge++;

  if (livePrice && (market === "ES" || market === "MES")) {
    const basePrice = livePrice.price;
    const open = state.price;
    const greedBias = state.sentiment === "BUYERS_CONTROL" ? rand(0.3, 1.0) * scale : state.sentiment === "SELLERS_CONTROL" ? -rand(0.3, 1.0) * scale : 0;
    const tickNoise = rand(-2.5, 2.5) * scale * (state.volatility || 1.0) + greedBias;
    const close = r2(basePrice + tickNoise);
    const volume = Math.round(livePrice.volume / 500) || Math.round(rand(800, 3000));

    if (state.trendDuration > rand(12, 35)) {
      state.volatility = rand(0.3, 1.5) * spec.volatility;
      state.trendDuration = 0;
    }

    const bar = makeBar(open, close, volume, spec.basePrice);
    updateMarketState(state, bar, close, volume);
    return bar;
  }

  if (state.trendDuration > rand(12, 35)) {
    const biases: Array<"UPTREND" | "DOWNTREND" | "SIDEWAYS"> = ["UPTREND", "DOWNTREND", "SIDEWAYS"];
    state.bias = biases[Math.floor(Math.random() * 3)];
    state.biasStrength = rand(0.3, 0.8);
    state.trendDuration = 0;
    state.volatility = rand(0.3, 1.5) * spec.volatility;
  }

  let drift = 0;
  if (state.bias === "UPTREND") drift = rand(0.1, 1.5) * scale * state.biasStrength;
  else if (state.bias === "DOWNTREND") drift = -rand(0.1, 1.5) * scale * state.biasStrength;
  else drift = rand(-0.5, 0.5) * scale * 0.3;

  const meanRev = (state.ema21 - state.price) * 0.025;
  drift += meanRev;

  if (state.consecutiveBars >= 7) {
    drift += state.lastBarDirection ? -rand(1, 3) * scale : rand(1, 3) * scale;
  }

  const greedBiasSim = state.sentiment === "BUYERS_CONTROL" ? rand(0.3, 1.2) * scale : state.sentiment === "SELLERS_CONTROL" ? -rand(0.3, 1.2) * scale : 0;
  const noise = rand(-2.5, 2.5) * scale * state.volatility + greedBiasSim;
  let move = drift + noise;

  const isClimax = Math.random() < 0.04;
  if (isClimax) move *= rand(2.5, 4.0);

  const open = state.price;
  const close = r2(open + move);

  const avgVol = spec.avgVolume;
  let volume = Math.round(rand(avgVol * 0.5, avgVol * 1.5));
  if (isClimax) volume = Math.round(volume * rand(3, 6));
  if (Math.abs(move) > 3 * scale) volume = Math.round(volume * rand(1.5, 2.5));
  if (state.bias === "UPTREND" && close > open) volume = Math.round(volume * 1.3);
  if (state.bias === "DOWNTREND" && close < open) volume = Math.round(volume * 1.3);
  const pivotProximity = spec.basePrice * 0.0004;
  if (Math.abs(state.price - state.pivotHigh) < pivotProximity || Math.abs(state.price - state.pivotLow) < pivotProximity) {
    volume = Math.round(volume * rand(1.3, 1.8));
  }

  const bar = makeBar(open, close, volume, spec.basePrice);
  updateMarketState(state, bar, close, volume);
  return bar;
}

function updateMarketState(state: MarketState, bar: Bar, close: number, volume: number) {
  state.price = close;
  state.ema9 = r2((state.ema9 * 8 + close) / 9);
  state.ema21 = r2((state.ema21 * 20 + close) / 21);
  state.sma200 = r2((state.sma200 * 199 + close) / 200);
  state.avgVolume = Math.round((state.avgVolume * 14 + volume) / 15);

  if (bar.high > state.recentSwingHigh) state.recentSwingHigh = bar.high;
  if (bar.low < state.recentSwingLow) state.recentSwingLow = bar.low;

  if (bar.high > state.pivotHigh) {
    const prevPH = state.pivotHigh;
    state.priorPivotHigh = prevPH;
    state.pivotHigh = bar.high;
    state.pivotHighAge = 0;
    if (bar.high > prevPH) {
      state.higherPivotHighs++;
      state.lowerPivotHighs = Math.max(0, state.lowerPivotHighs - 1);
    } else {
      state.lowerPivotHighs++;
      state.higherPivotHighs = Math.max(0, state.higherPivotHighs - 1);
    }
  }
  if (bar.low < state.pivotLow) {
    const prevPL = state.pivotLow;
    state.priorPivotLow = prevPL;
    state.pivotLow = bar.low;
    state.pivotLowAge = 0;
    if (bar.low < prevPL) {
      state.lowerPivotLows++;
      state.higherPivotLows = Math.max(0, state.higherPivotLows - 1);
    } else {
      state.higherPivotLows++;
      state.lowerPivotLows = Math.max(0, state.lowerPivotLows - 1);
    }
  }
  if (Math.random() < 0.06) {
    state.priorPivotHigh = state.pivotHigh;
    state.pivotHigh = bar.high;
    state.pivotHighAge = 0;
  }
  if (Math.random() < 0.06) {
    state.priorPivotLow = state.pivotLow;
    state.pivotLow = bar.low;
    state.pivotLowAge = 0;
  }

  if (bar.bullish === state.lastBarDirection) { state.consecutiveBars++; }
  else { state.consecutiveBars = 1; state.lastBarDirection = bar.bullish; }

  if (state.consecutiveBars >= 3 && bar.bullish) state.sentiment = "BUYERS_CONTROL";
  else if (state.consecutiveBars >= 3 && !bar.bullish) state.sentiment = "SELLERS_CONTROL";
  else if (state.consecutiveBars < 2) state.sentiment = "NEUTRAL";

  if (state.pivotHighAge > 8 && state.pivotLowAge > 8) {
    updateTrendFromPivots(state);
  }
}

function hasBottomingTail(bar: Bar): boolean {
  return bar.tail > bar.body * 1.5 && bar.tail > bar.range * 0.25;
}

function hasToppingTail(bar: Bar): boolean {
  return bar.wick > bar.body * 1.5 && bar.wick > bar.range * 0.25;
}

function isWideRangeBar(bar: Bar, avgRange: number): boolean {
  return bar.range > avgRange * 1.5;
}

function isNarrowRangeBar(bar: Bar, avgRange: number): boolean {
  return bar.range < avgRange * 0.5;
}

function getAvgRange(bars: Bar[]): number {
  if (bars.length < 3) return 1;
  return bars.reduce((s, b) => s + b.range, 0) / bars.length;
}

function distanceFromMA(price: number, ma: number): number {
  if (ma === 0) return 0;
  return Math.abs(price - ma) / ma;
}

function isExtendedFromMA(price: number, ma: number): boolean {
  return distanceFromMA(price, ma) > 0.015;
}

function classifyVolume(bars: Bar[], avgVol: number): "IGNITING" | "ENDING" | "RESTING" | "NORMAL" {
  if (bars.length < 3) return "NORMAL";
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const avgRange = getAvgRange(bars.slice(-10));

  const isExtendedMove = countConsecutiveDown(bars) >= 5 || countConsecutiveUp(bars) >= 5;
  if (isExtendedMove && curr.volume > avgVol * 2.5 && isWideRangeBar(curr, avgRange)) {
    return "ENDING";
  }

  if (curr.volume > avgVol * 1.5 && curr.volume > prev.volume * 1.3) {
    return "IGNITING";
  }

  if (curr.volume < avgVol * 0.6 && isNarrowRangeBar(curr, avgRange)) {
    return "RESTING";
  }

  return "NORMAL";
}

function isEndingVolume(bars: Bar[], avgVol: number): boolean {
  return classifyVolume(bars, avgVol) === "ENDING";
}

function isIgnitingVolume(bars: Bar[], avgVol: number): boolean {
  return classifyVolume(bars, avgVol) === "IGNITING";
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

function hasLargeBars(bars: Bar[], count: number): boolean {
  const recent = bars.slice(-count);
  const avgRange = getAvgRange(recent);
  const largeBars = recent.filter(b => b.range > avgRange * 1.5);
  return largeBars.length >= Math.ceil(count * 0.4);
}

function hasMultipleWideRangeBars(bars: Bar[]): boolean {
  const recent = bars.slice(-7);
  const avgRange = getAvgRange(recent);
  return recent.filter(b => isWideRangeBar(b, avgRange)).length >= 3;
}

function isNearMA(price: number, ma: number): boolean {
  return distanceFromMA(price, ma) < 0.003;
}

function isNearPivot(price: number, pivot: number, basePrice: number): boolean {
  return Math.abs(price - pivot) < basePrice * 0.0015;
}

function calcConfluence(factors: boolean[]): number {
  return factors.filter(Boolean).length;
}

function confluenceDescription(score: number, total: number): string {
  const pct = score / total;
  if (pct >= 0.8) return `${score}/${total} - A+ Setup`;
  if (pct >= 0.65) return `${score}/${total} - High Probability`;
  if (pct >= 0.5) return `${score}/${total} - Moderate`;
  if (pct >= 0.35) return `${score}/${total} - Low Odds`;
  return `${score}/${total} - Weak`;
}

function barFormationQuality(bar: Bar, direction: "LONG" | "SHORT"): number {
  let quality = 0;
  if (direction === "LONG") {
    if (bar.bullish) quality += 2;
    if (hasBottomingTail(bar)) quality += 2;
    if (bar.body > bar.range * 0.5) quality += 1;
    if (bar.wick < bar.body * 0.3) quality += 1;
  } else {
    if (!bar.bullish) quality += 2;
    if (hasToppingTail(bar)) quality += 2;
    if (bar.body > bar.range * 0.5) quality += 1;
    if (bar.tail < bar.body * 0.3) quality += 1;
  }
  return quality;
}

function howDidItGetHere(bars: Bar[], direction: "LONG" | "SHORT"): { barsInMove: number; hasLargeAcceleration: boolean; isExtended: boolean } {
  const barsInMove = direction === "LONG" ? countConsecutiveDown(bars) : countConsecutiveUp(bars);
  const recent = bars.slice(-(barsInMove + 1));
  const avgRange = getAvgRange(bars);
  const hasLargeAcceleration = recent.filter(b => isWideRangeBar(b, avgRange)).length >= Math.max(2, barsInMove * 0.4);
  const isExtended = barsInMove >= 5;
  return { barsInMove, hasLargeAcceleration, isExtended };
}

function detect3BarPlayBuy(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 5) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const b = bars.slice(-5);
  const [b0, b1, b2, b3, b4] = b;
  const threeDown = !b1.bullish && !b2.bullish && !b3.bullish;
  const reversal = b4.bullish && b4.close > b3.high;
  const volumeIncrease = b4.volume > b3.volume * 1.2;
  const avgRange = getAvgRange(bars);

  if (threeDown && reversal) {
    const context = howDidItGetHere(bars, "LONG");
    const quality = barFormationQuality(b4, "LONG");
    const factors = [
      volumeIncrease,
      b4.close > state.ema9,
      b4.close > state.ema21,
      b4.close > state.sma200,
      hasBottomingTail(b3) || hasBottomingTail(b4),
      isNearMA(b4.close, state.ema21) || isNearMA(b4.close, state.ema9),
      state.bias !== "DOWNTREND",
      isNearPivot(state.price, state.pivotLow, state.price) || isNearPivot(state.price, state.priorPivotLow, state.price),
      quality >= 4,
      b4.volume > state.avgVolume,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [];
    if (volumeIncrease) reasons.push("vol spike on reversal");
    if (hasBottomingTail(b3) || hasBottomingTail(b4)) reasons.push("bottoming tail");
    if (b4.bullish) reasons.push("green bar");
    if (isNearMA(b4.close, state.ema21)) reasons.push("at 21 EMA");
    if (isNearPivot(state.price, state.pivotLow, state.price)) reasons.push("at pivot support");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 4).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detect3BarPlaySell(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 5) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const b = bars.slice(-5);
  const [b0, b1, b2, b3, b4] = b;
  const threeUp = b1.bullish && b2.bullish && b3.bullish;
  const reversal = !b4.bullish && b4.close < b3.low;
  const volumeIncrease = b4.volume > b3.volume * 1.2;

  if (threeUp && reversal) {
    const quality = barFormationQuality(b4, "SHORT");
    const factors = [
      volumeIncrease,
      b4.close < state.ema9,
      b4.close < state.ema21,
      b4.close < state.sma200,
      hasToppingTail(b3) || hasToppingTail(b4),
      isNearMA(b4.close, state.ema21) || isNearMA(b4.close, state.ema9),
      state.bias !== "UPTREND",
      isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.priorPivotHigh, state.price),
      quality >= 4,
      b4.volume > state.avgVolume,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [];
    if (volumeIncrease) reasons.push("vol spike on reversal");
    if (hasToppingTail(b3) || hasToppingTail(b4)) reasons.push("topping tail");
    if (!b4.bullish) reasons.push("red bar");
    if (isNearMA(b4.close, state.ema21)) reasons.push("at 21 EMA");
    if (isNearPivot(state.price, state.pivotHigh, state.price)) reasons.push("at pivot resistance");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 4).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectBuySetup(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 6) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const recent = bars.slice(-6);
  const curr = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const low = Math.min(...recent.map(b => b.low));

  if (prev.low <= low * 1.002 && curr.close > prev.high && curr.bullish) {
    const context = howDidItGetHere(bars, "LONG");
    const quality = barFormationQuality(curr, "LONG");
    const factors = [
      curr.bullish,
      hasBottomingTail(prev) || hasBottomingTail(curr),
      curr.volume > state.avgVolume,
      isIgnitingVolume(bars, state.avgVolume),
      isNearPivot(prev.low, state.pivotLow, state.price) || isNearPivot(prev.low, state.priorPivotLow, state.price),
      isNearMA(prev.low, state.ema21) || isNearMA(prev.low, state.ema9),
      countConsecutiveDown(bars) >= 3,
      hasMultipleWideRangeBars(bars),
      curr.close > state.ema9,
      state.bias === "UPTREND" || state.bias === "SIDEWAYS",
      quality >= 3,
      context.barsInMove >= 5,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [];
    if (context.barsInMove >= 5) reasons.push(`${context.barsInMove} bars down`);
    if (hasMultipleWideRangeBars(bars)) reasons.push("wide range bars");
    if (isNearPivot(prev.low, state.pivotLow, state.price)) reasons.push("at pivot support");
    if (curr.volume > state.avgVolume) reasons.push("increased volume");
    if (curr.bullish) reasons.push("green bar");
    if (hasBottomingTail(prev)) reasons.push("bottoming tail");
    if (isNearMA(prev.low, state.ema21)) reasons.push("at 21 EMA");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectSellSetup(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 6) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const recent = bars.slice(-6);
  const curr = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const high = Math.max(...recent.map(b => b.high));

  if (prev.high >= high * 0.998 && curr.close < prev.low && !curr.bullish) {
    const context = howDidItGetHere(bars, "SHORT");
    const quality = barFormationQuality(curr, "SHORT");
    const factors = [
      !curr.bullish,
      hasToppingTail(prev) || hasToppingTail(curr),
      curr.volume > state.avgVolume,
      isIgnitingVolume(bars, state.avgVolume),
      isNearPivot(prev.high, state.pivotHigh, state.price) || isNearPivot(prev.high, state.priorPivotHigh, state.price),
      isNearMA(prev.high, state.ema21) || isNearMA(prev.high, state.ema9),
      countConsecutiveUp(bars) >= 3,
      hasMultipleWideRangeBars(bars),
      curr.close < state.ema9,
      state.bias === "DOWNTREND" || state.bias === "SIDEWAYS",
      quality >= 3,
      context.barsInMove >= 5,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [];
    if (context.barsInMove >= 5) reasons.push(`${context.barsInMove} bars up`);
    if (hasMultipleWideRangeBars(bars)) reasons.push("wide range bars");
    if (isNearPivot(prev.high, state.pivotHigh, state.price)) reasons.push("at pivot resistance");
    if (curr.volume > state.avgVolume) reasons.push("increased volume");
    if (!curr.bullish) reasons.push("red bar");
    if (hasToppingTail(prev)) reasons.push("topping tail");
    if (isNearMA(prev.high, state.ema21)) reasons.push("at 21 EMA");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectBreakoutLong(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 3) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const avgRange = getAvgRange(bars);
  const breaksPriorPivot = curr.close > state.priorPivotHigh && prev.close <= state.priorPivotHigh;
  const breaksCurrentPivot = curr.close > state.pivotHigh && prev.close <= state.pivotHigh;

  if (breaksPriorPivot || breaksCurrentPivot) {
    if (!curr.bullish) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
    const factors = [
      isIgnitingVolume(bars, state.avgVolume),
      curr.close > state.ema21,
      curr.close > state.ema9,
      curr.close > state.sma200,
      state.bias !== "DOWNTREND",
      isWideRangeBar(curr, avgRange),
      state.pivotHighAge > 5,
      curr.volume > state.avgVolume * 1.3,
      barFormationQuality(curr, "LONG") >= 3,
      breaksPriorPivot,
    ];
    const conf = calcConfluence(factors);
    const pivot = breaksPriorPivot ? "prior pivot" : "current pivot";
    const reasons: string[] = [`breaks ${pivot}`];
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    if (curr.close > state.ema21) reasons.push("above 21 EMA");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 4).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectBreakoutShort(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 3) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const avgRange = getAvgRange(bars);
  const breaksPriorPivot = curr.close < state.priorPivotLow && prev.close >= state.priorPivotLow;
  const breaksCurrentPivot = curr.close < state.pivotLow && prev.close >= state.pivotLow;

  if (breaksPriorPivot || breaksCurrentPivot) {
    if (curr.bullish) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
    const factors = [
      isIgnitingVolume(bars, state.avgVolume),
      curr.close < state.ema21,
      curr.close < state.ema9,
      curr.close < state.sma200,
      state.bias !== "UPTREND",
      isWideRangeBar(curr, avgRange),
      state.pivotLowAge > 5,
      curr.volume > state.avgVolume * 1.3,
      barFormationQuality(curr, "SHORT") >= 3,
      breaksPriorPivot,
    ];
    const conf = calcConfluence(factors);
    const pivot = breaksPriorPivot ? "prior pivot" : "current pivot";
    const reasons: string[] = [`breaks ${pivot}`];
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    if (curr.close < state.ema21) reasons.push("below 21 EMA");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 4).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectClimaxReversal(bars: Bar[], state: MarketState): { detected: boolean; direction: "LONG" | "SHORT"; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 7) return { detected: false, direction: "LONG", confluence: 0, confluenceLabel: "", reason: "" };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const downBars = countConsecutiveDown(bars);
  const upBars = countConsecutiveUp(bars);

  if (isEndingVolume(bars, state.avgVolume) && downBars >= 5 && curr.bullish && hasBottomingTail(curr)) {
    const factors = [
      downBars >= 7,
      hasLargeBars(bars, 6),
      hasMultipleWideRangeBars(bars),
      isNearPivot(state.price, state.pivotLow, state.price) || isNearPivot(state.price, state.priorPivotLow, state.price),
      curr.close > state.ema9 || isNearMA(curr.close, state.ema21),
      hasBottomingTail(prev),
      curr.volume > state.avgVolume * 3,
      isExtendedFromMA(state.price, state.ema21),
      curr.bullish,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`${downBars} bars down`, "ending volume"];
    if (hasMultipleWideRangeBars(bars)) reasons.push("large bars");
    if (isNearPivot(state.price, state.priorPivotLow, state.price)) reasons.push("at prior pivot support");
    if (hasBottomingTail(curr)) reasons.push("bottoming tail");
    if (curr.bullish) reasons.push("green bar");
    if (isExtendedFromMA(state.price, state.ema21)) reasons.push("extended from 21 EMA");
    return { detected: true, direction: "LONG", confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }

  if (isEndingVolume(bars, state.avgVolume) && upBars >= 5 && !curr.bullish && hasToppingTail(curr)) {
    const factors = [
      upBars >= 7,
      hasLargeBars(bars, 6),
      hasMultipleWideRangeBars(bars),
      isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.priorPivotHigh, state.price),
      curr.close < state.ema9 || isNearMA(curr.close, state.ema21),
      hasToppingTail(prev),
      curr.volume > state.avgVolume * 3,
      isExtendedFromMA(state.price, state.ema21),
      !curr.bullish,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`${upBars} bars up`, "ending volume"];
    if (hasMultipleWideRangeBars(bars)) reasons.push("large bars");
    if (isNearPivot(state.price, state.priorPivotHigh, state.price)) reasons.push("at prior pivot resistance");
    if (hasToppingTail(curr)) reasons.push("topping tail");
    if (!curr.bullish) reasons.push("red bar");
    if (isExtendedFromMA(state.price, state.ema21)) reasons.push("extended from 21 EMA");
    return { detected: true, direction: "SHORT", confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, direction: "LONG", confluence: 0, confluenceLabel: "", reason: "" };
}

function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function recentAvgVolume(bars: Bar[], lookback: number): number {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return 0;
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

function projectedTrendlineValue(slope: number, intercept: number, index: number): number {
  return intercept + slope * index;
}

function linearRegressionIntercept(values: number[], slope: number): number {
  const n = values.length;
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumX = (n * (n - 1)) / 2;
  return (sumY - slope * sumX) / n;
}

function isConvergingWedge(highs: number[], lows: number[]): { converging: boolean; narrowPct: number } {
  const n = highs.length;
  if (n < 10) return { converging: false, narrowPct: 0 };
  const firstThird = Math.floor(n / 3);
  const lastThird = n - firstThird;
  const earlySpan = Math.max(...highs.slice(0, firstThird)) - Math.min(...lows.slice(0, firstThird));
  const lateSpan = Math.max(...highs.slice(lastThird)) - Math.min(...lows.slice(lastThird));
  if (earlySpan === 0) return { converging: false, narrowPct: 0 };
  const narrowPct = 1 - (lateSpan / earlySpan);
  return { converging: narrowPct >= 0.2, narrowPct };
}

function detectWedgeLong(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 15) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const recent = bars.slice(-Math.min(bars.length, 30));
  const n = recent.length;
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const highSlope = linearRegressionSlope(highs);
  const lowSlope = linearRegressionSlope(lows);

  const { converging, narrowPct } = isConvergingWedge(highs, lows);
  if (!converging) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const isFallingWedge = highSlope < 0 && lowSlope < 0 && Math.abs(lowSlope) > Math.abs(highSlope);
  if (!isFallingWedge) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const curr = recent[n - 1];
  const prev = recent[n - 2];
  const highIntercept = linearRegressionIntercept(highs, highSlope);
  const projectedHighTrendline = projectedTrendlineValue(highSlope, highIntercept, n - 1);
  const breaksAboveTrendline = curr.close > projectedHighTrendline && curr.bullish;

  if (!breaksAboveTrendline) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const recentVol = recentAvgVolume(recent, 10);
  const volSurge = curr.volume > recentVol * 1.5;
  const aboveEMA21 = curr.close > state.ema21;
  const aboveEMA9 = curr.close > state.ema9;
  const avgRange = getAvgRange(bars);

  const factors = [
    volSurge,
    isIgnitingVolume(bars, state.avgVolume),
    aboveEMA21,
    aboveEMA9,
    curr.close > state.sma200,
    state.bias !== "DOWNTREND",
    hasBottomingTail(prev) || hasBottomingTail(curr),
    isWideRangeBar(curr, avgRange),
    isNearPivot(state.price, state.pivotLow, state.price) || isNearPivot(state.price, state.priorPivotLow, state.price),
    barFormationQuality(curr, "LONG") >= 3,
    narrowPct >= 0.35,
  ];
  const conf = calcConfluence(factors);
  const reasons: string[] = [`falling wedge breakout (${(narrowPct * 100).toFixed(0)}% converged)`];
  if (volSurge) reasons.push("vol surge");
  if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
  if (aboveEMA21) reasons.push("above 21 EMA");
  if (hasBottomingTail(curr)) reasons.push("bottoming tail");
  if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
  return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
}

function detectWedgeShort(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 15) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
  const recent = bars.slice(-Math.min(bars.length, 30));
  const n = recent.length;
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const highSlope = linearRegressionSlope(highs);
  const lowSlope = linearRegressionSlope(lows);

  const { converging, narrowPct } = isConvergingWedge(highs, lows);
  if (!converging) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const isRisingWedge = highSlope > 0 && lowSlope > 0 && Math.abs(highSlope) < Math.abs(lowSlope);
  if (!isRisingWedge) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const curr = recent[n - 1];
  const prev = recent[n - 2];
  const lowIntercept = linearRegressionIntercept(lows, lowSlope);
  const projectedLowTrendline = projectedTrendlineValue(lowSlope, lowIntercept, n - 1);
  const breaksBelowTrendline = curr.close < projectedLowTrendline && !curr.bullish;

  if (!breaksBelowTrendline) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const recentVol = recentAvgVolume(recent, 10);
  const volSurge = curr.volume > recentVol * 1.5;
  const belowEMA21 = curr.close < state.ema21;
  const belowEMA9 = curr.close < state.ema9;
  const avgRange = getAvgRange(bars);

  const factors = [
    volSurge,
    isIgnitingVolume(bars, state.avgVolume),
    belowEMA21,
    belowEMA9,
    curr.close < state.sma200,
    state.bias !== "UPTREND",
    hasToppingTail(prev) || hasToppingTail(curr),
    isWideRangeBar(curr, avgRange),
    isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.priorPivotHigh, state.price),
    barFormationQuality(curr, "SHORT") >= 3,
    narrowPct >= 0.35,
  ];
  const conf = calcConfluence(factors);
  const reasons: string[] = [`rising wedge breakdown (${(narrowPct * 100).toFixed(0)}% converged)`];
  if (volSurge) reasons.push("vol surge");
  if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
  if (belowEMA21) reasons.push("below 21 EMA");
  if (hasToppingTail(curr)) reasons.push("topping tail");
  if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
  return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
}

function findLocalPeaks(values: number[], dist: number): number[] {
  const peaks: number[] = [];
  for (let i = dist; i < values.length - dist; i++) {
    let isPeak = true;
    for (let j = 1; j <= dist; j++) {
      if (values[i] < values[i - j] || values[i] < values[i + j]) { isPeak = false; break; }
    }
    if (isPeak) peaks.push(i);
  }
  return peaks;
}

function findLocalTroughs(values: number[], dist: number): number[] {
  const troughs: number[] = [];
  for (let i = dist; i < values.length - dist; i++) {
    let isTrough = true;
    for (let j = 1; j <= dist; j++) {
      if (values[i] > values[i - j] || values[i] > values[i + j]) { isTrough = false; break; }
    }
    if (isTrough) troughs.push(i);
  }
  return troughs;
}

function detectCupAndHandleLong(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 25) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, 3);
  const troughs = findLocalTroughs(lows, 3);

  for (let pi = 0; pi < peaks.length - 1; pi++) {
    const leftRim = peaks[pi];
    const rightRim = peaks[pi + 1];
    const cupWidth = rightRim - leftRim;
    if (cupWidth < 10 || cupWidth > 50) continue;

    const rimDiffPct = Math.abs(highs[leftRim] - highs[rightRim]) / highs[leftRim];
    if (rimDiffPct > 0.02) continue;

    const cupTroughs = troughs.filter(t => t > leftRim && t < rightRim);
    if (cupTroughs.length === 0) continue;
    const cupBottom = cupTroughs.reduce((a, b) => lows[a] < lows[b] ? a : b);

    const cupDepth = Math.min(highs[leftRim], highs[rightRim]) - lows[cupBottom];
    const avgPrice = (highs[leftRim] + highs[rightRim]) / 2;
    if (cupDepth / avgPrice < 0.005) continue;

    const leftHalf = bars.slice(leftRim, cupBottom + 1);
    const rightHalf = bars.slice(cupBottom, rightRim + 1);
    const leftSlope = linearRegressionSlope(leftHalf.map(b => b.close));
    const rightSlope = linearRegressionSlope(rightHalf.map(b => b.close));
    if (leftSlope > 0 || rightSlope < 0) continue;

    const rimHigh = Math.max(highs[leftRim], highs[rightRim]);
    const handleEnd = Math.min(rightRim + Math.floor(cupWidth * 0.4), bars.length - 1);

    let handleLow = Infinity;
    for (let h = rightRim + 1; h <= handleEnd; h++) {
      if (bars[h].low < handleLow) handleLow = bars[h].low;
      const handleRetrace = rimHigh - handleLow;
      if (handleRetrace > cupDepth * 0.5) break;
    }

    const curr = bars[bars.length - 1];
    if (!curr.bullish || curr.close <= rimHigh) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const aboveEMA21 = curr.close > state.ema21;
    const avgRange = getAvgRange(bars);

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      aboveEMA21,
      curr.close > state.ema9,
      curr.close > state.sma200,
      state.bias !== "DOWNTREND",
      hasBottomingTail(bars[bars.length - 2]) || hasBottomingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotLow, state.price) || isNearPivot(state.price, state.priorPivotLow, state.price),
      barFormationQuality(curr, "LONG") >= 3,
      cupDepth / avgPrice >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const handlePct = handleLow < Infinity ? ((rimHigh - handleLow) / cupDepth * 100).toFixed(0) : "n/a";
    const reasons: string[] = [`cup&handle breakout (depth ${(cupDepth / avgPrice * 100).toFixed(1)}%, handle ${handlePct}%)`];
    if (volSurge) reasons.push("vol surge on breakout");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (aboveEMA21) reasons.push("above 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }

  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectInverseCupAndHandleShort(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 25) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, 3);
  const troughs = findLocalTroughs(lows, 3);

  for (let ti = 0; ti < troughs.length - 1; ti++) {
    const leftRim = troughs[ti];
    const rightRim = troughs[ti + 1];
    const cupWidth = rightRim - leftRim;
    if (cupWidth < 10 || cupWidth > 50) continue;

    const rimDiffPct = Math.abs(lows[leftRim] - lows[rightRim]) / lows[leftRim];
    if (rimDiffPct > 0.02) continue;

    const cupPeaks = peaks.filter(p => p > leftRim && p < rightRim);
    if (cupPeaks.length === 0) continue;
    const cupTop = cupPeaks.reduce((a, b) => highs[a] > highs[b] ? a : b);

    const cupDepth = highs[cupTop] - Math.max(lows[leftRim], lows[rightRim]);
    const avgPrice = (lows[leftRim] + lows[rightRim]) / 2;
    if (cupDepth / avgPrice < 0.005) continue;

    const leftHalf = bars.slice(leftRim, cupTop + 1);
    const rightHalf = bars.slice(cupTop, rightRim + 1);
    const leftSlope = linearRegressionSlope(leftHalf.map(b => b.close));
    const rightSlope = linearRegressionSlope(rightHalf.map(b => b.close));
    if (leftSlope < 0 || rightSlope > 0) continue;

    const rimLow = Math.min(lows[leftRim], lows[rightRim]);
    const handleEnd = Math.min(rightRim + Math.floor(cupWidth * 0.4), bars.length - 1);

    let handleHigh = -Infinity;
    for (let h = rightRim + 1; h <= handleEnd; h++) {
      if (bars[h].high > handleHigh) handleHigh = bars[h].high;
      const handleRetrace = handleHigh - rimLow;
      if (handleRetrace > cupDepth * 0.5) break;
    }

    const curr = bars[bars.length - 1];
    if (curr.bullish || curr.close >= rimLow) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const belowEMA21 = curr.close < state.ema21;
    const avgRange = getAvgRange(bars);

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      belowEMA21,
      curr.close < state.ema9,
      curr.close < state.sma200,
      state.bias !== "UPTREND",
      hasToppingTail(bars[bars.length - 2]) || hasToppingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.priorPivotHigh, state.price),
      barFormationQuality(curr, "SHORT") >= 3,
      cupDepth / avgPrice >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const handlePct = handleHigh > -Infinity ? ((handleHigh - rimLow) / cupDepth * 100).toFixed(0) : "n/a";
    const reasons: string[] = [`inverse cup&handle breakdown (depth ${(cupDepth / avgPrice * 100).toFixed(1)}%, handle ${handlePct}%)`];
    if (volSurge) reasons.push("vol surge on breakdown");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (belowEMA21) reasons.push("below 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }

  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectDoubleBottom(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 25) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const troughs = findLocalTroughs(lows, 3);

  for (let ti = 0; ti < troughs.length - 1; ti++) {
    const left = troughs[ti];
    const right = troughs[ti + 1];
    const dist = right - left;
    if (dist < 8 || dist > 50) continue;
    const diffPct = Math.abs(lows[left] - lows[right]) / lows[left];
    if (diffPct > 0.03) continue;

    const neckline = Math.max(...highs.slice(left, right + 1));
    const patternHeight = neckline - Math.min(lows[left], lows[right]);
    const avgPrice = (lows[left] + lows[right]) / 2;
    if (patternHeight / avgPrice < 0.005) continue;

    const curr = bars[bars.length - 1];
    if (!curr.bullish || curr.close <= neckline) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const aboveEMA21 = curr.close > state.ema21;
    const avgRange = getAvgRange(bars);

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      aboveEMA21,
      curr.close > state.ema9,
      curr.close > state.sma200,
      state.bias !== "DOWNTREND",
      hasBottomingTail(bars[bars.length - 2]) || hasBottomingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotLow, state.price) || isNearPivot(state.price, state.priorPivotLow, state.price),
      barFormationQuality(curr, "LONG") >= 3,
      patternHeight / avgPrice >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`double bottom breakout (height ${(patternHeight / avgPrice * 100).toFixed(1)}%, neckline ${neckline.toFixed(2)})`];
    if (volSurge) reasons.push("vol surge on breakout");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (aboveEMA21) reasons.push("above 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectDoubleTop(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 25) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, 3);

  for (let pi = 0; pi < peaks.length - 1; pi++) {
    const left = peaks[pi];
    const right = peaks[pi + 1];
    const dist = right - left;
    if (dist < 8 || dist > 50) continue;
    const diffPct = Math.abs(highs[left] - highs[right]) / highs[left];
    if (diffPct > 0.03) continue;

    const neckline = Math.min(...lows.slice(left, right + 1));
    const patternHeight = Math.max(highs[left], highs[right]) - neckline;
    const avgPrice = (highs[left] + highs[right]) / 2;
    if (patternHeight / avgPrice < 0.005) continue;

    const curr = bars[bars.length - 1];
    if (curr.bullish || curr.close >= neckline) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const belowEMA21 = curr.close < state.ema21;
    const avgRange = getAvgRange(bars);

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      belowEMA21,
      curr.close < state.ema9,
      curr.close < state.sma200,
      state.bias !== "UPTREND",
      hasToppingTail(bars[bars.length - 2]) || hasToppingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.priorPivotHigh, state.price),
      barFormationQuality(curr, "SHORT") >= 3,
      patternHeight / avgPrice >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`double top breakdown (height ${(patternHeight / avgPrice * 100).toFixed(1)}%, neckline ${neckline.toFixed(2)})`];
    if (volSurge) reasons.push("vol surge on breakdown");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (belowEMA21) reasons.push("below 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectHeadAndShouldersShort(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 30) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, 3);

  for (let pi = 2; pi < peaks.length; pi++) {
    const ls = peaks[pi - 2];
    const head = peaks[pi - 1];
    const rs = peaks[pi];
    if (head - ls < 6 || rs - head < 6 || rs - ls > 50) continue;
    if (highs[head] <= highs[ls] || highs[head] <= highs[rs]) continue;
    const shoulderDiff = Math.abs(highs[ls] - highs[rs]) / highs[head];
    if (shoulderDiff > 0.08) continue;

    const leftLow = Math.min(...lows.slice(ls, head + 1));
    const rightLow = Math.min(...lows.slice(head, rs + 1));
    const neckSlope = (rightLow - leftLow) / (rs - ls);
    const neckAt = leftLow + neckSlope * (bars.length - 1 - ls);

    const curr = bars[bars.length - 1];
    if (curr.bullish || curr.close >= neckAt) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const belowEMA21 = curr.close < state.ema21;
    const avgRange = getAvgRange(bars);
    const headHeight = highs[head] - neckAt;

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      belowEMA21,
      curr.close < state.ema9,
      curr.close < state.sma200,
      state.bias !== "UPTREND",
      hasToppingTail(bars[bars.length - 2]) || hasToppingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotHigh, state.price),
      barFormationQuality(curr, "SHORT") >= 3,
      headHeight / highs[head] >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`H&S breakdown (head height ${(headHeight / highs[head] * 100).toFixed(1)}%, neckline ${neckAt.toFixed(2)})`];
    if (volSurge) reasons.push("vol surge on breakdown");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (belowEMA21) reasons.push("below 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function detectInverseHeadAndShouldersLong(bars: Bar[], state: MarketState): { detected: boolean; confluence: number; confluenceLabel: string; reason: string } {
  if (bars.length < 30) return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const troughs = findLocalTroughs(lows, 3);

  for (let ti = 2; ti < troughs.length; ti++) {
    const ls = troughs[ti - 2];
    const head = troughs[ti - 1];
    const rs = troughs[ti];
    if (head - ls < 6 || rs - head < 6 || rs - ls > 50) continue;
    if (lows[head] >= lows[ls] || lows[head] >= lows[rs]) continue;
    const shoulderDiff = Math.abs(lows[ls] - lows[rs]) / lows[head];
    if (shoulderDiff > 0.08) continue;

    const leftHigh = Math.max(...highs.slice(ls, head + 1));
    const rightHigh = Math.max(...highs.slice(head, rs + 1));
    const neckSlope = (rightHigh - leftHigh) / (rs - ls);
    const neckAt = leftHigh + neckSlope * (bars.length - 1 - ls);

    const curr = bars[bars.length - 1];
    if (!curr.bullish || curr.close <= neckAt) continue;

    const recentVol = recentAvgVolume(bars, 10);
    const volSurge = curr.volume > recentVol * 1.5;
    if (!volSurge) continue;

    const aboveEMA21 = curr.close > state.ema21;
    const avgRange = getAvgRange(bars);
    const headHeight = neckAt - lows[head];

    const factors = [
      volSurge,
      isIgnitingVolume(bars, state.avgVolume),
      aboveEMA21,
      curr.close > state.ema9,
      curr.close > state.sma200,
      state.bias !== "DOWNTREND",
      hasBottomingTail(bars[bars.length - 2]) || hasBottomingTail(curr),
      isWideRangeBar(curr, avgRange),
      isNearPivot(state.price, state.pivotLow, state.price),
      barFormationQuality(curr, "LONG") >= 3,
      headHeight / lows[head] >= 0.01,
    ];
    const conf = calcConfluence(factors);
    const reasons: string[] = [`Inv H&S breakout (head height ${(headHeight / lows[head] * 100).toFixed(1)}%, neckline ${neckAt.toFixed(2)})`];
    if (volSurge) reasons.push("vol surge on breakout");
    if (isIgnitingVolume(bars, state.avgVolume)) reasons.push("igniting volume");
    if (aboveEMA21) reasons.push("above 21 EMA");
    if (isWideRangeBar(curr, avgRange)) reasons.push("wide range bar");
    return { detected: true, confluence: conf, confluenceLabel: confluenceDescription(conf, factors.length), reason: reasons.slice(0, 5).join(" + ") };
  }
  return { detected: false, confluence: 0, confluenceLabel: "", reason: "" };
}

function sentimentLabel(s: MarketState): string {
  if (s.sentiment === "BUYERS_CONTROL") return "GREED";
  if (s.sentiment === "SELLERS_CONTROL") return "FEAR";
  return "NEUTRAL";
}

function manageTrailingStop(trade: OpenTrade, bar: Bar, state: MarketState): void {
  trade.barsSinceEntry++;

  if (trade.direction === "LONG") {
    if (bar.high > trade.highSinceEntry) trade.highSinceEntry = bar.high;

    const moved = trade.highSinceEntry - trade.entry;
    const risk = trade.riskPoints;

    if (moved >= risk * 1.0 && !trade.trailActivated) {
      trade.trail = r2(trade.entry);
      trade.trailActivated = true;
    }

    if (trade.trailActivated) {
      const newTrail = r2(trade.highSinceEntry - risk * 0.6);
      if (newTrail > trade.trail) trade.trail = newTrail;
      trade.stop = Math.max(trade.stop, trade.trail);
    }

    if (trade.barsSinceEntry >= 3 && !trade.trailActivated) {
      const swingLow = Math.min(bar.low, state.recentSwingLow);
      const tickBuffer = trade.riskPoints * 0.05;
      const breakeven = trade.entry - tickBuffer;
      if (swingLow > breakeven) {
        trade.stop = r2(Math.max(trade.stop, swingLow - tickBuffer * 2));
      }
    }
  } else {
    if (bar.low < trade.lowSinceEntry) trade.lowSinceEntry = bar.low;

    const moved = trade.entry - trade.lowSinceEntry;
    const risk = trade.riskPoints;

    if (moved >= risk * 1.0 && !trade.trailActivated) {
      trade.trail = r2(trade.entry);
      trade.trailActivated = true;
    }

    if (trade.trailActivated) {
      const newTrail = r2(trade.lowSinceEntry + risk * 0.6);
      if (newTrail < trade.trail) trade.trail = newTrail;
      trade.stop = Math.min(trade.stop, trade.trail);
    }

    if (trade.barsSinceEntry >= 3 && !trade.trailActivated) {
      const swingHigh = Math.max(bar.high, state.recentSwingHigh);
      const tickBuffer = trade.riskPoints * 0.05;
      const breakeven = trade.entry + tickBuffer;
      if (swingHigh < breakeven) {
        trade.stop = r2(Math.min(trade.stop, swingHigh + tickBuffer * 2));
      }
    }
  }
}

function makeLog(overrides: Partial<TradeLog> & { id: number; timestamp: string; cumPnl: number }): TradeLog {
  return {
    market: "--", timeframe: "--", pattern: "--", action: "--", direction: "--",
    entry: null, stop: null, target: null, trail: null,
    pnl: null, volume: null, bias: null,
    confluence: null, confluenceLabel: null, sentiment: null,
    dataSource: null, volumeType: null, reason: null,
    ...overrides,
  };
}

function recordTrade(session: TraderSession, t: OpenTrade, exitPrice: number, pnl: number, ts: string, dataSource: string): void {
  const spec = getSpec(t.market);
  const riskPts = Math.abs(t.entry - t.initialStop);
  const pnlPoints = t.direction === "LONG" ? r2(exitPrice - t.entry) : r2(t.entry - exitPrice);
  const achievedRR = riskPts > 0 ? Math.round((Math.abs(pnlPoints) / riskPts) * 100) / 100 : 0;
  const outcome: "WIN" | "LOSS" | "BREAKEVEN" = pnl > spec.pointValue * 0.1 ? "WIN" : pnl < -spec.pointValue * 0.1 ? "LOSS" : "BREAKEVEN";

  const entry: JournalEntry = {
    id: "trade_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    timestamp: ts,
    symbol: t.market,
    timeframe: t.timeframe,
    pattern: t.pattern,
    direction: t.direction,
    entry: t.entry,
    stop: t.initialStop,
    target: t.target,
    exit: exitPrice,
    pnlPoints,
    pnlDollars: pnl,
    confluence: t.confluence || 0,
    confluenceLabel: t.confluenceLabel || "",
    outcome,
    reason: t.entryReason || "",
    notes: "",
    rewardRatio: session.rewardRatio,
    achievedRR: pnl >= 0 ? achievedRR : -achievedRR,
    dataSource: dataSource || "SIM",
    checklist: t.checklist || { patternMatch: true, volumeConfirmation: false, maRespect: false, priorPivotSR: false, barFormation: false },
  };
  try { addJournalEntry(entry); } catch (err) { console.error("[journal] save error:", err); }
}

async function simulateTick(session: TraderSession) {
  const ts = getESTTime();
  if (!isTradingHours() && !session.forceTrading) {
    if (session.logs.length === 0 || session.logs[session.logs.length - 1].action !== "MARKET CLOSED") {
      session.logs.push(makeLog({ id: logIdCounter++, timestamp: ts, cumPnl: session.cumPnl, action: "MARKET CLOSED" }));
    }
    return;
  }

  for (const mk of session.markets) {
    const spec = getSpec(mk);
    const pointValue = spec.pointValue;

    const livePrice = (mk === "ES" || mk === "MES") ? await fetchPolygonPrice(mk) : null;
    const dataSource = livePrice ? "POLYGON" : "SIM";

    if (!session.marketState[mk]) {
      if (livePrice) {
        const s = initMarketState(mk);
        s.price = r2(livePrice.price);
        s.ema9 = s.price;
        s.ema21 = s.price;
        s.sma200 = s.price;
        const pivotR = s.price * 0.003;
        const swingR = s.price * 0.002;
        s.pivotHigh = r2(s.price + rand(pivotR * 0.5, pivotR));
        s.pivotLow = r2(s.price - rand(pivotR * 0.5, pivotR));
        s.recentSwingHigh = r2(s.price + rand(swingR * 0.5, swingR));
        s.recentSwingLow = r2(s.price - rand(swingR * 0.5, swingR));
        session.marketState[mk] = s;
      } else {
        session.marketState[mk] = initMarketState(mk);
      }
    }
    const state = session.marketState[mk];
    const tradeKey = mk;

    if (session.openTrades[tradeKey]) {
      const t = session.openTrades[tradeKey];
      const bar = generateBar(state, mk, livePrice);

      t.barsSinceEntry++;
      if (t.direction === "LONG") {
        if (bar.high > t.highSinceEntry) t.highSinceEntry = bar.high;
        if (bar.low < t.lowSinceEntry) t.lowSinceEntry = bar.low;
      } else {
        if (bar.low < t.lowSinceEntry) t.lowSinceEntry = bar.low;
        if (bar.high > t.highSinceEntry) t.highSinceEntry = bar.high;
      }

      let hit = false;
      if (t.direction === "LONG") {
        if (bar.low <= t.stop) {
          const exitPrice = t.stop;
          const pnl = r2((exitPrice - t.entry) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.losses++;
          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe,
            pattern: t.pattern, action: "STOPPED OUT", direction: t.direction,
            entry: t.entry, stop: t.stop, target: t.target,
            pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias,
            sentiment: sentimentLabel(state), dataSource,
          }));
          dailyPnlTracker = r2(dailyPnlTracker + pnl);
          recordTrade(session, t, exitPrice, pnl, ts, dataSource);
          delete session.openTrades[tradeKey]; hit = true;
        } else if (bar.high >= t.target) {
          const pnl = r2((t.target - t.entry) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.wins++;
          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe,
            pattern: t.pattern, action: "TARGET HIT", direction: t.direction,
            entry: t.entry, stop: t.stop, target: t.target,
            pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias,
            sentiment: sentimentLabel(state), dataSource,
          }));
          dailyPnlTracker = r2(dailyPnlTracker + pnl);
          recordTrade(session, t, t.target, pnl, ts, dataSource);
          delete session.openTrades[tradeKey]; hit = true;
        }
      } else {
        if (bar.high >= t.stop) {
          const exitPrice = t.stop;
          const pnl = r2((t.entry - exitPrice) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.losses++;
          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe,
            pattern: t.pattern, action: "STOPPED OUT", direction: t.direction,
            entry: t.entry, stop: t.stop, target: t.target,
            pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias,
            sentiment: sentimentLabel(state), dataSource,
          }));
          dailyPnlTracker = r2(dailyPnlTracker + pnl);
          recordTrade(session, t, exitPrice, pnl, ts, dataSource);
          delete session.openTrades[tradeKey]; hit = true;
        } else if (bar.low <= t.target) {
          const pnl = r2((t.entry - t.target) * pointValue);
          session.cumPnl = r2(session.cumPnl + pnl);
          session.wins++;
          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: t.timeframe,
            pattern: t.pattern, action: "TARGET HIT", direction: t.direction,
            entry: t.entry, stop: t.stop, target: t.target,
            pnl, cumPnl: session.cumPnl, volume: bar.volume, bias: state.bias,
            sentiment: sentimentLabel(state), dataSource,
          }));
          dailyPnlTracker = r2(dailyPnlTracker + pnl);
          recordTrade(session, t, t.target, pnl, ts, dataSource);
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

      const bar = generateBar(state, mk, livePrice);
      session.bars[barKey].push(bar);
      if (session.bars[barKey].length > 35) session.bars[barKey].shift();

      const bars = session.bars[barKey];
      if (bars.length < 7) continue;

      const volType = classifyVolume(bars, state.avgVolume);

      let detectedPattern = "";
      let direction: "LONG" | "SHORT" = "LONG";
      let confluence = 0;
      let confluenceLabel = "";
      let entryReason = "";

      const candidates: Array<{ pattern: string; dir: "LONG" | "SHORT"; conf: number; label: string; reason: string }> = [];

      if (session.patterns.includes("3bar_long")) {
        const r = detect3BarPlayBuy(bars, state);
        if (r.detected) candidates.push({ pattern: "3 Bar Play", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("3bar_short")) {
        const r = detect3BarPlaySell(bars, state);
        if (r.detected) candidates.push({ pattern: "3 Bar Play", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("buysetup")) {
        const r = detectBuySetup(bars, state);
        if (r.detected) candidates.push({ pattern: "Buy Setup", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("sellsetup")) {
        const r = detectSellSetup(bars, state);
        if (r.detected) candidates.push({ pattern: "Sell Setup", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("breakout_long")) {
        const r = detectBreakoutLong(bars, state);
        if (r.detected) candidates.push({ pattern: "Pivot Breakout", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("breakout_short")) {
        const r = detectBreakoutShort(bars, state);
        if (r.detected) candidates.push({ pattern: "Pivot Breakout", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("climax_long")) {
        const r = detectClimaxReversal(bars, state);
        if (r.detected && r.direction === "LONG") candidates.push({ pattern: "Climax Reversal", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("climax_short")) {
        const r = detectClimaxReversal(bars, state);
        if (r.detected && r.direction === "SHORT") candidates.push({ pattern: "Climax Reversal", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("wedge_long")) {
        const r = detectWedgeLong(bars, state);
        if (r.detected) candidates.push({ pattern: "Wedge Breakout", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("wedge_short")) {
        const r = detectWedgeShort(bars, state);
        if (r.detected) candidates.push({ pattern: "Wedge Breakout", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("cuphandle_long")) {
        const r = detectCupAndHandleLong(bars, state);
        if (r.detected) candidates.push({ pattern: "Cup & Handle", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("cuphandle_short")) {
        const r = detectInverseCupAndHandleShort(bars, state);
        if (r.detected) candidates.push({ pattern: "Inverse Cup & Handle", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("doublebottom")) {
        const r = detectDoubleBottom(bars, state);
        if (r.detected) candidates.push({ pattern: "Double Bottom", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("doubletop")) {
        const r = detectDoubleTop(bars, state);
        if (r.detected) candidates.push({ pattern: "Double Top", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("headshoulders")) {
        const r = detectHeadAndShouldersShort(bars, state);
        if (r.detected) candidates.push({ pattern: "Head & Shoulders", dir: "SHORT", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }
      if (session.patterns.includes("invheadshoulders")) {
        const r = detectInverseHeadAndShouldersLong(bars, state);
        if (r.detected) candidates.push({ pattern: "Inverse H&S", dir: "LONG", conf: r.confluence, label: r.confluenceLabel, reason: r.reason });
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.conf - a.conf);
        const best = candidates[0];
        detectedPattern = best.pattern;
        direction = best.dir;
        confluence = best.conf;
        confluenceLabel = best.label;
        entryReason = best.reason;

        const sameDir = candidates.filter(c => c.dir === best.dir && c.pattern !== best.pattern);
        if (sameDir.length >= 1) {
          const convergenceBonus = Math.min(sameDir.length * 1.5, 3);
          confluence += convergenceBonus;
          const otherPatterns = sameDir.map(c => c.pattern).join(", ");
          confluenceLabel = `${confluenceLabel} [CONVERGE+${convergenceBonus} w/ ${otherPatterns}]`;
          console.log(`[trader] Multi-pattern convergence on ${mk} ${best.dir}: ${best.pattern} + ${otherPatterns} → +${convergenceBonus}pt (${confluence}pt total)`);
        }
      }

      if (detectedPattern && confluence > 0) {
        const edgeBoostCombos: Record<string, string[]> = {
          "NQ": ["Wedge Breakout"],
          "MNQ": ["Wedge Breakout"],
          "SI": ["Buy Setup", "Sell Setup", "Pivot Breakout", "3 Bar Play"],
          "ZS": ["3 Bar Play"],
          "ZW": ["3 Bar Play"],
          "CL": ["Wedge Breakout"],
          "MCL": ["Wedge Breakout"],
        };
        const boostPatterns = edgeBoostCombos[mk];
        if (boostPatterns && boostPatterns.includes(detectedPattern)) {
          const boost = (mk === "NQ" || mk === "MNQ" || mk === "SI") ? 2 : 1;
          confluence += boost;
          confluenceLabel = `${confluenceLabel} [EDGE+${boost}]`;
          console.log(`[trader] Edge boost: ${mk}/${detectedPattern} +${boost}pt → ${confluence}pt`);
        }
      }

      const openCount = Object.keys(session.openTrades).length;
      if (detectedPattern && !session.openTrades[tradeKey] && openCount < session.maxOpenTrades) {
          const entry = state.price;

          const riskPointsFromDollars = r2(session.riskDollars / spec.pointValue);
          const rewardRatio = session.rewardRatio;
          let stop: number, target: number;

          if (direction === "LONG") {
            stop = r2(entry - riskPointsFromDollars);
            target = r2(entry + riskPointsFromDollars * rewardRatio);
          } else {
            stop = r2(entry + riskPointsFromDollars);
            target = r2(entry - riskPointsFromDollars * rewardRatio);
          }

          const clampedRisk = riskPointsFromDollars;

          const htfAligned = direction === "LONG"
            ? (state.ema9 > state.ema21 && state.price > state.sma200)
            : (state.ema9 < state.ema21 && state.price < state.sma200);
          const volumeConfirmed = bar.volume > state.avgVolume * 1.5;
          const maConfluence = isNearMA(state.price, state.ema9) || isNearMA(state.price, state.ema21);
          const rrValid = rewardRatio >= 2;

          const avgRange = bars.slice(-10).reduce((sum, b) => sum + Math.abs(b.high - b.low), 0) / Math.min(bars.length, 10);
          const recentRanges = bars.slice(-5).map(b => Math.abs(b.high - b.low));
          const isChoppy = recentRanges.every(r => r < avgRange * 0.5);
          const noOverlap = !isChoppy;

          const confluencePass = confluence >= LIVE_CONFLUENCE_MIN;

          const preTradeChecklist = {
            htfAligned,
            volumeConfirmed,
            maConfluence,
            rrValid,
            noOverlap,
            confluencePass,
          };

          const riskSafe = !isRiskTooHigh(session.riskDollars);
          const dailySafe = !isDailyLossLimitHit();

          const allPassed = htfAligned && volumeConfirmed && maConfluence && rrValid && noOverlap && confluencePass && riskSafe && dailySafe;

          console.log(`[trader] Checklist result for ${mk} ${direction} ${detectedPattern}: ${JSON.stringify({...preTradeChecklist, riskSafe, dailySafe, confluenceMin: LIVE_CONFLUENCE_MIN})} | allPassed=${allPassed}`);

          const checklist = {
            patternMatch: true,
            volumeConfirmation: volumeConfirmed,
            maRespect: maConfluence,
            priorPivotSR: isNearPivot(state.price, state.pivotHigh, state.price) || isNearPivot(state.price, state.pivotLow, state.price),
            barFormation: (entryReason || "").toLowerCase().includes("tail") || (entryReason || "").toLowerCase().includes("bar") || (entryReason || "").toLowerCase().includes("green") || (entryReason || "").toLowerCase().includes("red"),
          };

        if (allPassed) {

          session.openTrades[tradeKey] = {
            entry, stop, target, trail: stop, initialStop: stop,
            market: mk, timeframe: tf, pattern: detectedPattern,
            direction, riskPoints: clampedRisk,
            highSinceEntry: entry, lowSinceEntry: entry,
            barsSinceEntry: 0, trailActivated: false,
            confluence, confluenceLabel,
            entryReason: entryReason || "",
            checklist,
          };

          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: tf, pattern: detectedPattern,
            action: direction === "LONG" ? "LONG ENTERED" : "SHORT ENTERED", direction,
            entry, stop, target, trail: stop,
            cumPnl: session.cumPnl,
            volume: bar.volume, bias: state.bias, confluence, confluenceLabel,
            sentiment: sentimentLabel(state), dataSource, volumeType: volType,
            reason: entryReason || null,
          }));

          emitTradeSignal(mk, direction, entry, stop, target, session.rewardRatio, confluence, detectedPattern, session.account);

          if (isTradovateConnected()) {
            placeBracketOrder(mk, direction, entry, stop, target, 1).then(result => {
              if (result.success) {
                session.logs.push(makeLog({
                  id: logIdCounter++, timestamp: getESTTime(), market: mk, timeframe: tf, pattern: detectedPattern,
                  action: "TRADOVATE ORDER", direction,
                  entry, stop, target,
                  reason: `Bracket order placed — Entry: ${result.entryOrderId}, SL: ${result.slOrderId}, TP: ${result.tpOrderId}`,
                  dataSource: "TRADOVATE",
                }));
              } else {
                session.logs.push(makeLog({
                  id: logIdCounter++, timestamp: getESTTime(), market: mk, timeframe: tf, pattern: detectedPattern,
                  action: "TRADOVATE ERROR", direction,
                  entry, stop, target,
                  reason: `Order failed: ${result.error}`,
                  dataSource: "TRADOVATE",
                }));
              }
            }).catch(err => {
              console.error("[tradovate] Bracket order error:", err);
            });
          }

          break;
        }

        if (Math.random() < 0.45) {
          session.logs.push(makeLog({
            id: logIdCounter++, timestamp: ts, market: mk, timeframe: tf, pattern: detectedPattern,
            action: "SIGNAL (no entry)", direction,
            entry: state.price,
            cumPnl: session.cumPnl,
            volume: bar.volume, bias: state.bias, confluence, confluenceLabel,
            sentiment: sentimentLabel(state), dataSource, volumeType: volType,
            reason: entryReason || null,
          }));
        }
      }
    }

    const lastScan = session.logs[session.logs.length - 1];
    const scanThreshold = spec.basePrice * 0.0001;
    const priceChanged = lastScan?.entry ? Math.abs(state.price - lastScan.entry) > scanThreshold : true;
    const isScanDue = !lastScan || lastScan.action === "TRADER STARTED" || lastScan.market !== mk || lastScan.action !== "SCANNING" || priceChanged;
    if (isScanDue && !session.openTrades[tradeKey]) {
      session.logs.push(makeLog({
        id: logIdCounter++, timestamp: ts, market: mk,
        action: "SCANNING",
        entry: state.price,
        cumPnl: session.cumPnl,
        bias: state.bias, sentiment: sentimentLabel(state), dataSource,
      }));
    }
  }

  if (session.logs.length > 300) session.logs = session.logs.slice(-300);
}

export function startTrader(config: {
  markets: string[];
  timeframes: string[];
  riskDollars: number;
  rewardRatio: number;
  maxOpenTrades: number;
  account: string;
  patterns: string[];
  customCondition: string;
  forceTrading: boolean;
}): string {
  const id = "session_" + Date.now();
  const rr = Math.max(1, Math.min(config.rewardRatio || 2, 5));
  const maxOpen = Math.max(1, Math.min(config.maxOpenTrades || 3, 10));
  const riskAmt = Math.max(10, Math.min(config.riskDollars || 100, 10000));
  const acct = config.account || process.env.CROSSTRADE_ACCOUNT || "SIM101";
  const session: TraderSession = {
    id, running: true,
    markets: config.markets, timeframes: config.timeframes,
    riskDollars: riskAmt, rewardRatio: rr, maxOpenTrades: maxOpen, account: acct, patterns: config.patterns,
    customCondition: config.customCondition,
    forceTrading: config.forceTrading || false,
    logs: [], cumPnl: 0, timeout: null,
    marketState: {}, bars: {}, tickCount: {},
    openTrades: {}, createdAt: Date.now(),
    wins: 0, losses: 0,
  };

  session.logs.push(makeLog({
    id: logIdCounter++, timestamp: getESTTime(),
    action: "TRADER STARTED", cumPnl: 0,
    dataSource: POLYGON_API_KEY ? "POLYGON" : "SIM",
  }));

  const patternNames: Record<string, string> = {
    "3bar_long": "3Bar Long", "3bar_short": "3Bar Short",
    "buysetup": "Buy Setup", "sellsetup": "Sell Setup",
    "breakout_long": "Breakout Long", "breakout_short": "Breakout Short",
    "climax_long": "Climax Long", "climax_short": "Climax Short",
    "wedge_long": "Wedge Long", "wedge_short": "Wedge Short",
    "cuphandle_long": "Cup & Handle", "cuphandle_short": "Inverse Cup & Handle",
    "doublebottom": "Double Bottom", "doubletop": "Double Top",
    "headshoulders": "Head & Shoulders", "invheadshoulders": "Inverse H&S",
  };
  const enabledNames = config.patterns.map(p => patternNames[p] || p).join(", ");
  const enabledTFs = config.timeframes.join(", ");
  session.logs.push(makeLog({
    id: logIdCounter++, timestamp: getESTTime(),
    action: "SCANNING",
    reason: `Enabled patterns: ${enabledNames} | Timeframes: ${enabledTFs}`,
  }));

  const delay = () => Math.floor(rand(8000, 15000));
  function loop() {
    if (!session.running) return;
    simulateTick(session).then(() => {
      if (session.running) session.timeout = setTimeout(loop, delay());
    }).catch((err) => {
      console.error("[trader] tick error:", err);
      if (session.running) session.timeout = setTimeout(loop, delay());
    });
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
  s.logs.push(makeLog({
    id: logIdCounter++, timestamp: getESTTime(),
    action: "TRADER STOPPED", cumPnl: s.cumPnl,
  }));
  return true;
}

export function getTraderLogs(id: string, after?: number): TradeLog[] {
  const s = sessions[id];
  if (!s) return [];
  if (after) return s.logs.filter(l => l.id > after);
  return s.logs;
}

export function getTraderStatus(id: string): { running: boolean; cumPnl: number; tradeCount: number; openPositions: number; wins: number; losses: number; rewardRatio: number; riskDollars: number; maxOpenTrades: number } | null {
  const s = sessions[id];
  if (!s) return null;
  return {
    running: s.running, cumPnl: s.cumPnl,
    tradeCount: s.logs.filter(l => l.action === "LONG ENTERED" || l.action === "SHORT ENTERED").length,
    openPositions: Object.keys(s.openTrades).length,
    wins: s.wins, losses: s.losses,
    rewardRatio: s.rewardRatio,
    riskDollars: s.riskDollars,
    maxOpenTrades: s.maxOpenTrades,
  };
}

export function isTradingOpen(): boolean { return isTradingHours(); }

export function isForceTradeActive(): boolean {
  return Object.values(sessions).some(s => s.running && s.forceTrading);
}

export function getSafetyStatus(): { dailyPnl: number; dailyLossLimit: number; maxRiskPct: number; confluenceMin: number; accountSize: number; dailyLimitHit: boolean; rthActive: boolean; apexRules: typeof APEX_RULES } {
  resetDailyPnlIfNeeded();
  return {
    dailyPnl: dailyPnlTracker,
    dailyLossLimit: DAILY_LOSS_LIMIT_PCT,
    maxRiskPct: MAX_RISK_PCT,
    confluenceMin: LIVE_CONFLUENCE_MIN,
    accountSize: DEFAULT_ACCOUNT_SIZE,
    dailyLimitHit: isDailyLossLimitHit(),
    rthActive: isRTH(),
    apexRules: APEX_RULES,
  };
}

export { connectTradovate, getTradovateStatus, isTradovateConnected } from "./tradovate";

connectTradovate().then(result => {
  console.log(`[trader] Tradovate init: ${result.message}`);
}).catch(err => {
  console.log(`[trader] Tradovate init skipped: ${err.message}`);
});
