import fs from "fs";
import path from "path";
let yahooFinance: any = null;
async function getYahooFinance() {
  if (!yahooFinance) {
    const mod = await import("yahoo-finance2");
    const YF = mod.default || mod;
    yahooFinance = typeof YF === "function" ? new YF() : YF;
  }
  return yahooFinance;
}

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_BASE = "https://api.polygon.io";
const DATA_DIR = path.resolve("./data");

function parseTimeframe(tf: string): { multiplier: number; timespan: string } {
  const map: Record<string, { multiplier: number; timespan: string }> = {
    "1min": { multiplier: 1, timespan: "minute" },
    "2min": { multiplier: 2, timespan: "minute" },
    "3min": { multiplier: 3, timespan: "minute" },
    "5min": { multiplier: 5, timespan: "minute" },
    "15min": { multiplier: 15, timespan: "minute" },
    "30min": { multiplier: 30, timespan: "minute" },
    "1hour": { multiplier: 1, timespan: "hour" },
    "4hour": { multiplier: 4, timespan: "hour" },
    "daily": { multiplier: 1, timespan: "day" },
    "day": { multiplier: 1, timespan: "day" },
    "week": { multiplier: 1, timespan: "week" },
    "weekly": { multiplier: 1, timespan: "week" },
  };
  return map[tf.toLowerCase()] || { multiplier: 1, timespan: "day" };
}

const barCache: Map<string, { bars: Bar[]; fetchedAt: number }> = new Map();
const BAR_CACHE_TTL = 300_000;

function diskCachePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(DATA_DIR, `${safe}.json`);
}

function getCachedBars(key: string): Bar[] | null {
  const entry = barCache.get(key);
  if (entry && Date.now() - entry.fetchedAt < BAR_CACHE_TTL) {
    return entry.bars;
  }
  const diskPath = diskCachePath(key);
  try {
    if (fs.existsSync(diskPath)) {
      const raw = fs.readFileSync(diskPath, "utf-8");
      const bars: Bar[] = JSON.parse(raw);
      if (bars.length > 0) {
        barCache.set(key, { bars, fetchedAt: Date.now() });
        console.log(`[cache] Disk hit: ${bars.length} bars for ${key}`);
        return bars;
      }
    }
  } catch {}
  return null;
}

function setCachedBars(key: string, bars: Bar[]): void {
  barCache.set(key, { bars: [...bars], fetchedAt: Date.now() });
  if (barCache.size > 100) {
    const oldest = [...barCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0; i < 20; i++) barCache.delete(oldest[i][0]);
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(diskCachePath(key), JSON.stringify(bars));
  } catch (e: any) {
    console.error(`[cache] Disk write error for ${key}: ${e.message}`);
  }
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

interface BacktestTrade {
  date: string;
  hour?: number;
  dayOfWeek?: number;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  pnlPct: number;
  pnlDollars: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  holdBars: number;
  pattern: string;
  direction: "LONG" | "SHORT";
  confluence?: number;
  volType?: string;
  timeframe?: string;
  symbol?: string;
  rsiVal?: number;
  adxVal?: number;
  macdBullish?: boolean;
  bbPosition?: string;
  trendScore?: number;
  aboveEma50?: boolean;
  aboveSma200?: boolean;
}

interface BacktestResult {
  symbol: string;
  pattern: string;
  period: string;
  totalTrades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgProfitPct: number;
  avgWinPct: number;
  avgLossPct: number;
  totalPnlDollars: number;
  maxDrawdownPct: number;
  profitFactor: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  trades: BacktestTrade[];
  allTrades: BacktestTrade[];
  dataPoints: number;
  error?: string;
}

function getContractTickers(symbol: string, startYear: number, endYear: number): string[] {
  const quarterMonths = ["H", "M", "U", "Z"];
  const monthlyMonths = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
  const quarterlySymbols = ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K", "ZB", "ZN", "ZT", "ZF"];
  const isQuarterly = quarterlySymbols.includes(symbol);
  const months = isQuarterly ? quarterMonths : monthlyMonths;

  const tickers: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    const yDigit = String(year).slice(-1);
    for (const m of months) {
      tickers.push(`${symbol}${m}${yDigit}`);
    }
  }
  return tickers;
}

let polygonCallCount = 0;
let polygonMinuteStart = Date.now();

