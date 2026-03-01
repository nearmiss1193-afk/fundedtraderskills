const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_BASE = "https://api.polygon.io";

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

async function fetchPolygonAggs(ticker: string, from: string, to: string, multiplier = 1, timespan = "day"): Promise<Bar[]> {
  if (!POLYGON_API_KEY) return [];
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return [];
    return data.results.map((r: any) => ({
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v || 0,
      timestamp: r.t,
    }));
  } catch {
    return [];
  }
}

async function fetchStitchedData(symbol: string, from: string, to: string): Promise<Bar[]> {
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

    const bars = await fetchPolygonAggs(ticker, from, to);
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
  ZB:  { etf: "TLT",  ratio: 1.2 },
  ZN:  { etf: "IEF",  ratio: 1.15 },
  ZC:  { etf: "CORN", ratio: 20.0 },
  ZS:  { etf: "SOYB", ratio: 40.0 },
  ZW:  { etf: "WEAT", ratio: 25.0 },
};

async function fetchETFProxy(symbol: string, from: string, to: string): Promise<Bar[]> {
  const proxy = ETF_PROXIES[symbol];
  if (!proxy) return [];
  const bars = await fetchPolygonAggs(proxy.etf, from, to);
  if (bars.length === 0) return [];
  return bars.map(b => ({
    ...b,
    open: Math.round(b.open * proxy.ratio * 100) / 100,
    high: Math.round(b.high * proxy.ratio * 100) / 100,
    low: Math.round(b.low * proxy.ratio * 100) / 100,
    close: Math.round(b.close * proxy.ratio * 100) / 100,
  }));
}

type VolType = "IGNITING" | "ENDING" | "RESTING" | "NORMAL";

function addIndicators(bars: Bar[]): {
  bars: Bar[];
  ema21: number[];
  ema9: number[];
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
  isParabolic: boolean[];
} {
  const ema21: number[] = [];
  const ema9: number[] = [];
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
  const isParabolic: boolean[] = [];

  const ema21k = 2 / 22;
  const ema9k = 2 / 10;

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
    } else {
      ema21.push(b.close * ema21k + ema21[i - 1] * (1 - ema21k));
      ema9.push(b.close * ema9k + ema9[i - 1] * (1 - ema9k));
    }

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
    } else {
      gapUp.push(b.open > bars[i - 1].close * 1.005);
      gapDown.push(b.open < bars[i - 1].close * 0.995);
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

  return { bars, ema21, ema9, avgRange, avgVol, atr, range, body, green, tail, wick, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, pivotHighs, pivotLows, gapUp, gapDown, isParabolic };
}

interface Signal {
  index: number;
  direction: "LONG" | "SHORT";
  pattern: string;
  confluence?: number;
  volType?: VolType;
}

function detect3BarPlay(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, range, body, green, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, gapUp, gapDown, tail, wick } = data;

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
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "SHORT", pattern: "3 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }
  }
  return signals;
}

function detect4BarPlay(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, range, body, green, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, tail, wick, gapUp, gapDown } = data;

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
      ].filter(Boolean).length;
      signals.push({ index: triggerIdx, direction: "SHORT", pattern: "4 Bar Play", confluence: conf, volType: volType[triggerIdx] });
    }
  }
  return signals;
}

function detectBuySetup(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, bottomingTail, toppingTail, volType, sideways, body, range, htfUp, htfDown, tail, wick, gapUp, gapDown } = data;

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
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Sell Setup", confluence: conf, volType: volType[i] });
    }
  }
  return signals;
}

function detectRetestSetup(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, green, bottomingTail, toppingTail, volType, sideways, body, range, htfUp, htfDown, tail, wick, pivotHighs, pivotLows, gapUp, gapDown } = data;

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
      ].filter(Boolean).length;
      if (conf >= 3) {
        const patternName = isDoubleBottom ? "Double Bottom Retest" : "Retest Buy";
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
      ].filter(Boolean).length;
      if (conf >= 3) {
        const patternName = isDoubleTop ? "Double Top Retest" : "Retest Sell";
        signals.push({ index: i, direction: "SHORT", pattern: patternName, confluence: conf, volType: volType[i] });
      }
    }
  }
  return signals;
}