async function rateLimitGuard(): Promise<void> {
  const now = Date.now();
  if (now - polygonMinuteStart > 60000) {
    polygonCallCount = 0;
    polygonMinuteStart = now;
  }
  if (polygonCallCount >= 4) {
    const waitMs = 60000 - (now - polygonMinuteStart) + 1000;
    if (waitMs > 0) {
      console.log(`[backtest] Rate limit guard: waiting ${Math.ceil(waitMs / 1000)}s before next Polygon call`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    polygonCallCount = 0;
    polygonMinuteStart = Date.now();
  }
}

async function fetchPolygonAggs(ticker: string, from: string, to: string, multiplier = 1, timespan = "day"): Promise<Bar[]> {
  if (!POLYGON_API_KEY) return [];

  await rateLimitGuard();

  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      polygonCallCount++;

      if (resp.status === 429) {
        const retryAfter = Math.min(65000, (attempt + 1) * 30000);
        console.log(`[backtest] Polygon 429 rate limited on ${ticker}, retry ${attempt + 1}/3 after ${retryAfter / 1000}s`);
        await new Promise(r => setTimeout(r, retryAfter));
        polygonCallCount = 0;
        polygonMinuteStart = Date.now();
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[backtest] Polygon HTTP ${resp.status} for ${ticker}: ${errText.slice(0, 120)}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; }
        return [];
      }
      const rawText = await resp.text();
      let data: any;
      try { data = JSON.parse(rawText); } catch {
        console.error(`[backtest] Polygon returned non-JSON for ${ticker}: ${rawText.slice(0, 120)}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 10000)); continue; }
        return [];
      }
      if (!data.results || data.results.length === 0) return [];
      if (data.results.length >= 49999) {
        console.log(`[backtest] WARNING: Polygon returned ${data.results.length} bars for ${ticker} — data may be truncated. Narrow date range or use a larger timeframe.`);
      }
      return data.results.map((r: any) => ({
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v || 0,
        timestamp: r.t,
      }));
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }
  return [];
}

async function fetchStitchedData(symbol: string, from: string, to: string, multiplier = 1, timespan = "day"): Promise<Bar[]> {
  const startYear = parseInt(from.slice(0, 4));
  const endYear = parseInt(to.slice(0, 4));
  const tickers = getContractTickers(symbol, startYear, endYear);

  let allBars: Bar[] = [];
  let prevClose: number | null = null;
  let fetchedCount = 0;

  for (const ticker of tickers) {
    if (fetchedCount >= 5) {
      await new Promise(r => setTimeout(r, 12500));
      fetchedCount = 0;
    }

    const bars = await fetchPolygonAggs(ticker, from, to, multiplier, timespan);
    fetchedCount++;
    if (bars.length === 0) continue;

    if (prevClose !== null) {
      const rollDiff = bars[0].open - prevClose;
      for (const b of bars) {
        b.open -= rollDiff;
        b.high -= rollDiff;
        b.low -= rollDiff;
        b.close -= rollDiff;
      }
    }
    prevClose = bars[bars.length - 1].close;
    allBars = allBars.concat(bars);
  }

  const seen = new Set<number>();
  return allBars.filter(b => {
    if (seen.has(b.timestamp)) return false;
    seen.add(b.timestamp);
    return true;
  }).sort((a, b) => a.timestamp - b.timestamp);
}

const ETF_PROXIES: Record<string, { etf: string; ratio: number }> = {
  ES:  { etf: "SPY",  ratio: 7.8 },
  MES: { etf: "SPY",  ratio: 7.8 },
  NQ:  { etf: "QQQ",  ratio: 37.0 },
  MNQ: { etf: "QQQ",  ratio: 37.0 },
  YM:  { etf: "DIA",  ratio: 86.0 },
  MYM: { etf: "DIA",  ratio: 86.0 },
  RTY: { etf: "IWM",  ratio: 9.5 },
  M2K: { etf: "IWM",  ratio: 9.5 },
  CL:  { etf: "USO",  ratio: 1.0 },
  MCL: { etf: "USO",  ratio: 1.0 },
  GC:  { etf: "GLD",  ratio: 12.0 },
  MGC: { etf: "GLD",  ratio: 12.0 },
  SI:  { etf: "SLV",  ratio: 1.15 },
  HG:  { etf: "CPER", ratio: 1.0 },
  BTC: { etf: "BITO", ratio: 3.8 },
  ETH: { etf: "ETHA", ratio: 1.0 },
  ZB:  { etf: "TLT",  ratio: 1.2 },
  ZN:  { etf: "IEF",  ratio: 1.15 },
  ZC:  { etf: "CORN", ratio: 20.0 },
  ZS:  { etf: "SOYB", ratio: 40.0 },
  ZW:  { etf: "WEAT", ratio: 25.0 },
};

async function fetchETFProxy(symbol: string, from: string, to: string, multiplier = 1, timespan = "day"): Promise<Bar[]> {
  const proxy = ETF_PROXIES[symbol];
  if (!proxy) return [];

  const etfCacheKey = `ETF:${proxy.etf}:${multiplier}${timespan}:${from}:${to}`;
  let rawBars = getCachedBars(etfCacheKey);
  if (!rawBars) {
    rawBars = await fetchPolygonAggs(proxy.etf, from, to, multiplier, timespan);
    if (rawBars.length > 0) setCachedBars(etfCacheKey, rawBars);
  } else {
    console.log(`[backtest] ETF cache hit: ${rawBars.length} bars for ${proxy.etf} (proxy for ${symbol})`);
  }
  if (rawBars.length === 0) return [];
  return rawBars.map(b => ({
    ...b,
    open: Math.round(b.open * proxy.ratio * 100) / 100,
    high: Math.round(b.high * proxy.ratio * 100) / 100,
    low: Math.round(b.low * proxy.ratio * 100) / 100,
    close: Math.round(b.close * proxy.ratio * 100) / 100,
  }));
}

const YAHOO_INTERVAL_MAP: Record<string, string> = {
  "1min": "1m", "2min": "2m", "5min": "5m", "15min": "15m", "30min": "30m",
  "1hour": "1h", "4hour": "4h", "daily": "1d", "day": "1d", "week": "1wk", "weekly": "1wk",
};

const YAHOO_SYMBOL_MAP: Record<string, string> = {
  ES: "ES=F", MES: "ES=F", NQ: "NQ=F", MNQ: "NQ=F",
  YM: "YM=F", MYM: "YM=F", RTY: "RTY=F", M2K: "RTY=F",
  CL: "CL=F", MCL: "CL=F", GC: "GC=F", MGC: "GC=F",
  SI: "SI=F", HG: "HG=F", ZC: "ZC=F", ZS: "ZS=F", ZW: "ZW=F",
  ZB: "ZB=F", ZN: "ZN=F", ZF: "ZF=F", ZT: "ZT=F",
  BTC: "BTC-USD", MBT: "BTC-USD", ETH: "ETH-USD", MET: "ETH-USD",
};

async function fetchYahooFinance(symbol: string, from: string, to: string, timeframe: string): Promise<Bar[]> {
  const yahooSymbol = YAHOO_SYMBOL_MAP[symbol] || symbol;
  const interval = YAHOO_INTERVAL_MAP[timeframe] || "1d";

  const fromDate = new Date(from);
  const toDate = new Date(to);
  toDate.setDate(toDate.getDate() + 1);

  const maxIntraday = 60 * 24 * 3600 * 1000;
  if (["1m", "2m", "5m", "15m", "30m", "1h"].includes(interval)) {
    const rangeMs = toDate.getTime() - fromDate.getTime();
    if (rangeMs > maxIntraday) {
      console.log(`[yahoo] Intraday range too long for ${yahooSymbol} (${Math.round(rangeMs / 86400000)}d). Yahoo limits intraday to ~60 days.`);
    }
  }

  try {
    console.log(`[yahoo] Fetching ${yahooSymbol} [${interval}] from ${from} to ${to}`);
    const yf = await getYahooFinance();
    const result = await yf.chart(yahooSymbol, {
      period1: fromDate,
      period2: toDate,
      interval: interval as any,
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      console.log(`[yahoo] No data returned for ${yahooSymbol}`);
      return [];
    }

    const bars: Bar[] = result.quotes
      .filter((q: any) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q: any) => ({
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
        timestamp: new Date(q.date).getTime(),
      }));

    console.log(`[yahoo] Got ${bars.length} bars for ${yahooSymbol} [${interval}]`);
    return bars;
  } catch (err: any) {
    console.error(`[yahoo] Error fetching ${yahooSymbol}: ${err.message}`);
    return [];
  }
}

type VolType = "IGNITING" | "ENDING" | "RESTING" | "NORMAL";

function addIndicators(bars: Bar[]): {
  bars: Bar[];
  ema21: number[];
  ema9: number[];
  ema50: number[];
  ema200: number[];
  avgRange: number[];
  avgVol: number[];
  atr: number[];
  range: number[];
  body: number[];
  green: boolean[];
  tail: number[];
  wick: number[];
  bottomingTail: boolean[];
  toppingTail: boolean[];
  volType: VolType[];
  sideways: boolean[];
  htfUp: boolean[];
  htfDown: boolean[];
  pivotHighs: number[];
  pivotLows: number[];
  gapUp: boolean[];
  gapDown: boolean[];
  level2GapUp: boolean[];
  level2GapDown: boolean[];
  isParabolic: boolean[];
  wBottom: boolean[];
  wTop: boolean[];
  macdLine: number[];
  macdSignal: number[];
  macdHist: number[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
  bbUpper: number[];
  bbLower: number[];
  bbMiddle: number[];
  bbSqueeze: boolean[];
  rsi: number[];
  sma50: number[];
  sma200: number[];
  trendStrength: number[];
} {
  const ema21: number[] = [];
  const ema9: number[] = [];
  const ema50: number[] = [];
  const ema200: number[] = [];
  const avgRange: number[] = [];
  const avgVol: number[] = [];
  const atr: number[] = [];
  const range: number[] = [];
  const body: number[] = [];
  const green: boolean[] = [];
  const tail: number[] = [];
  const wick: number[] = [];
  const bottomingTail: boolean[] = [];
  const toppingTail: boolean[] = [];
  const volType: VolType[] = [];
  const sideways: boolean[] = [];
  const htfUp: boolean[] = [];
  const htfDown: boolean[] = [];
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];
  const gapUp: boolean[] = [];
  const gapDown: boolean[] = [];
  const level2GapUp: boolean[] = [];
  const level2GapDown: boolean[] = [];
  const isParabolic: boolean[] = [];
  const wBottom: boolean[] = [];
  const wTop: boolean[] = [];
  const macdLine: number[] = [];
  const macdSignal: number[] = [];
  const macdHist: number[] = [];
  const adx: number[] = [];
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const bbUpper: number[] = [];
  const bbLower: number[] = [];
  const bbMiddle: number[] = [];
  const bbSqueeze: boolean[] = [];
  const rsi: number[] = [];
  const sma50: number[] = [];
  const sma200: number[] = [];
  const trendStrength: number[] = [];

  const ema21k = 2 / 22;
  const ema9k = 2 / 10;
  const ema50k = 2 / 51;
  const ema200k = 2 / 201;
  const ema12k = 2 / 13;
  const ema26k = 2 / 27;
  const macdSigK = 2 / 10;
  let ema12 = 0;
  let ema26 = 0;
  let rsiAvgGain = 0;
  let rsiAvgLoss = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;
  let smoothedTR = 0;

  let rollingPivotHigh = 0;
  let rollingPivotLow = Infinity;
  let prevPivotHigh = 0;
  let prevPivotLow = Infinity;
  let hph = 0;
  let hpl = 0;
  let lph = 0;
  let lpl = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const r = b.high - b.low;
    range.push(r);
    const bd = Math.abs(b.close - b.open);
    body.push(bd);
    const isGreen = b.close > b.open;
    green.push(isGreen);

    const tl = isGreen ? (b.open - b.low) : (b.close - b.low);
    const wk = isGreen ? (b.high - b.close) : (b.high - b.open);
    tail.push(tl);
    wick.push(wk);

    const isBT = r > 0 && tl > 0.5 * r && bd < 0.3 * r && isGreen;
    bottomingTail.push(isBT);
    const isTT = r > 0 && wk > 0.5 * r && bd < 0.3 * r && !isGreen;
    toppingTail.push(isTT);

    if (i === 0) {
      ema21.push(b.close);
      ema9.push(b.close);
      ema50.push(b.close);
      ema200.push(b.close);
      ema12 = b.close;
      ema26 = b.close;
    } else {
      ema21.push(b.close * ema21k + ema21[i - 1] * (1 - ema21k));
      ema9.push(b.close * ema9k + ema9[i - 1] * (1 - ema9k));
      ema50.push(b.close * ema50k + ema50[i - 1] * (1 - ema50k));
      ema200.push(b.close * ema200k + ema200[i - 1] * (1 - ema200k));
      ema12 = b.close * ema12k + ema12 * (1 - ema12k);
      ema26 = b.close * ema26k + ema26 * (1 - ema26k);
    }

    const ml = ema12 - ema26;
    macdLine.push(ml);
    if (i === 0) {
      macdSignal.push(ml);
    } else {
      macdSignal.push(ml * macdSigK + macdSignal[i - 1] * (1 - macdSigK));
    }
    macdHist.push(ml - macdSignal[i]);

    const rsiPeriod = 14;
    if (i === 0) {
      rsi.push(50);
      rsiAvgGain = 0;
      rsiAvgLoss = 0;
    } else {
      const diff = b.close - bars[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      if (i <= rsiPeriod) {
        rsiAvgGain = (rsiAvgGain * (i - 1) + gain) / i;
        rsiAvgLoss = (rsiAvgLoss * (i - 1) + loss) / i;
      } else {
        rsiAvgGain = (rsiAvgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        rsiAvgLoss = (rsiAvgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
      }
      const rs = rsiAvgLoss === 0 ? 100 : rsiAvgGain / rsiAvgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }

    const adxPeriod = 14;
    if (i === 0) {
      adx.push(0); plusDI.push(0); minusDI.push(0);
    } else {
      const hi = b.high - bars[i - 1].high;
      const lo = bars[i - 1].low - b.low;
      const pDM = (hi > lo && hi > 0) ? hi : 0;
      const mDM = (lo > hi && lo > 0) ? lo : 0;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
      if (i <= adxPeriod) {
        smoothedTR += tr;
        smoothedPlusDM += pDM;
        smoothedMinusDM += mDM;
      } else {
        smoothedTR = smoothedTR - (smoothedTR / adxPeriod) + tr;
        smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / adxPeriod) + pDM;
        smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / adxPeriod) + mDM;
      }
      const pdi = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
      const mdi = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
      plusDI.push(pdi);
      minusDI.push(mdi);
      const diSum = pdi + mdi;
      const dx = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
      if (i <= adxPeriod * 2) {
        adx.push(dx);
      } else {
        adx.push((adx[i - 1] * (adxPeriod - 1) + dx) / adxPeriod);
      }
    }

    const bbPeriod = 20;
    if (i < bbPeriod - 1) {
      bbMiddle.push(b.close); bbUpper.push(b.close); bbLower.push(b.close); bbSqueeze.push(false);
    } else {
      const sl = bars.slice(i - bbPeriod + 1, i + 1);
      const mean = sl.reduce((s, x) => s + x.close, 0) / bbPeriod;
      const variance = sl.reduce((s, x) => s + (x.close - mean) ** 2, 0) / bbPeriod;
      const stddev = Math.sqrt(variance);
      bbMiddle.push(mean);
      bbUpper.push(mean + 2 * stddev);
      bbLower.push(mean - 2 * stddev);
      const bw = mean > 0 ? (4 * stddev) / mean : 0;
      bbSqueeze.push(bw < 0.02);
    }

    if (i < 50) {
      sma50.push(bars.slice(0, i + 1).reduce((s, x) => s + x.close, 0) / (i + 1));
    } else {
      sma50.push(bars.slice(i - 49, i + 1).reduce((s, x) => s + x.close, 0) / 50);
    }
    if (i < 200) {
      sma200.push(bars.slice(0, i + 1).reduce((s, x) => s + x.close, 0) / (i + 1));
    } else {
      sma200.push(bars.slice(i - 199, i + 1).reduce((s, x) => s + x.close, 0) / 200);
    }

    let ts = 0;
    if (ema9[i] > ema21[i]) ts += 1;
    if (b.close > ema50[i]) ts += 1;
    if (b.close > sma200[i]) ts += 1;
    if (macdHist[i] > 0) ts += 1;
    if (adx[i] > 25) ts += 1;
    if (rsi[i] > 50) ts += 1;
    trendStrength.push(ts);

    if (i < 20) {
      const sl = bars.slice(0, i + 1);
      avgRange.push(sl.reduce((s, x) => s + (x.high - x.low), 0) / sl.length);
      avgVol.push(sl.reduce((s, x) => s + x.volume, 0) / sl.length);
      atr.push(avgRange[i]);
    } else {
      const sl = bars.slice(i - 19, i + 1);
      avgRange.push(sl.reduce((s, x) => s + (x.high - x.low), 0) / 20);
      avgVol.push(sl.reduce((s, x) => s + x.volume, 0) / 20);
      const atrSlice = bars.slice(i - 13, i + 1);
      atr.push(atrSlice.reduce((s, x) => s + (x.high - x.low), 0) / 14);
    }

    const avgP = ema21[i] || b.close;
    const emaDiffPct = avgP > 0 ? Math.abs(ema9[i] - ema21[i]) / avgP : 0;
    sideways.push(emaDiffPct < 0.003);

    if (i >= 3 && i % 3 === 0) {
      const lb2 = bars[i - 2];
      const lb1 = bars[i - 1];
      if (b.high > rollingPivotHigh) {
        if (rollingPivotHigh > prevPivotHigh) hph++;
        else lph++;
        prevPivotHigh = rollingPivotHigh;
        rollingPivotHigh = b.high;
      }
      if (b.low < rollingPivotLow) {
        if (rollingPivotLow < prevPivotLow) lpl++;
        else hpl++;
        prevPivotLow = rollingPivotLow;
        rollingPivotLow = b.low;
      }
    }
    pivotHighs.push(rollingPivotHigh);
    pivotLows.push(rollingPivotLow);

    const trendScore = (hph + hpl) - (lph + lpl);
    const isHTFUp = trendScore >= 2 && ema9[i] > ema21[i] && b.close > ema21[i];
    const isHTFDown = trendScore <= -2 && ema9[i] < ema21[i] && b.close < ema21[i];
    htfUp.push(isHTFUp);
    htfDown.push(isHTFDown);

    if (i === 0) {
      gapUp.push(false);
      gapDown.push(false);
      level2GapUp.push(false);
      level2GapDown.push(false);
    } else {
      gapUp.push(b.open > bars[i - 1].close * 1.005);
      gapDown.push(b.open < bars[i - 1].close * 0.995);
      level2GapUp.push(b.open > bars[i - 1].close * 1.01);
      level2GapDown.push(b.open < bars[i - 1].close * 0.99);
    }

    if (i >= 20) {
      const wWindow = bars.slice(i - 19, i + 1);
      const rollingLow = Math.min(...wWindow.map(wb => wb.low));
      const rollingHigh = Math.max(...wWindow.map(wb => wb.high));
      const avgP = ema21[i] || b.close;
      const nearRollingLow = Math.abs(b.low - rollingLow) / avgP < 0.003;
      const lowTouches = wWindow.filter(wb => Math.abs(wb.low - rollingLow) / avgP < 0.003).length;
      wBottom.push(nearRollingLow && lowTouches >= 2 && bottomingTail[i]);
      const nearRollingHigh = Math.abs(b.high - rollingHigh) / avgP < 0.003;
      const highTouches = wWindow.filter(wb => Math.abs(wb.high - rollingHigh) / avgP < 0.003).length;
      wTop.push(nearRollingHigh && highTouches >= 2 && toppingTail[i]);
    } else {
      wBottom.push(false);
      wTop.push(false);
    }

    if (i >= 7) {
      const paraLookback = bars.slice(i - 7, i);
      const consDown7 = paraLookback.every(pb => pb.close < pb.open);
      const consUp7 = paraLookback.every(pb => pb.close > pb.open);
      const distFromMA = ema21[i] > 0 ? Math.abs(b.close - ema21[i]) / ema21[i] : 0;
      const accelRange = range[i] > avgRange[i] * 2;
      isParabolic.push((consDown7 || consUp7) && distFromMA > 0.03 && accelRange);
    } else {
      isParabolic.push(false);
    }

    if (i < 5) {
      volType.push("NORMAL");
    } else {
      const prevBars = bars.slice(i - 5, i);
      const consDown = prevBars.every(pb => pb.close < pb.open);
      const consUp = prevBars.every(pb => pb.close > pb.open);
      const isExtended = consDown || consUp;

      if (isExtended && b.volume > avgVol[i] * 2.5 && r > avgRange[i] * 2 && bd < 0.3 * r) {
        volType.push("ENDING");
      } else if (b.volume > avgVol[i] * 1.5 && r > avgRange[i] * 1.5) {
        volType.push("IGNITING");
      } else if (b.volume < avgVol[i] * 0.6 && r < avgRange[i] * 0.5) {
        volType.push("RESTING");
      } else {
        volType.push("NORMAL");
      }
    }
  }

  return { bars, ema21, ema9, ema50, ema200, avgRange, avgVol, atr, range, body, green, tail, wick, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, pivotHighs, pivotLows, gapUp, gapDown, level2GapUp, level2GapDown, isParabolic, wBottom, wTop, macdLine, macdSignal, macdHist, adx, plusDI, minusDI, bbUpper, bbLower, bbMiddle, bbSqueeze, rsi, sma50, sma200, trendStrength };
}

interface Signal {
  index: number;
  direction: "LONG" | "SHORT";
  pattern: string;
  confluence?: number;
  volType?: VolType;
}

function getBacktestVPBonus(bars: { close: number; high: number; low: number; volume: number }[], idx: number): number {
  const lookback = Math.min(50, idx);
  if (lookback < 20) return 0;

  const slice = bars.slice(idx - lookback, idx);
  const volumeMap: Record<string, number> = {};
  let totalVolume = 0;

  slice.forEach(bar => {
    const price = (Math.round(bar.close * 100) / 100).toFixed(2);
    volumeMap[price] = (volumeMap[price] || 0) + bar.volume;
    totalVolume += bar.volume;
  });

  if (totalVolume === 0) return 0;

  const pocPrice = parseFloat(Object.keys(volumeMap).reduce((a, b) => volumeMap[a] > volumeMap[b] ? a : b));

  const sortedPrices = Object.keys(volumeMap).sort((a, b) => volumeMap[b] - volumeMap[a]);
  let vaVol = 0, vaHigh = pocPrice, vaLow = pocPrice;
  for (const price of sortedPrices) {
    vaVol += volumeMap[price];
    const p = parseFloat(price);
    if (p > vaHigh) vaHigh = p;
    if (p < vaLow) vaLow = p;
    if (vaVol >= totalVolume * 0.7) break;
  }

  const currentPrice = bars[idx].close;
  const recentBars = bars.slice(Math.max(0, idx - 10), idx);
  const avgVol = recentBars.reduce((s, b) => s + b.volume, 0) / (recentBars.length || 1);
  const hasVolSurge = bars[idx].volume > avgVol * 1.3;

  const priceRange = Math.max(...slice.map(b => b.high)) - Math.min(...slice.map(b => b.low));
  const pocThreshold = priceRange * 0.005;

  let vpBonus = 0;
  if (Math.abs(currentPrice - pocPrice) < pocThreshold && hasVolSurge) vpBonus += 1;
  if ((currentPrice > vaHigh || currentPrice < vaLow) && hasVolSurge) vpBonus += 1;
  if (currentPrice >= vaLow && currentPrice <= vaHigh && Math.abs(currentPrice - pocPrice) > pocThreshold) vpBonus += 0.5;

  return Math.min(vpBonus, 2);
}

function getBacktestOFBonus(bars: { close: number; open: number; high: number; low: number; volume: number }[], idx: number, direction: "LONG" | "SHORT"): number {
  const lookback = Math.min(20, idx);
  if (lookback < 10) return 0;

  const slice = bars.slice(idx - lookback, idx + 1);
  let cumulativeDelta = 0;
  let buyVolume = 0;
  let sellVolume = 0;

  slice.forEach(bar => {
    const bullish = bar.close >= bar.open;
    const barDelta = bullish ? bar.volume : -bar.volume;
    cumulativeDelta += barDelta;
    if (bullish) buyVolume += bar.volume;
    else sellVolume += bar.volume;
  });

  const totalVol = buyVolume + sellVolume;
  if (totalVol === 0) return 0;

  const imbalance = Math.abs(buyVolume - sellVolume) / totalVol;

  const last10 = slice.slice(-10);
  const avgVol = last10.reduce((s, b) => s + b.volume, 0) / last10.length;
  const avgRange = last10.reduce((s, b) => s + (b.high - b.low), 0) / last10.length;
  const lastBar = slice[slice.length - 1];

  const priceMove = slice[slice.length - 1].close - slice[0].open;
  const avgDelta = cumulativeDelta / slice.length;

  let ofBonus = 0;

  if (imbalance > 0.6) {
    const imbalanceBullish = buyVolume > sellVolume;
    if ((direction === "LONG" && imbalanceBullish) || (direction === "SHORT" && !imbalanceBullish)) {
      ofBonus += 1;
    }
  }

  if (Math.sign(avgDelta) !== Math.sign(priceMove)) {
    ofBonus += 1;
  }

  const lastBody = Math.abs(lastBar.close - lastBar.open);
  if (lastBar.volume > avgVol * 1.5 && lastBody < avgRange * 0.5) {
    ofBonus += 1;
  }

  return Math.min(ofBonus, 3);
}

function getBacktestVWAPBonus(bars: { close: number; high: number; low: number; volume: number }[], idx: number, direction: "LONG" | "SHORT"): number {
  const lookback = Math.min(50, idx);
  if (lookback < 20) return 0;
  const slice = bars.slice(idx - lookback, idx + 1);
  let cumPV = 0;
  let cumVol = 0;
  slice.forEach(bar => {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumPV += tp * bar.volume;
    cumVol += bar.volume;
  });
  if (cumVol === 0) return 0;
  const vwap = cumPV / cumVol;
  const price = bars[idx].close;
  if (price > vwap && direction === "LONG") return 1;
  if (price < vwap && direction === "SHORT") return 1;
  return 0;
}

function getBacktestRSIBonus(bars: { close: number }[], idx: number, direction: "LONG" | "SHORT"): number {
  const period = 14;
  if (idx < period) return 0;
  const closes = [];
  for (let i = idx - period; i <= idx; i++) closes.push(bars[i].close);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return direction === "SHORT" ? -1 : 0;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  if (direction === "LONG") {
    if (rsi >= 30 && rsi <= 45) return 2;
    if (rsi >= 45 && rsi <= 55) return 1;
    if (rsi > 80) return -1;
  } else {
    if (rsi >= 55 && rsi <= 70) return 1;
    if (rsi >= 70) return 2;
    if (rsi < 20) return -1;
  }
  return 0;
}

function detect3BarPlay(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, range, body, green, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown, tail, wick } = data;

  for (let i = 3; i < bars.length; i++) {
    const ignitingIdx = i - 2;
    const restingIdx = i - 1;
    const triggerIdx = i;

    if (ignitingIdx < 1) continue;
    if (sideways[triggerIdx]) continue;

    const trendUp = ema9[triggerIdx] > ema21[triggerIdx];
    const trendDown = ema9[triggerIdx] < ema21[triggerIdx];

    const isIgnitingLong = green[ignitingIdx] &&
      range[ignitingIdx] > 1.5 * avgRange[ignitingIdx] &&
      bars[ignitingIdx].volume > 1.5 * avgVol[ignitingIdx] &&
      body[ignitingIdx] > 0.5 * range[ignitingIdx];

    const isRestingLong = range[restingIdx] < 0.5 * range[ignitingIdx] &&
      bars[restingIdx].low > bars[ignitingIdx].low - 0.1 * range[ignitingIdx];

    const volumeSurgeLong = bars[triggerIdx].volume > 1.5 * avgVol[triggerIdx] &&
      bars[triggerIdx].volume > bars[restingIdx].volume;

    const isTriggerLong = green[triggerIdx] &&
      bars[triggerIdx].close > bars[restingIdx].high &&
      volumeSurgeLong &&
      bars[triggerIdx].close > ema21[triggerIdx] &&
      trendUp;

    if (isIgnitingLong && isRestingLong && isTriggerLong) {
      const conf = [
        volumeSurgeLong,
        volType[triggerIdx] === "IGNITING",
        bottomingTail[restingIdx],
        bars[triggerIdx].close > ema9[triggerIdx],
        body[triggerIdx] > 0.5 * range[triggerIdx],
        htfUp[triggerIdx],
        tail[triggerIdx] > 0.3 * range[triggerIdx],
        gapUp[triggerIdx],
        level2GapUp[triggerIdx],
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "LONG", pattern: "3 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }

    const isIgnitingShort = !green[ignitingIdx] &&
      range[ignitingIdx] > 1.5 * avgRange[ignitingIdx] &&
      bars[ignitingIdx].volume > 1.5 * avgVol[ignitingIdx] &&
      body[ignitingIdx] > 0.5 * range[ignitingIdx];

    const isRestingShort = range[restingIdx] < 0.5 * range[ignitingIdx] &&
      bars[restingIdx].high < bars[ignitingIdx].high + 0.1 * range[ignitingIdx];

    const volumeSurgeShort = bars[triggerIdx].volume > 1.5 * avgVol[triggerIdx] &&
      bars[triggerIdx].volume > bars[restingIdx].volume;

    const isTriggerShort = !green[triggerIdx] &&
      bars[triggerIdx].close < bars[restingIdx].low &&
      volumeSurgeShort &&
      bars[triggerIdx].close < ema21[triggerIdx] &&
      trendDown;

    if (isIgnitingShort && isRestingShort && isTriggerShort) {
      const conf = [
        volumeSurgeShort,
        volType[triggerIdx] === "IGNITING",
        toppingTail[restingIdx],
        bars[triggerIdx].close < ema9[triggerIdx],
        body[triggerIdx] > 0.5 * range[triggerIdx],
        htfDown[triggerIdx],
        wick[triggerIdx] > 0.3 * range[triggerIdx],
        gapDown[triggerIdx],
        level2GapDown[triggerIdx],
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "SHORT", pattern: "3 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }
  }
  return signals;
}

function detect4BarPlay(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, range, body, green, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, tail, wick, gapUp, gapDown, level2GapUp, level2GapDown } = data;

  for (let i = 4; i < bars.length; i++) {
    const ignitingIdx = i - 3;
    const resting1Idx = i - 2;
    const resting2Idx = i - 1;
    const triggerIdx = i;

    if (ignitingIdx < 1) continue;
    if (sideways[triggerIdx]) continue;

    const trendUp = ema9[triggerIdx] > ema21[triggerIdx];
    const trendDown = ema9[triggerIdx] < ema21[triggerIdx];

    const isIgnitingLong = green[ignitingIdx] &&
      range[ignitingIdx] > 1.5 * avgRange[ignitingIdx] &&
      bars[ignitingIdx].volume > 1.5 * avgVol[ignitingIdx] &&
      body[ignitingIdx] > 0.5 * range[ignitingIdx];

    const isResting1Long = range[resting1Idx] < 0.5 * range[ignitingIdx] &&
      bars[resting1Idx].low > bars[ignitingIdx].low - 0.1 * range[ignitingIdx];
    const isResting2Long = range[resting2Idx] < 0.5 * range[ignitingIdx] &&
      bars[resting2Idx].low > bars[ignitingIdx].low - 0.1 * range[ignitingIdx];

    const volumeSurgeLong = bars[triggerIdx].volume > 1.5 * avgVol[triggerIdx] &&
      bars[triggerIdx].volume > Math.max(bars[resting1Idx].volume, bars[resting2Idx].volume);

    const restingHigh = Math.max(bars[resting1Idx].high, bars[resting2Idx].high);
    const isTriggerLong = green[triggerIdx] &&
      bars[triggerIdx].close > restingHigh &&
      volumeSurgeLong &&
      bars[triggerIdx].close > ema21[triggerIdx] &&
      trendUp;

    if (isIgnitingLong && isResting1Long && isResting2Long && isTriggerLong) {
      const conf = [
        volumeSurgeLong,
        volType[triggerIdx] === "IGNITING",
        bottomingTail[resting1Idx] || bottomingTail[resting2Idx],
        bars[triggerIdx].close > ema9[triggerIdx],
        body[triggerIdx] > 0.5 * range[triggerIdx],
        htfUp[triggerIdx],
        true,
        gapUp[triggerIdx],
        level2GapUp[triggerIdx],
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "LONG", pattern: "4 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }

    const isIgnitingShort = !green[ignitingIdx] &&
      range[ignitingIdx] > 1.5 * avgRange[ignitingIdx] &&
      bars[ignitingIdx].volume > 1.5 * avgVol[ignitingIdx] &&
      body[ignitingIdx] > 0.5 * range[ignitingIdx];

    const isResting1Short = range[resting1Idx] < 0.5 * range[ignitingIdx] &&
      bars[resting1Idx].high < bars[ignitingIdx].high + 0.1 * range[ignitingIdx];
    const isResting2Short = range[resting2Idx] < 0.5 * range[ignitingIdx] &&
      bars[resting2Idx].high < bars[ignitingIdx].high + 0.1 * range[ignitingIdx];

    const volumeSurgeShort = bars[triggerIdx].volume > 1.5 * avgVol[triggerIdx] &&
      bars[triggerIdx].volume > Math.max(bars[resting1Idx].volume, bars[resting2Idx].volume);

    const restingLow = Math.min(bars[resting1Idx].low, bars[resting2Idx].low);
    const isTriggerShort = !green[triggerIdx] &&
      bars[triggerIdx].close < restingLow &&
      volumeSurgeShort &&
      bars[triggerIdx].close < ema21[triggerIdx] &&
      trendDown;

    if (isIgnitingShort && isResting1Short && isResting2Short && isTriggerShort) {
      const conf = [
        volumeSurgeShort,
        volType[triggerIdx] === "IGNITING",
        toppingTail[resting1Idx] || toppingTail[resting2Idx],
        bars[triggerIdx].close < ema9[triggerIdx],
        body[triggerIdx] > 0.5 * range[triggerIdx],
        htfDown[triggerIdx],
        true,
        gapDown[triggerIdx],
        level2GapDown[triggerIdx],
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "SHORT", pattern: "4 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }
  }
  return signals;
}

function detectBuySetup(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, bottomingTail, toppingTail, volType, sideways, body, range, htfUp, htfDown, tail, wick, gapUp, gapDown, level2GapUp, level2GapDown } = data;

  for (let i = 4; i < bars.length; i++) {
    if (sideways[i]) continue;

    const prevBars = [bars[i - 3], bars[i - 2], bars[i - 1]];
    const curr = bars[i];
    const trendUp = ema9[i] > ema21[i];
    const trendDown = ema9[i] < ema21[i];

    const pullbackCount = prevBars.filter(b => b.close < b.open).length;
    const nearEma = Math.abs(bars[i - 1].low - ema21[i - 1]) / ema21[i - 1] < 0.005;
    const greenReversal = green[i] && curr.close > bars[i - 1].high;
    const volSurge = curr.volume > avgVol[i] * 1.5;
    const aboveEma = curr.close > ema9[i];

    if (pullbackCount >= 2 && nearEma && greenReversal && volSurge && aboveEma && trendUp) {
      const hasTail = bottomingTail[i] || bottomingTail[i - 1];
      const conf = [
        volSurge,
        volType[i] === "IGNITING",
        hasTail,
        body[i] > 0.5 * range[i],
        curr.close > ema21[i],
        htfUp[i],
        tail[i] > 0.3 * range[i],
        gapUp[i],
        level2GapUp[i],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "LONG", pattern: "Buy Setup", confluence: conf, volType: volType[i] });
    }

    const rallyCount = prevBars.filter(b => b.close > b.open).length;
    const nearEmaShort = Math.abs(bars[i - 1].high - ema21[i - 1]) / ema21[i - 1] < 0.005;
    const redReversal = !green[i] && curr.close < bars[i - 1].low;
    const belowEma = curr.close < ema9[i];

    if (rallyCount >= 2 && nearEmaShort && redReversal && volSurge && belowEma && trendDown) {
      const hasTail = toppingTail[i] || toppingTail[i - 1];
      const conf = [
        volSurge,
        volType[i] === "IGNITING",
        hasTail,
        body[i] > 0.5 * range[i],
        curr.close < ema21[i],
        htfDown[i],
        wick[i] > 0.3 * range[i],
        gapDown[i],
        level2GapDown[i],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Sell Setup", confluence: conf, volType: volType[i] });
    }
  }
  return signals;
}

function detectRetestSetup(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, bottomingTail, toppingTail, volType, sideways, body, range, htfUp, htfDown, tail, wick, pivotHighs, pivotLows, gapUp, gapDown, level2GapUp, level2GapDown, wBottom, wTop } = data;

  for (let i = 15; i < bars.length; i++) {
    if (sideways[i]) continue;

    const curr = bars[i];
    const trendUp = ema9[i] > ema21[i];
    const trendDown = ema9[i] < ema21[i];

    const lookback = bars.slice(Math.max(0, i - 20), i);
    const priorHigh = Math.max(...lookback.map(b => b.high));
    const priorLow = Math.min(...lookback.map(b => b.low));
    const avgPrice = ema21[i] || curr.close;
    const nearPriorLow = Math.abs(curr.low - priorLow) / avgPrice < 0.005;
    const nearPriorHigh = Math.abs(curr.high - priorHigh) / avgPrice < 0.005;

    const pullback = bars.slice(i - 3, i);
    const pullbackDown = pullback.filter(b => b.close < b.open).length >= 2;
    const pullbackUp = pullback.filter(b => b.close > b.open).length >= 2;
    const volSurge = curr.volume > avgVol[i] * 1.2;

    const doubleBottomLows = lookback.filter(b => Math.abs(b.low - priorLow) / avgPrice < 0.003);
    const isDoubleBottom = doubleBottomLows.length >= 2;
    const doubleTopHighs = lookback.filter(b => Math.abs(b.high - priorHigh) / avgPrice < 0.003);
    const isDoubleTop = doubleTopHighs.length >= 2;

    const isWBottom = wBottom[i];
    const isWTop = wTop[i];

    if (nearPriorLow && pullbackDown && green[i] && curr.close > bars[i - 1].high && trendUp) {
      const nearMA = Math.abs(curr.close - ema21[i]) / avgPrice < 0.005;
      const hasTail = bottomingTail[i] || bottomingTail[i - 1];
      const conf = [
        volSurge,
        hasTail,
        nearMA,
        body[i] > 0.4 * range[i],
        curr.close > ema9[i],
        htfUp[i],
        volType[i] === "IGNITING" || volType[i] === "NORMAL",
        isDoubleBottom,
        gapUp[i],
        level2GapUp[i],
        isWBottom,
      ].filter(Boolean).length;
      if (conf >= 3) {
        const patternName = isWBottom ? "W-Bottom Retest" : isDoubleBottom ? "Double Bottom Retest" : "Retest Buy";
        signals.push({ index: i, direction: "LONG", pattern: patternName, confluence: conf, volType: volType[i] });
      }
    }

    if (nearPriorHigh && pullbackUp && !green[i] && curr.close < bars[i - 1].low && trendDown) {
      const nearMA = Math.abs(curr.close - ema21[i]) / avgPrice < 0.005;
      const hasTail = toppingTail[i] || toppingTail[i - 1];
      const conf = [
        volSurge,
        hasTail,
        nearMA,
        body[i] > 0.4 * range[i],
        curr.close < ema9[i],
        htfDown[i],
        volType[i] === "IGNITING" || volType[i] === "NORMAL",
        isDoubleTop,
        gapDown[i],
        level2GapDown[i],
        isWTop,
      ].filter(Boolean).length;
      if (conf >= 3) {
        const patternName = isWTop ? "W-Top Retest" : isDoubleTop ? "Double Top Retest" : "Retest Sell";
        signals.push({ index: i, direction: "SHORT", pattern: patternName, confluence: conf, volType: volType[i] });
      }
    }
  }
  return signals;
}

function detectBreakout(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, green, volType, sideways, body, range, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown } = data;

  for (let i = 10; i < bars.length; i++) {
    if (sideways[i]) continue;

    const lookback = bars.slice(i - 10, i);
    const rangeHigh = Math.max(...lookback.map(b => b.high));
    const rangeLow = Math.min(...lookback.map(b => b.low));
    const consolidationRange = rangeHigh - rangeLow;
    const avgR = avgRange[i];

    const isConsolidation = consolidationRange < avgR * 3;
    if (!isConsolidation) continue;

    const curr = bars[i];
    const volSurge = curr.volume > avgVol[i] * 1.5;

    if (green[i] && curr.close > rangeHigh && volSurge && curr.close > ema21[i] && ema9[i] > ema21[i]) {
      const conf = [
        volSurge,
        volType[i] === "IGNITING",
        body[i] > 0.6 * range[i],
        curr.close > ema9[i],
        htfUp[i],
        gapUp[i],
        level2GapUp[i],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "LONG", pattern: "Breakout", confluence: conf, volType: volType[i] });
    }
    if (!green[i] && curr.close < rangeLow && volSurge && curr.close < ema21[i] && ema9[i] < ema21[i]) {
      const conf = [
        volSurge,
        volType[i] === "IGNITING",
        body[i] > 0.6 * range[i],
        curr.close < ema9[i],
        htfDown[i],
        gapDown[i],
        level2GapDown[i],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Breakout", confluence: conf, volType: volType[i] });
    }
  }
  return signals;
}

function detectClimaxReversal(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, avgRange, avgVol, range, green, bottomingTail, toppingTail, volType, body, tail, wick, isParabolic, gapUp, gapDown, level2GapUp, level2GapDown } = data;

  for (let i = 6; i < bars.length; i++) {
    if (isParabolic[i]) continue;

    const lookback = bars.slice(i - 5, i);
    const consecutiveDown = lookback.every(b => b.close < b.open);
    const wideRangeBars = lookback.filter((b, j) => (b.high - b.low) > 1.5 * avgRange[i - 5 + j]).length >= 3;
    const volumeSpike = bars[i - 1].volume > avgVol[i - 1] * 2;
    const distFromEma = Math.abs(bars[i - 1].close - ema21[i - 1]) / ema21[i - 1] > 0.02;
    const greenReversal = green[i] && bars[i].close > bars[i - 1].high;
    const endingVol = volType[i - 1] === "ENDING";

    if (consecutiveDown && wideRangeBars && volumeSpike && distFromEma && greenReversal) {
      const conf = [
        endingVol,
        bottomingTail[i] || bottomingTail[i - 1],
        body[i] > 0.5 * range[i],
        bars[i].volume > avgVol[i],
        tail[i] > 0.3 * range[i],
        gapDown[i - 1] || gapDown[i - 2],
        level2GapDown[i - 1] || level2GapDown[i - 2],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "LONG", pattern: "Climax Reversal", confluence: conf, volType: volType[i - 1] });
    }

    const consecutiveUp = lookback.every(b => b.close > b.open);
    const redReversal = !green[i] && bars[i].close < bars[i - 1].low;

    if (consecutiveUp && wideRangeBars && volumeSpike && distFromEma && redReversal) {
      const conf = [
        endingVol,
        toppingTail[i] || toppingTail[i - 1],
        body[i] > 0.5 * range[i],
        bars[i].volume > avgVol[i],
        wick[i] > 0.3 * range[i],
        gapUp[i - 1] || gapUp[i - 2],
        level2GapUp[i - 1] || level2GapUp[i - 2],
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Climax Reversal", confluence: conf, volType: volType[i - 1] });
    }
  }
  return signals;
}

function simulateTrades(data: ReturnType<typeof addIndicators>, signals: Signal[], rrRatio = 2, maxHold = 5, pointValue = 50): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const { bars, atr, rsi: rsiArr, adx: adxArr, macdHist, bbUpper, bbLower, trendStrength, ema50, sma200 } = data;

  for (const sig of signals) {
    const i = sig.index;
    if (i >= bars.length - 1) continue;
    const entry = bars[i].close;
    const risk = atr[i];
    if (risk <= 0) continue;

    let sl: number, tp: number;
    if (sig.direction === "LONG") {
      sl = entry - risk;
      tp = entry + risk * rrRatio;
    } else {
      sl = entry + risk;
      tp = entry - risk * rrRatio;
    }

    let exit = entry;
    let outcome: "WIN" | "LOSS" | "TIMEOUT" = "TIMEOUT";
    let holdBars = 0;

    for (let j = 1; j <= maxHold; j++) {
      const fi = i + j;
      if (fi >= bars.length) break;
      holdBars = j;
      const bar = bars[fi];

      if (sig.direction === "LONG") {
        if (bar.low <= sl) { exit = sl; outcome = "LOSS"; break; }
        if (bar.high >= tp) { exit = tp; outcome = "WIN"; break; }
      } else {
        if (bar.high >= sl) { exit = sl; outcome = "LOSS"; break; }
        if (bar.low <= tp) { exit = tp; outcome = "WIN"; break; }
      }
      exit = bar.close;
    }

    const pnlPoints = sig.direction === "LONG" ? exit - entry : entry - exit;
    const pnlPct = (pnlPoints / entry) * 100;
    const pnlDollars = pnlPoints * pointValue;
    const entryDate = new Date(bars[i].timestamp);
    const dateStr = entryDate.toISOString().slice(0, 10);
    const etHour = new Date(entryDate.getTime() - 5 * 3600000).getUTCHours();
    const dayOfWeek = entryDate.getUTCDay();

    const curRsi = rsiArr[i] || 50;
    const curAdx = adxArr[i] || 0;
    const macdBull = macdHist[i] > 0;
    let bbPos = "MIDDLE";
    if (bars[i].close > bbUpper[i]) bbPos = "ABOVE";
    else if (bars[i].close < bbLower[i]) bbPos = "BELOW";
    else if (bars[i].close > (bbUpper[i] + bbLower[i]) / 2) bbPos = "UPPER";
    else bbPos = "LOWER";

    trades.push({
      date: dateStr,
      hour: etHour,
      dayOfWeek,
      entry: Math.round(entry * 100) / 100,
      stop: Math.round(sl * 100) / 100,
      target: Math.round(tp * 100) / 100,
      exit: Math.round(exit * 100) / 100,
      pnlPct: Math.round(pnlPct * 1000) / 1000,
      pnlDollars: Math.round(pnlDollars * 100) / 100,
      outcome,
      holdBars,
      pattern: sig.pattern,
      direction: sig.direction,
      confluence: sig.confluence,
      volType: sig.volType,
      rsiVal: Math.round(curRsi * 10) / 10,
      adxVal: Math.round(curAdx * 10) / 10,
      macdBullish: macdBull,
      bbPosition: bbPos,
      trendScore: trendStrength[i] || 0,
      aboveEma50: bars[i].close > ema50[i],
      aboveSma200: bars[i].close > sma200[i],
    });
  }
  return trades;
}

function computeResults(trades: BacktestTrade[], symbol: string, pattern: string, period: string, dataPoints: number): BacktestResult {
  const wins = trades.filter(t => t.outcome === "WIN").length;
  const losses = trades.filter(t => t.outcome === "LOSS").length;
  const timeouts = trades.filter(t => t.outcome === "TIMEOUT").length;
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0;

  const avgProfitPct = trades.length > 0
    ? Math.round(trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length * 1000) / 1000
    : 0;

  const winTrades = trades.filter(t => t.pnlPct > 0);
  const lossTrades = trades.filter(t => t.pnlPct < 0);
  const avgWinPct = winTrades.length > 0
    ? Math.round(winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length * 1000) / 1000
    : 0;
  const avgLossPct = lossTrades.length > 0
    ? Math.round(lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length * 1000) / 1000
    : 0;

  const grossProfit = winTrades.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnlDollars, 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 99.99 : 0;

  const totalPnlDollars = Math.round(trades.reduce((s, t) => s + t.pnlDollars, 0) * 100) / 100;

  let peak = 0;
  let maxDD = 0;
  let equity = 0;
  for (const t of trades) {
    equity += t.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = peak > 0 ? Math.round((maxDD / peak) * 10000) / 100 : 0;

  const avgWinDollars = winTrades.length > 0 ? grossProfit / winTrades.length : 0;
  const avgLossDollars = lossTrades.length > 0 ? grossLoss / lossTrades.length : 0;
  const expectancy = trades.length > 0
    ? Math.round(((winRate / 100 * avgWinDollars) - ((1 - winRate / 100) * avgLossDollars)) * 100) / 100
    : 0;

  const bestTrade = trades.length > 0 ? Math.max(...trades.map(t => t.pnlDollars)) : 0;
  const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.pnlDollars)) : 0;

  return {
    symbol, pattern, period, totalTrades: trades.length,
    wins, losses, timeouts, winRate,
    avgProfitPct, avgWinPct, avgLossPct,
    totalPnlDollars, maxDrawdownPct, profitFactor, expectancy,
    bestTrade: Math.round(bestTrade * 100) / 100,
    worstTrade: Math.round(worstTrade * 100) / 100,
    trades: trades.slice(-50),
    allTrades: trades,
    dataPoints,
  };
}

function findLocalPeaks(values: number[], distance: number): number[] {
  const peaks: number[] = [];
  for (let i = distance; i < values.length - distance; i++) {
    let isPeak = true;
    for (let j = 1; j <= distance; j++) {
      if (values[i] <= values[i - j] || values[i] <= values[i + j]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) peaks.push(i);
  }
  return peaks;
}

function findLocalTroughs(values: number[], distance: number): number[] {
  const troughs: number[] = [];
  for (let i = distance; i < values.length - distance; i++) {
    let isTrough = true;
    for (let j = 1; j <= distance; j++) {
      if (values[i] >= values[i - j] || values[i] >= values[i + j]) {
        isTrough = false;
        break;
      }
    }
    if (isTrough) troughs.push(i);
  }
  return troughs;
}

function linregSlope(values: number[]): number {
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

function detectCupAndHandle(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, volType, body, range, htfUp, gapUp, level2GapUp, bottomingTail } = data;
  const cupMin = 15;
  const cupMax = 60;
  const peakDist = 5;

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, peakDist);
  const troughs = findLocalTroughs(lows, peakDist);

  for (let pi = 0; pi < peaks.length - 1; pi++) {
    const leftRim = peaks[pi];
    const rightRim = peaks[pi + 1];
    const cupWidth = rightRim - leftRim;
    if (cupWidth < cupMin || cupWidth > cupMax) continue;

    const rimDiffPct = Math.abs(highs[leftRim] - highs[rightRim]) / highs[leftRim];
    if (rimDiffPct > 0.02) continue;

    const cupTroughs = troughs.filter(t => t > leftRim && t < rightRim);
    if (cupTroughs.length === 0) continue;
    const cupBottom = cupTroughs.reduce((a, b) => lows[a] < lows[b] ? a : b);

    const cupDepth = Math.min(highs[leftRim], highs[rightRim]) - lows[cupBottom];
    const avgPrice = (highs[leftRim] + highs[rightRim]) / 2;
    if (cupDepth / avgPrice < 0.01) continue;

    const leftHalf = bars.slice(leftRim, cupBottom + 1);
    const rightHalf = bars.slice(cupBottom, rightRim + 1);
    const leftSlope = linregSlope(leftHalf.map(b => b.close));
    const rightSlope = linregSlope(rightHalf.map(b => b.close));
    if (leftSlope > 0 || rightSlope < 0) continue;

    const rimHigh = Math.max(highs[leftRim], highs[rightRim]);
    const handleMaxBars = Math.min(Math.floor(cupWidth * 0.4), 15);
    const handleEnd = Math.min(rightRim + handleMaxBars, bars.length - 2);

    let handleLow = Infinity;
    let handleFound = false;
    for (let h = rightRim + 1; h <= handleEnd; h++) {
      if (bars[h].low < handleLow) handleLow = bars[h].low;
      const handleRetrace = rimHigh - handleLow;
      if (handleRetrace > cupDepth * 0.5) break;

      if (h > rightRim + 2 &&
          green[h] &&
          bars[h].close > rimHigh &&
          bars[h].volume > 1.5 * avgVol[h] &&
          bars[h].close > ema21[h] &&
          ema9[h] > ema21[h]) {
        handleFound = true;
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfUp[h],
          gapUp[h],
          level2GapUp[h],
          bottomingTail[h] || (h > 0 && bottomingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "LONG", pattern: "Cup & Handle", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  return signals;
}

function detectInverseCupAndHandle(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, volType, body, range, htfDown, gapDown, level2GapDown, toppingTail } = data;
  const cupMin = 15;
  const cupMax = 60;
  const peakDist = 5;

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, peakDist);
  const troughs = findLocalTroughs(lows, peakDist);

  for (let ti = 0; ti < troughs.length - 1; ti++) {
    const leftRim = troughs[ti];
    const rightRim = troughs[ti + 1];
    const cupWidth = rightRim - leftRim;
    if (cupWidth < cupMin || cupWidth > cupMax) continue;

    const rimDiffPct = Math.abs(lows[leftRim] - lows[rightRim]) / lows[leftRim];
    if (rimDiffPct > 0.02) continue;

    const cupPeaks = peaks.filter(p => p > leftRim && p < rightRim);
    if (cupPeaks.length === 0) continue;
    const cupTop = cupPeaks.reduce((a, b) => highs[a] > highs[b] ? a : b);

    const cupDepth = highs[cupTop] - Math.max(lows[leftRim], lows[rightRim]);
    const avgPrice = (lows[leftRim] + lows[rightRim]) / 2;
    if (cupDepth / avgPrice < 0.01) continue;

    const leftHalf = bars.slice(leftRim, cupTop + 1);
    const rightHalf = bars.slice(cupTop, rightRim + 1);
    const leftSlope = linregSlope(leftHalf.map(b => b.close));
    const rightSlope = linregSlope(rightHalf.map(b => b.close));
    if (leftSlope < 0 || rightSlope > 0) continue;

    const rimLow = Math.min(lows[leftRim], lows[rightRim]);
    const handleMaxBars = Math.min(Math.floor(cupWidth * 0.4), 15);
    const handleEnd = Math.min(rightRim + handleMaxBars, bars.length - 2);

    let handleHigh = -Infinity;
    let handleFound = false;
    for (let h = rightRim + 1; h <= handleEnd; h++) {
      if (bars[h].high > handleHigh) handleHigh = bars[h].high;
      const handleRetrace = handleHigh - rimLow;
      if (handleRetrace > cupDepth * 0.5) break;

      if (h > rightRim + 2 &&
          !green[h] &&
          bars[h].close < rimLow &&
          bars[h].volume > 1.5 * avgVol[h] &&
          bars[h].close < ema21[h] &&
          ema9[h] < ema21[h]) {
        handleFound = true;
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfDown[h],
          gapDown[h],
          level2GapDown[h],
          toppingTail[h] || (h > 0 && toppingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "SHORT", pattern: "Inverse Cup & Handle", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  return signals;
}

function detectDoubleTopBottom(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, volType, body, range, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown, toppingTail, bottomingTail } = data;
  const peakDist = 5;

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, peakDist);
  const troughs = findLocalTroughs(lows, peakDist);

  for (let pi = 0; pi < peaks.length - 1; pi++) {
    const left = peaks[pi];
    const right = peaks[pi + 1];
    const dist = right - left;
    if (dist < 10 || dist > 60) continue;
    const diffPct = Math.abs(highs[left] - highs[right]) / highs[left];
    if (diffPct > 0.03) continue;

    const neckline = Math.min(...lows.slice(left, right + 1));
    const handleEnd = Math.min(right + Math.floor(dist * 0.3), bars.length - 1);
    for (let h = right + 1; h <= handleEnd; h++) {
      if (!green[h] && bars[h].close < neckline && bars[h].volume > 1.5 * avgVol[h] && bars[h].close < ema21[h]) {
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfDown[h],
          gapDown[h],
          level2GapDown[h],
          toppingTail[h] || (h > 0 && toppingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "SHORT", pattern: "Double Top", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  for (let ti = 0; ti < troughs.length - 1; ti++) {
    const left = troughs[ti];
    const right = troughs[ti + 1];
    const dist = right - left;
    if (dist < 10 || dist > 60) continue;
    const diffPct = Math.abs(lows[left] - lows[right]) / lows[left];
    if (diffPct > 0.03) continue;

    const neckline = Math.max(...highs.slice(left, right + 1));
    const handleEnd = Math.min(right + Math.floor(dist * 0.3), bars.length - 1);
    for (let h = right + 1; h <= handleEnd; h++) {
      if (green[h] && bars[h].close > neckline && bars[h].volume > 1.5 * avgVol[h] && bars[h].close > ema21[h]) {
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfUp[h],
          gapUp[h],
          level2GapUp[h],
          bottomingTail[h] || (h > 0 && bottomingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "LONG", pattern: "Double Bottom", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  return signals;
}

function detectHeadAndShoulders(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, volType, body, range, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown, toppingTail, bottomingTail } = data;
  const peakDist = 5;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const peaks = findLocalPeaks(highs, peakDist);
  const troughs = findLocalTroughs(lows, peakDist);

  for (let pi = 2; pi < peaks.length; pi++) {
    const ls = peaks[pi - 2];
    const head = peaks[pi - 1];
    const rs = peaks[pi];
    if (head - ls < 8 || rs - head < 8 || rs - ls > 80) continue;
    if (highs[head] <= highs[ls] || highs[head] <= highs[rs]) continue;
    const shoulderDiff = Math.abs(highs[ls] - highs[rs]) / highs[head];
    if (shoulderDiff > 0.08) continue;

    const leftLow = Math.min(...lows.slice(ls, head + 1));
    const rightLow = Math.min(...lows.slice(head, rs + 1));
    const neckSlope = (rightLow - leftLow) / (rs - ls);

    const breakEnd = Math.min(rs + Math.floor((rs - ls) * 0.3), bars.length - 1);
    for (let h = rs + 1; h <= breakEnd; h++) {
      const neckAt = leftLow + neckSlope * (h - ls);
      if (!green[h] && bars[h].close < neckAt && bars[h].volume > 1.5 * avgVol[h] && bars[h].close < ema21[h]) {
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfDown[h],
          gapDown[h],
          level2GapDown[h],
          toppingTail[h] || (h > 0 && toppingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "SHORT", pattern: "Head & Shoulders", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  for (let ti = 2; ti < troughs.length; ti++) {
    const ls = troughs[ti - 2];
    const head = troughs[ti - 1];
    const rs = troughs[ti];
    if (head - ls < 8 || rs - head < 8 || rs - ls > 80) continue;
    if (lows[head] >= lows[ls] || lows[head] >= lows[rs]) continue;
    const shoulderDiff = Math.abs(lows[ls] - lows[rs]) / lows[head];
    if (shoulderDiff > 0.08) continue;

    const leftHigh = Math.max(...highs.slice(ls, head + 1));
    const rightHigh = Math.max(...highs.slice(head, rs + 1));
    const neckSlope = (rightHigh - leftHigh) / (rs - ls);

    const breakEnd = Math.min(rs + Math.floor((rs - ls) * 0.3), bars.length - 1);
    for (let h = rs + 1; h <= breakEnd; h++) {
      const neckAt = leftHigh + neckSlope * (h - ls);
      if (green[h] && bars[h].close > neckAt && bars[h].volume > 1.5 * avgVol[h] && bars[h].close > ema21[h]) {
        const conf = [
          bars[h].volume > 1.5 * avgVol[h],
          volType[h] === "IGNITING",
          body[h] > 0.5 * range[h],
          htfUp[h],
          gapUp[h],
          level2GapUp[h],
          bottomingTail[h] || (h > 0 && bottomingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "LONG", pattern: "Inverse Head & Shoulders", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  return signals;
}

function detectWedgeBreakout(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, avgRange, green, volType, body, range, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown, toppingTail, bottomingTail } = data;
  const windows = [20, 30];

  for (const window of windows) {
    for (let i = window + 1; i < bars.length; i++) {
      const slice = bars.slice(i - window, i);
      const sliceHighs = slice.map(b => b.high);
      const sliceLows = slice.map(b => b.low);

      const highSlope = linregSlope(sliceHighs);
      const lowSlope = linregSlope(sliceLows);

      const highRange = Math.max(...sliceHighs) - Math.min(...sliceHighs);
      const lowRange = Math.max(...sliceLows) - Math.min(...sliceLows);
      const avgPrice = slice[slice.length - 1].close;
      if (highRange / avgPrice < 0.005 || lowRange / avgPrice < 0.005) continue;

      const convergence = Math.abs(highSlope - lowSlope);
      const maxSlope = Math.max(Math.abs(highSlope), Math.abs(lowSlope));
      if (maxSlope === 0) continue;
      const convergenceRatio = convergence / maxSlope;

      const halfVol = slice.slice(0, Math.floor(window / 2));
      const recentVol = slice.slice(Math.floor(window / 2));
      const earlyAvgVol = halfVol.reduce((s, b) => s + b.volume, 0) / halfVol.length;
      const lateAvgVol = recentVol.reduce((s, b) => s + b.volume, 0) / recentVol.length;
      const volDecline = lateAvgVol < earlyAvgVol * 0.9;

      const curr = bars[i];
      const volSurge = curr.volume > 1.5 * avgVol[i];

      if (highSlope > 0 && lowSlope > 0 && convergenceRatio < 0.5 && volDecline) {
        if (!green[i] && curr.close < sliceLows[sliceLows.length - 1] &&
            volSurge && curr.close < ema21[i] && ema9[i] < ema21[i]) {
          const conf = [
            volSurge,
            volType[i] === "IGNITING",
            body[i] > 0.5 * range[i],
            htfDown[i],
            gapDown[i],
            level2GapDown[i],
            toppingTail[i] || (i > 0 && toppingTail[i - 1]),
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "SHORT", pattern: "Rising Wedge", confluence: conf, volType: volType[i] });
        }
      }

      if (highSlope < 0 && lowSlope < 0 && convergenceRatio < 0.5 && volDecline) {
        if (green[i] && curr.close > sliceHighs[sliceHighs.length - 1] &&
            volSurge && curr.close > ema21[i] && ema9[i] > ema21[i]) {
          const conf = [
            volSurge,
            volType[i] === "IGNITING",
            body[i] > 0.5 * range[i],
            htfUp[i],
            gapUp[i],
            level2GapUp[i],
            bottomingTail[i] || (i > 0 && bottomingTail[i - 1]),
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "LONG", pattern: "Falling Wedge", confluence: conf, volType: volType[i] });
        }
      }
    }
  }

  const seen = new Set<number>();
  return signals.filter(s => {
    if (seen.has(s.index)) return false;
    seen.add(s.index);
    return true;
  });
}

function detectBullBearFlag(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, green, volType, body, range, bottomingTail, toppingTail, htfUp, htfDown } = data;

  for (let i = 12; i < bars.length; i++) {
    const ignitingBar = bars[i - 11];
    const ignitingBody = Math.abs(ignitingBar.close - ignitingBar.open);
    const pullbackBars = bars.slice(i - 10, i);
    const breakoutBar = bars[i];
    const avgR = avgRange[i];
    const avgV = avgVol[i];

    if (ignitingBar.close > ignitingBar.open && ignitingBody > avgR * 1.5 && ignitingBar.volume > avgV * 1.5) {
      const pullbackDown = pullbackBars.filter(b => b.close < b.open).length;
      if (pullbackDown >= 2) {
        const flagHigh = Math.max(...pullbackBars.map(b => b.high));
        const flagLow = Math.min(...pullbackBars.map(b => b.low));
        const pullbackDepth = (ignitingBar.high - flagLow) / (ignitingBar.high - ignitingBar.low || 1);
        if (pullbackDepth <= 0.8 && green[i] && breakoutBar.close > flagHigh && breakoutBar.volume > avgV * 1.3) {
          const conf = [
            breakoutBar.volume > avgV * 1.5,
            volType[i] === "IGNITING",
            body[i] > 0.5 * range[i],
            breakoutBar.close > ema9[i],
            breakoutBar.close > ema21[i],
            htfUp[i],
            pullbackDepth < 0.5,
            bottomingTail[i] || bottomingTail[i - 1],
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "LONG", pattern: "Bull Flag", confluence: conf, volType: volType[i] });
        }
      }
    }

    if (ignitingBar.close < ignitingBar.open && ignitingBody > avgR * 1.5 && ignitingBar.volume > avgV * 1.5) {
      const pullbackUp = pullbackBars.filter(b => b.close > b.open).length;
      if (pullbackUp >= 2) {
        const flagHigh = Math.max(...pullbackBars.map(b => b.high));
        const flagLow = Math.min(...pullbackBars.map(b => b.low));
        const pullbackDepth = (flagHigh - ignitingBar.low) / (ignitingBar.open - ignitingBar.low || 1);
        if (pullbackDepth <= 0.8 && !green[i] && breakoutBar.close < flagLow && breakoutBar.volume > avgV * 1.3) {
          const conf = [
            breakoutBar.volume > avgV * 1.5,
            volType[i] === "IGNITING",
            body[i] > 0.5 * range[i],
            breakoutBar.close < ema9[i],
            breakoutBar.close < ema21[i],
            htfDown[i],
            pullbackDepth < 0.5,
            toppingTail[i] || toppingTail[i - 1],
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "SHORT", pattern: "Bear Flag", confluence: conf, volType: volType[i] });
        }
      }
    }
  }
  return signals;
}

function detectFlagPullbackSetup(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, green, volType, body, range, bottomingTail, toppingTail, htfUp, htfDown, gapUp, gapDown, level2GapUp, level2GapDown, wBottom, wTop } = data;

  for (let i = 8; i < bars.length; i++) {
    for (const pullbackLen of [3, 4, 5]) {
      const ignitingIdx = i - pullbackLen - 1;
      if (ignitingIdx < 1) continue;

      const igBar = bars[ignitingIdx];
      const igBody = Math.abs(igBar.close - igBar.open);
      const igRange = igBar.high - igBar.low;
      const avgR = avgRange[ignitingIdx] || 1;
      const avgV = avgVol[ignitingIdx] || 1;

      const pullbackBars = bars.slice(ignitingIdx + 1, i);
      const breakoutBar = bars[i];

      if (igBar.close > igBar.open && igBody > avgR * 1.5 && igBar.volume > avgV * 2) {
        const flagHigh = Math.max(...pullbackBars.map(b => b.high));
        const flagLow = Math.min(...pullbackBars.map(b => b.low));
        const pullbackDown = pullbackBars.filter(b => b.close < b.open).length;
        const pullbackDepth = igRange > 0 ? (igBar.high - flagLow) / igRange : 1;

        if (pullbackDown >= 2 && pullbackDepth <= 0.75 &&
            green[i] && breakoutBar.close > flagHigh && breakoutBar.volume > avgV * 1.5) {
          const conf = [
            breakoutBar.volume > avgV * 2,
            volType[i] === "IGNITING",
            body[i] > 0.6 * range[i],
            breakoutBar.close > ema9[i],
            breakoutBar.close > ema21[i],
            htfUp[i],
            pullbackDepth < 0.5,
            bottomingTail[i] || (i > 0 && bottomingTail[i - 1]),
            gapUp[i] || level2GapUp[i],
            wBottom[i],
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "LONG", pattern: "Bull Flag Pullback", confluence: conf, volType: volType[i] });
          break;
        }
      }

      if (igBar.close < igBar.open && igBody > avgR * 1.5 && igBar.volume > avgV * 2) {
        const flagHigh = Math.max(...pullbackBars.map(b => b.high));
        const flagLow = Math.min(...pullbackBars.map(b => b.low));
        const pullbackUp = pullbackBars.filter(b => b.close > b.open).length;
        const pullbackDepth = igRange > 0 ? (flagHigh - igBar.low) / igRange : 1;

        if (pullbackUp >= 2 && pullbackDepth <= 0.75 &&
            !green[i] && breakoutBar.close < flagLow && breakoutBar.volume > avgV * 1.5) {
          const conf = [
            breakoutBar.volume > avgV * 2,
            volType[i] === "IGNITING",
            body[i] > 0.6 * range[i],
            breakoutBar.close < ema9[i],
            breakoutBar.close < ema21[i],
            htfDown[i],
            pullbackDepth < 0.5,
            toppingTail[i] || (i > 0 && toppingTail[i - 1]),
            gapDown[i] || level2GapDown[i],
            wTop[i],
          ].filter(Boolean).length;
          signals.push({ index: i, direction: "SHORT", pattern: "Bear Flag Pullback", confluence: conf, volType: volType[i] });
          break;
        }
      }
    }
  }

  const seen = new Set<number>();
  return signals.filter(s => {
    if (seen.has(s.index)) return false;
    seen.add(s.index);
    return true;
  });
}

function detectBearTrapReversal(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema9, ema21, avgVol, avgRange, green, bottomingTail, body, range, volType, htfUp, htfDown, atr } = data;

  for (let i = 12; i < bars.length; i++) {
    const trapBar = bars[i - 2];
    const reversalBar = bars[i - 1];
    const entryBar = bars[i];

    const priorLow = Math.min(...bars.slice(Math.max(0, i - 12), i - 2).map(b => b.low));
    if (trapBar.low >= priorLow) continue;

    if (trapBar.volume > avgVol[i] * 1.1) continue;

    if (reversalBar.close <= reversalBar.open) continue;

    const revTailLen = reversalBar.open - reversalBar.low;
    const revRange = reversalBar.high - reversalBar.low;
    const hasRevTail = revRange > 0 && revTailLen / revRange >= 0.3;
    if (!hasRevTail && !bottomingTail[i - 1]) continue;

    if (!green[i]) continue;

    const conf = [
      trapBar.low < priorLow,
      trapBar.volume < avgVol[i] * 0.8,
      reversalBar.close > reversalBar.open,
      bottomingTail[i - 1] || hasRevTail,
      entryBar.volume > avgVol[i] * 1.2,
      entryBar.volume > avgVol[i] * 1.5,
      entryBar.close > reversalBar.high,
      entryBar.close > ema9[i],
      body[i] > 0.5 * range[i],
      htfUp[i],
      volType[i] === "IGNITING",
      entryBar.close > ema21[i],
    ].filter(Boolean).length;

    if (conf >= 5) {
      signals.push({ index: i, direction: "LONG", pattern: "Bear Trap Reversal", confluence: conf, volType: volType[i] });
    }
  }
  return signals;
}

function detectVWAPBounce(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema9, ema21, avgVol, avgRange, green, bottomingTail, toppingTail, body, range, volType, htfUp, htfDown, atr } = data;

  for (let i = 20; i < bars.length; i++) {
    let cumPV = 0, cumV = 0;
    const vwapWindow = Math.min(20, i);
    for (let j = i - vwapWindow; j <= i; j++) {
      const typical = (bars[j].high + bars[j].low + bars[j].close) / 3;
      cumPV += typical * bars[j].volume;
      cumV += bars[j].volume;
    }
    const vwap = cumV > 0 ? cumPV / cumV : ema21[i];

    const testBar = bars[i - 1];
    const bounceBar = bars[i];
    const vwapRange = avgRange[i] * 0.25;

    const bounceBody = Math.abs(bounceBar.close - bounceBar.open);
    const bounceRange = bounceBar.high - bounceBar.low;
    if (bounceRange < avgRange[i] * 0.8) continue;
    if (bounceBody < bounceRange * 0.4) continue;

    if (Math.abs(testBar.low - vwap) < vwapRange) {
      if (green[i] && bounceBar.close > testBar.high && bounceBar.volume > avgVol[i] * 1.3) {
        const testTail = testBar.open > testBar.close ?
          (testBar.close - testBar.low) : (testBar.open - testBar.low);
        const testRange = testBar.high - testBar.low;
        const hasTestTail = testRange > 0 && testTail / testRange >= 0.3;

        const conf = [
          Math.abs(testBar.low - vwap) < vwapRange,
          bottomingTail[i - 1] || hasTestTail,
          bounceBar.volume > avgVol[i] * 1.5,
          bounceBar.volume > avgVol[i] * 2.0,
          green[i],
          bounceBar.close > ema9[i],
          bounceBar.close > vwap,
          body[i] > 0.6 * range[i],
          bounceBar.close > ema21[i],
          htfUp[i],
          volType[i] === "IGNITING",
          bounceBar.close > bounceBar.open && bounceBar.close === bounceBar.high || bounceBar.close > bounceBar.high * 0.99,
        ].filter(Boolean).length;
        if (conf >= 6) {
          signals.push({ index: i, direction: "LONG", pattern: "VWAP Bounce", confluence: conf, volType: volType[i] });
        }
      }
    }

    if (Math.abs(testBar.high - vwap) < vwapRange) {
      if (!green[i] && bounceBar.close < testBar.low && bounceBar.volume > avgVol[i] * 1.3) {
        const testWick = testBar.close > testBar.open ?
          (testBar.high - testBar.close) : (testBar.high - testBar.open);
        const testRange = testBar.high - testBar.low;
        const hasTestWick = testRange > 0 && testWick / testRange >= 0.3;

        const conf = [
          Math.abs(testBar.high - vwap) < vwapRange,
          toppingTail[i - 1] || hasTestWick,
          bounceBar.volume > avgVol[i] * 1.5,
          bounceBar.volume > avgVol[i] * 2.0,
          !green[i],
          bounceBar.close < ema9[i],
          bounceBar.close < vwap,
          body[i] > 0.6 * range[i],
          bounceBar.close < ema21[i],
          htfDown[i],
          volType[i] === "IGNITING",
          bounceBar.close < bounceBar.open && bounceBar.close === bounceBar.low || bounceBar.close < bounceBar.low * 1.01,
        ].filter(Boolean).length;
        if (conf >= 6) {
          signals.push({ index: i, direction: "SHORT", pattern: "VWAP Bounce", confluence: conf, volType: volType[i] });
        }
      }
    }
  }
  return signals;
}

const PATTERN_DETECTORS: Record<string, (data: ReturnType<typeof addIndicators>) => Signal[]> = {
  "3bar": detect3BarPlay,
  "4bar": detect4BarPlay,
  "buysetup": detectBuySetup,
  "retest": detectRetestSetup,
  "breakout": detectBreakout,
  "climax": detectClimaxReversal,
  "cuphandle": detectCupAndHandle,
  "inversecuphandle": detectInverseCupAndHandle,
  "doubletop": (data) => detectDoubleTopBottom(data).filter(s => s.direction === "SHORT"),
  "doublebottom": (data) => detectDoubleTopBottom(data).filter(s => s.direction === "LONG"),
  "headshoulders": (data) => detectHeadAndShoulders(data).filter(s => s.direction === "SHORT"),
  "invheadshoulders": (data) => detectHeadAndShoulders(data).filter(s => s.direction === "LONG"),
  "wedge": detectWedgeBreakout,
  "bullflag": (data) => detectBullBearFlag(data).filter(s => s.direction === "LONG"),
  "bearflag": (data) => detectBullBearFlag(data).filter(s => s.direction === "SHORT"),
  "flagpullback": detectBullBearFlag,
  "bullflagpullback": (data) => detectFlagPullbackSetup(data).filter(s => s.direction === "LONG"),
  "bearflagpullback": (data) => detectFlagPullbackSetup(data).filter(s => s.direction === "SHORT"),
  "flagpullbacksetup": detectFlagPullbackSetup,
  "beartrap": detectBearTrapReversal,
  "vwapbounce": detectVWAPBounce,
  "all": (data) => [
    ...detect3BarPlay(data),
    ...detect4BarPlay(data),
    ...detectBuySetup(data),
    ...detectRetestSetup(data),
    ...detectBreakout(data),
    ...detectClimaxReversal(data),
    ...detectCupAndHandle(data),
    ...detectInverseCupAndHandle(data),
    ...detectDoubleTopBottom(data),
    ...detectHeadAndShoulders(data),
    ...detectWedgeBreakout(data),
    ...detectBullBearFlag(data),
    ...detectFlagPullbackSetup(data),
    ...detectBearTrapReversal(data),
    ...detectVWAPBounce(data),
  ],
};

const POINT_VALUES: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
  CL: 1000, MCL: 100, GC: 100, MGC: 10, SI: 5000, HG: 25000,
  ZB: 1000, ZN: 1000, ZT: 2000, ZF: 1000,
  ZC: 50, ZS: 50, ZW: 50,
  BTC: 5, MBT: 0.5, ETH: 50, MET: 5,
};

export async function runBacktest(config: {
  symbol?: string;
  pattern?: string;
  from?: string;
  to?: string;
  rrRatio?: number;
  maxHold?: number;
  minConfluence?: number;
  timeframe?: string;
  dataSource?: string;
}): Promise<BacktestResult> {
  const symbol = (config.symbol || "ES").toUpperCase();
  const patternKey = config.pattern || "3bar";
  const from = config.from || "2020-01-01";
  const to = config.to || new Date().toISOString().slice(0, 10);
  const rrRatio = config.rrRatio || 2;
  const maxHold = config.maxHold || 5;
  const minConf = config.minConfluence || 0;
  const pointValue = POINT_VALUES[symbol] || 50;
  const tf = config.timeframe || "daily";
  const { multiplier, timespan } = parseTimeframe(tf);
  const source = (config.dataSource || "auto").toLowerCase();

  console.log(`[backtest] Starting ${patternKey} backtest on ${symbol} [${tf}] from ${from} to ${to} (R:R ${rrRatio}, maxHold ${maxHold}, minConf ${minConf}, source: ${source})`);

  const cacheKey = `${source === "yahoo" ? "YF:" : ""}${symbol}:${multiplier}${timespan}:${from}:${to}`;
  let bars: Bar[] | null = getCachedBars(cacheKey);

  if (bars) {
    console.log(`[backtest] Cache hit: ${bars.length} bars for ${symbol} [${tf}]`);
  } else if (source === "yahoo") {
    bars = await fetchYahooFinance(symbol, from, to, tf);
    if (bars.length > 0) setCachedBars(cacheKey, bars);
  } else {
    if (ETF_PROXIES[symbol]) {
      bars = await fetchETFProxy(symbol, from, to, multiplier, timespan);
    } else {
      bars = await fetchStitchedData(symbol, from, to, multiplier, timespan);
    }
    if (bars.length === 0 && source === "auto") {
      console.log(`[backtest] Polygon returned 0 bars for ${symbol}, falling back to Yahoo Finance`);
      bars = await fetchYahooFinance(symbol, from, to, tf);
    }
    if (bars.length > 0) {
      setCachedBars(cacheKey, bars);
    }
  }

  if (bars.length === 0) {
    console.log(`[backtest] No data fetched for ${symbol}`);
    return computeResults([], symbol, patternKey, `${from} to ${to}`, 0);
  }

  console.log(`[backtest] Fetched ${bars.length} bars for ${symbol}`);

  const data = addIndicators(bars);

  const detector = PATTERN_DETECTORS[patternKey];
  if (!detector) {
    return { ...computeResults([], symbol, patternKey, `${from} to ${to}`, bars.length), error: `Unknown pattern: ${patternKey}` };
  }

  const signals = detector(data);
  signals.forEach(sig => {
    const vpBonus = getBacktestVPBonus(bars, sig.index);
    if (vpBonus > 0) sig.confluence = (sig.confluence || 0) + vpBonus;
    const ofBonus = getBacktestOFBonus(bars, sig.index, sig.direction);
    if (ofBonus > 0) sig.confluence = (sig.confluence || 0) + ofBonus;
    const vwapBonus = getBacktestVWAPBonus(bars, sig.index, sig.direction);
    if (vwapBonus > 0) sig.confluence = (sig.confluence || 0) + vwapBonus;
    const rsiBonus = getBacktestRSIBonus(bars, sig.index, sig.direction);
    if (rsiBonus !== 0) sig.confluence = (sig.confluence || 0) + rsiBonus;
  });
  const filteredSignals = minConf > 0 ? signals.filter(s => (s.confluence || 0) >= minConf) : signals;
  console.log(`[backtest] Detected ${signals.length} ${patternKey} signals (${filteredSignals.length} with confluence >= ${minConf})`);

  const trades = simulateTrades(data, filteredSignals, rrRatio, maxHold, pointValue);
  trades.forEach(t => { (t as any).timeframe = tf; (t as any).symbol = symbol; });
  const result = computeResults(trades, symbol, patternKey, `${from} to ${to}`, bars.length);

  console.log(`[backtest] Result: ${result.totalTrades} trades, ${result.winRate}% WR, $${result.totalPnlDollars} P&L, PF ${result.profitFactor}`);
  return result;
}

export function scanCachedEdges(minWinRate: number = 45, minTrades: number = 5, minConfluence: number = 5): Array<{ symbol: string; pattern: string; timeframe: string; winRate: number; trades: number; pnl: number; profitFactor: number; avgConf: number; expectancy: number }> {
  const results: Array<{ symbol: string; pattern: string; timeframe: string; winRate: number; trades: number; pnl: number; profitFactor: number; avgConf: number; expectancy: number }> = [];
  const patternKeys = Object.keys(PATTERN_DETECTORS).filter(k => k !== "all");
  const pvMap = POINT_VALUES;

  for (const [cacheKey, cached] of barCache.entries()) {
    const bars = cached.bars;
    if (bars.length < 30) continue;

    const parts = cacheKey.split(":");
    const symbol = parts[0];
    const tfRaw = parts[1] || "";
    let tf = "daily";
    if (tfRaw.includes("5minute")) tf = "5min";
    else if (tfRaw.includes("15minute")) tf = "15min";
    else if (tfRaw.includes("30minute")) tf = "30min";
    else if (tfRaw.includes("1minute")) tf = "1min";
    else if (tfRaw.includes("2minute")) tf = "2min";
    else if (tfRaw.includes("3minute")) tf = "3min";
    else if (tfRaw.includes("1hour") || tfRaw.includes("60minute")) tf = "1hour";
    else if (tfRaw.includes("4hour") || tfRaw.includes("240minute")) tf = "4hour";

    const data = addIndicators(bars);
    const pointValue = pvMap[symbol] || 1;

    for (const patKey of patternKeys) {
      const detector = PATTERN_DETECTORS[patKey];
      const signals = detector(data);

      signals.forEach(sig => {
        const vpBonus = getBacktestVPBonus(bars, sig.index);
        if (vpBonus > 0) sig.confluence = (sig.confluence || 0) + vpBonus;
        const ofBonus = getBacktestOFBonus(bars, sig.index, sig.direction);
        if (ofBonus > 0) sig.confluence = (sig.confluence || 0) + ofBonus;
        const vwapBonus = getBacktestVWAPBonus(bars, sig.index, sig.direction);
        if (vwapBonus > 0) sig.confluence = (sig.confluence || 0) + vwapBonus;
        const rsiBonus = getBacktestRSIBonus(bars, sig.index, sig.direction);
        if (rsiBonus !== 0) sig.confluence = (sig.confluence || 0) + rsiBonus;
      });

      const filtered = minConfluence > 0 ? signals.filter(s => (s.confluence || 0) >= minConfluence) : signals;
      if (filtered.length < minTrades) continue;

      const trades = simulateTrades(data, filtered, 2, 5, pointValue);
      if (trades.length < minTrades) continue;

      const wins = trades.filter(t => t.outcome === "WIN").length;
      const wr = Math.round((wins / trades.length) * 1000) / 10;
      if (wr < minWinRate) continue;

      const grossProfit = trades.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0);
      const grossLoss = Math.abs(trades.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0));
      const pf = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 99.99 : 0;
      const totalPnl = Math.round(trades.reduce((s, t) => s + t.pnlDollars, 0) * 100) / 100;
      const avgConf = Math.round(filtered.reduce((s, sig) => s + (sig.confluence || 0), 0) / filtered.length * 10) / 10;

      const avgWin = wins > 0 ? grossProfit / wins : 0;
      const avgLoss = (trades.length - wins) > 0 ? grossLoss / (trades.length - wins) : 0;
      const expectancy = Math.round(((wr / 100 * avgWin) - ((1 - wr / 100) * avgLoss)) * 100) / 100;

      results.push({ symbol, pattern: patKey, timeframe: tf, winRate: wr, trades: trades.length, pnl: totalPnl, profitFactor: pf, avgConf, expectancy });
    }
  }

  results.sort((a, b) => b.winRate - a.winRate || b.profitFactor - a.profitFactor);
  return results;
}

interface ApexSimConfig {
  accountSize: number;
  profitTarget: number;
  trailingDrawdownMax: number;
  dailyLossLimit: number;
  minTradeDays: number;
  riskPerTrade: number;
  mode: "eval" | "funded";
}

interface ApexDayResult {
  date: string;
  trades: number;
  dayPnl: number;
  cumPnl: number;
  balance: number;
  highWaterMark: number;
  drawdownFromHWM: number;
  dailyLimitHit: boolean;
  drawdownBusted: boolean;
  targetReached: boolean;
}

interface ApexSimResult {
  passed: boolean;
  busted: boolean;
  bustReason?: string;
  bustDate?: string;
  passDate?: string;
  totalTradeDays: number;
  totalTradesTaken: number;
  totalTradesSkipped: number;
  finalBalance: number;
  finalPnl: number;
  highWaterMark: number;
  maxDrawdownFromHWM: number;
  maxDailyLoss: number;
  profitTarget: number;
  trailingDrawdownMax: number;
  dailyLossLimit: number;
  accountSize: number;
  mode: string;
  days: ApexDayResult[];
  equityCurve: { date: string; balance: number; hwm: number }[];
}

export function simulateApexEval(trades: BacktestTrade[], config: ApexSimConfig): ApexSimResult {
  const { accountSize, profitTarget, trailingDrawdownMax, dailyLossLimit, minTradeDays, riskPerTrade, mode } = config;

  const tradesByDate = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const date = t.date;
    if (!tradesByDate.has(date)) tradesByDate.set(date, []);
    tradesByDate.get(date)!.push(t);
  }

  const sortedDates = [...tradesByDate.keys()].sort();

  let balance = accountSize;
  let hwm = accountSize;
  let cumPnl = 0;
  let totalTradesTaken = 0;
  let totalTradesSkipped = 0;
  let maxDrawdownFromHWM = 0;
  let maxDailyLoss = 0;
  let passed = false;
  let busted = false;
  let bustReason: string | undefined;
  let bustDate: string | undefined;
  let passDate: string | undefined;

  const days: ApexDayResult[] = [];
  const equityCurve: { date: string; balance: number; hwm: number }[] = [];

  for (const date of sortedDates) {
    if (busted) break;
    if (passed && days.filter(d => d.trades > 0).length >= minTradeDays) break;

    const dayTrades = tradesByDate.get(date)!;
    let dayPnl = 0;
    let dayTradesTaken = 0;
    let dailyLimitHit = false;
    let drawdownBusted = false;

    for (const t of dayTrades) {
      if (busted) break;

      const tradePnl = t.pnlDollars;

      dayPnl += tradePnl;
      dayTradesTaken++;
      totalTradesTaken++;
      cumPnl += tradePnl;
      balance = accountSize + cumPnl;

      if (balance > hwm) hwm = balance;

      const ddFromHWM = hwm - balance;
      if (ddFromHWM > maxDrawdownFromHWM) maxDrawdownFromHWM = ddFromHWM;

      if (ddFromHWM >= trailingDrawdownMax) {
        busted = true;
        passed = false;
        bustReason = `Trailing drawdown hit: -$${ddFromHWM.toFixed(0)} from HWM $${hwm.toFixed(0)} (limit -$${trailingDrawdownMax})`;
        bustDate = date;
        drawdownBusted = true;
        break;
      }

      if (dayPnl <= -dailyLossLimit) {
        dailyLimitHit = true;
        if (mode === "funded") {
          busted = true;
          passed = false;
          bustReason = `Daily loss limit hit: -$${Math.abs(dayPnl).toFixed(0)} (limit -$${dailyLossLimit})`;
          bustDate = date;
        }
        totalTradesSkipped += dayTrades.length - dayTradesTaken;
        break;
      }

      if (cumPnl >= profitTarget && !passed) {
        passed = true;
        passDate = date;
      }
    }

    if (dayPnl < maxDailyLoss) {
      maxDailyLoss = dayPnl;
    }

    const dayResult: ApexDayResult = {
      date,
      trades: dayTradesTaken,
      dayPnl: Math.round(dayPnl * 100) / 100,
      cumPnl: Math.round(cumPnl * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      highWaterMark: Math.round(hwm * 100) / 100,
      drawdownFromHWM: Math.round((hwm - balance) * 100) / 100,
      dailyLimitHit,
      drawdownBusted,
      targetReached: passed && passDate === date,
    };
    days.push(dayResult);
    equityCurve.push({ date, balance: Math.round(balance * 100) / 100, hwm: Math.round(hwm * 100) / 100 });
  }

  const tradeDays = days.filter(d => d.trades > 0).length;

  if (passed && tradeDays < minTradeDays) {
    passed = false;
    bustReason = `Target reached but only ${tradeDays} trade days (need ${minTradeDays})`;
  }

  return {
    passed: passed && !busted,
    busted,
    bustReason,
    bustDate,
    passDate,
    totalTradeDays: tradeDays,
    totalTradesTaken,
    totalTradesSkipped,
    finalBalance: Math.round(balance * 100) / 100,
    finalPnl: Math.round(cumPnl * 100) / 100,
    highWaterMark: Math.round(hwm * 100) / 100,
    maxDrawdownFromHWM: Math.round(maxDrawdownFromHWM * 100) / 100,
    maxDailyLoss: Math.round(maxDailyLoss * 100) / 100,
    profitTarget,
    trailingDrawdownMax,
    dailyLossLimit,
    accountSize,
    mode,
    days,
    equityCurve,
  };
}

const BULK_SYMBOLS = ["ES","NQ","YM","RTY","CL","GC","SI","ZC","ZS","ZW","BTC","ETH","ZB","ZN","MES","MNQ","MYM","M2K","MCL","MGC","HG"];
const BULK_TIMEFRAMES = ["5min","15min","1hour","daily"];

let bulkDownloadStatus: { running: boolean; progress: number; total: number; current: string; completed: string[]; errors: string[]; done: boolean } = {
  running: false, progress: 0, total: 0, current: "", completed: [], errors: [], done: false,
};

export function getBulkCacheStatus() {
  const cached: string[] = [];
  try {
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(DATA_DIR, f));
          if (stat.size > 100) cached.push(f.replace(".json", ""));
        } catch {}
      }
    }
  } catch {}
  return { ...bulkDownloadStatus, cachedFiles: cached.length, cached };
}

export async function downloadBulkCache(symbols: string[] = BULK_SYMBOLS, timeframes: string[] = BULK_TIMEFRAMES): Promise<{ completed: string[]; errors: string[] }> {
  if (bulkDownloadStatus.running) return { completed: [], errors: ["Already running"] };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const jobs: Array<{ symbol: string; tf: string; etf: string; mult: number; tspan: string; cacheKey: string }> = [];

  for (const sym of symbols) {
    const proxy = ETF_PROXIES[sym];
    if (!proxy) continue;
    for (const tf of timeframes) {
      const { multiplier, timespan } = parseTimeframe(tf);
      const from = "2024-01-01";
      const to = new Date().toISOString().slice(0, 10);
      const cacheKey = `${sym}:${multiplier}${timespan}:${from}:${to}`;
      const diskPath = diskCachePath(cacheKey);
      if (fs.existsSync(diskPath)) {
        try {
          const stat = fs.statSync(diskPath);
          if (stat.size > 100) continue;
        } catch {}
      }
      jobs.push({ symbol: sym, tf, etf: proxy.etf, mult: multiplier, tspan: timespan, cacheKey });
    }
  }

  bulkDownloadStatus = { running: true, progress: 0, total: jobs.length, current: "", completed: [], errors: [], done: false };

  if (jobs.length === 0) {
    bulkDownloadStatus = { ...bulkDownloadStatus, running: false, done: true };
    return { completed: [], errors: [] };
  }

  const etfDone = new Set<string>();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    bulkDownloadStatus.current = `${job.symbol} ${job.tf}`;
    bulkDownloadStatus.progress = i;

    try {
      const from = "2024-01-01";
      const to = new Date().toISOString().slice(0, 10);
      const etfKey = `ETF:${job.etf}:${job.mult}${job.tspan}:${from}:${to}`;

      let rawBars: Bar[] | null = null;
      const etfDisk = diskCachePath(etfKey);
      if (fs.existsSync(etfDisk)) {
        try { rawBars = JSON.parse(fs.readFileSync(etfDisk, "utf-8")); } catch {}
      }

      if (!rawBars || rawBars.length === 0) {
        if (!etfDone.has(etfKey)) {
          rawBars = await fetchPolygonAggs(job.etf, from, to, job.mult, job.tspan);
          if (rawBars.length > 0) {
            fs.writeFileSync(etfDisk, JSON.stringify(rawBars));
            setCachedBars(etfKey, rawBars);
            etfDone.add(etfKey);
            console.log(`[bulk] Downloaded ETF ${job.etf} ${job.tf}: ${rawBars.length} bars`);
          }
        } else {
          try { rawBars = JSON.parse(fs.readFileSync(etfDisk, "utf-8")); } catch { rawBars = []; }
        }
      }

      if (rawBars && rawBars.length > 0) {
        const proxy = ETF_PROXIES[job.symbol];
        const scaledBars = rawBars.map(b => ({
          ...b,
          open: Math.round(b.open * proxy.ratio * 100) / 100,
          high: Math.round(b.high * proxy.ratio * 100) / 100,
          low: Math.round(b.low * proxy.ratio * 100) / 100,
          close: Math.round(b.close * proxy.ratio * 100) / 100,
        }));
        setCachedBars(job.cacheKey, scaledBars);
        bulkDownloadStatus.completed.push(`${job.symbol}/${job.tf}`);
        console.log(`[bulk] Cached ${job.symbol} ${job.tf}: ${scaledBars.length} bars`);
      } else {
        bulkDownloadStatus.errors.push(`${job.symbol}/${job.tf}: no data`);
      }
    } catch (e: any) {
      bulkDownloadStatus.errors.push(`${job.symbol}/${job.tf}: ${e.message}`);
      console.error(`[bulk] Error ${job.symbol} ${job.tf}: ${e.message}`);
    }
  }

  bulkDownloadStatus = { ...bulkDownloadStatus, running: false, progress: jobs.length, done: true };
  return { completed: bulkDownloadStatus.completed, errors: bulkDownloadStatus.errors };
}