function detectBreakout(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgRange, avgVol, green, volType, sideways, body, range, htfUp, htfDown, gapUp, gapDown } = data;

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
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Breakout", confluence: conf, volType: volType[i] });
    }
  }
  return signals;
}

function detectClimaxReversal(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, avgRange, avgVol, range, green, bottomingTail, toppingTail, volType, body, tail, wick, isParabolic, gapUp, gapDown } = data;

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
      ].filter(Boolean).length;
      signals.push({ index: i, direction: "SHORT", pattern: "Climax Reversal", confluence: conf, volType: volType[i - 1] });
    }
  }
  return signals;
}

function simulateTrades(data: ReturnType<typeof addIndicators>, signals: Signal[], rrRatio = 2, maxHold = 5, pointValue = 50): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const { bars, atr } = data;

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
    const dateStr = new Date(bars[i].timestamp).toISOString().slice(0, 10);

    trades.push({
      date: dateStr,
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
  const { bars, ema21, ema9, avgVol, green, volType, body, range, htfUp, gapUp, bottomingTail } = data;
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
          bottomingTail[h] || (h > 0 && bottomingTail[h - 1]),
        ].filter(Boolean).length;
        signals.push({ index: h, direction: "LONG", pattern: "Cup & Handle", confluence: conf, volType: volType[h] });
        break;
      }
    }
  }

  return signals;
}

function detectWedgeBreakout(data: ReturnType<typeof addIndicators>): Signal[] {
  const signals: Signal[] = [];
  const { bars, ema21, ema9, avgVol, avgRange, green, volType, body, range, htfUp, htfDown, gapUp, gapDown, toppingTail, bottomingTail } = data;
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

const PATTERN_DETECTORS: Record<string, (data: ReturnType<typeof addIndicators>) => Signal[]> = {
  "3bar": detect3BarPlay,
  "4bar": detect4BarPlay,
  "buysetup": detectBuySetup,
  "retest": detectRetestSetup,
  "breakout": detectBreakout,
  "climax": detectClimaxReversal,
  "cuphandle": detectCupAndHandle,
  "wedge": detectWedgeBreakout,
  "all": (data) => [
    ...detect3BarPlay(data),
    ...detect4BarPlay(data),
    ...detectBuySetup(data),
    ...detectRetestSetup(data),
    ...detectBreakout(data),
    ...detectClimaxReversal(data),
    ...detectCupAndHandle(data),
    ...detectWedgeBreakout(data),
  ],
};

const POINT_VALUES: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
  CL: 1000, MCL: 100, GC: 100, MGC: 10, SI: 5000, HG: 25000,
  ZB: 1000, ZN: 1000, ZT: 2000, ZF: 1000,
  ZC: 50, ZS: 50, ZW: 50,
};

export async function runBacktest(config: {
  symbol?: string;
  pattern?: string;
  from?: string;
  to?: string;
  rrRatio?: number;
  maxHold?: number;
}): Promise<BacktestResult> {
  const symbol = (config.symbol || "ES").toUpperCase();
  const patternKey = config.pattern || "3bar";
  const from = config.from || "2020-01-01";
  const to = config.to || new Date().toISOString().slice(0, 10);
  const rrRatio = config.rrRatio || 2;
  const maxHold = config.maxHold || 5;
  const pointValue = POINT_VALUES[symbol] || 50;

  console.log(`[backtest] Starting ${patternKey} backtest on ${symbol} from ${from} to ${to} (R:R ${rrRatio}, maxHold ${maxHold})`);

  let bars: Bar[];
  if (ETF_PROXIES[symbol]) {
    bars = await fetchETFProxy(symbol, from, to);
  } else {
    bars = await fetchStitchedData(symbol, from, to);
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
  console.log(`[backtest] Detected ${signals.length} ${patternKey} signals`);

  const trades = simulateTrades(data, signals, rrRatio, maxHold, pointValue);
  const result = computeResults(trades, symbol, patternKey, `${from} to ${to}`, bars.length);

  console.log(`[backtest] Result: ${result.totalTrades} trades, ${result.winRate}% WR, $${result.totalPnlDollars} P&L, PF ${result.profitFactor}`);
  return result;
}
