import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_BASE = "https://api.polygon.io";

// --- Interfaces & Types ---
interface Bar {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
}

type VolType = "IGNITING" | "ENDING" | "RESTING" | "NORMAL";

interface Signal {
    index: number;
    direction: "LONG" | "SHORT";
    pattern: string;
    confluence: number;
    volType?: VolType;
}

// --- Data Fetching ---
async function fetchPolygonData(ticker: string, from: string, to: string): Promise<Bar[]> {
    console.log(`[polygon] Fetching data for ${ticker} from ${from} to ${to}...`);
    const url = `${POLYGON_BASE}/v2/aggs/ticker/C:${ticker}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;

    // For Futures, we might need a different ticker format if available, but for now we'll try to find a proxy if C: doesn't work
    // However, the user usually has MNQH26_1min.json which comes from the live system.
    // If we can't fetch, we'll just use the local file.
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Polygon API Error: ${err}`);
        }
        const data: any = await resp.json();
        if (!data.results) throw new Error("No results from Polygon");

        return data.results.map((r: any) => ({
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            volume: r.v,
            timestamp: r.t
        }));
    } catch (err: any) {
        console.error(`[polygon] Fetch failed: ${err.message}`);
        return [];
    }
}

// --- Indicator Support ---
function addIndicators(bars: Bar[]) {
    const ema21: number[] = [];
    const ema9: number[] = [];
    const ema50: number[] = [];
    const sma200: number[] = [];
    const avgRange: number[] = [];
    const avgVol: number[] = [];
    const atr: number[] = [];
    const range: number[] = [];
    const body: number[] = [];
    const green: boolean[] = [];
    const bottomingTail: boolean[] = [];
    const toppingTail: boolean[] = [];
    const volType: VolType[] = [];
    const sideways: boolean[] = [];
    const htfUp: boolean[] = [];
    const htfDown: boolean[] = [];
    const gapUp: boolean[] = [];
    const gapDown: boolean[] = [];
    const tail: number[] = [];
    const wick: number[] = [];
    const rsi: number[] = [];

    const ema21k = 2 / 22;
    const ema9k = 2 / 10;
    const ema50k = 2 / 51;
    const sma200period = 200;

    let rsiAvgGain = 0, rsiAvgLoss = 0;

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

        bottomingTail.push(r > 0 && tl > 0.4 * r && bd < 0.5 * r);
        toppingTail.push(r > 0 && wk > 0.4 * r && bd < 0.5 * r);

        if (i === 0) {
            ema21.push(b.close); ema9.push(b.close); ema50.push(b.close); sma200.push(b.close);
        } else {
            ema21.push(b.close * ema21k + ema21[i - 1] * (1 - ema21k));
            ema9.push(b.close * ema9k + ema9[i - 1] * (1 - ema9k));
            ema50.push(b.close * ema50k + ema50[i - 1] * (1 - ema50k));
            if (i >= sma200period) {
                const sum = bars.slice(i - sma200period + 1, i + 1).reduce((s, x) => s + x.close, 0);
                sma200.push(sum / sma200period);
            } else {
                sma200.push(ema50[i]);
            }
        }

        // RSI
        const rsiPeriod = 14;
        if (i > 0) {
            const diff = b.close - bars[i - 1].close;
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;
            rsiAvgGain = (rsiAvgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
            rsiAvgLoss = (rsiAvgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
            const rs = rsiAvgLoss === 0 ? 100 : rsiAvgGain / rsiAvgLoss;
            rsi.push(100 - (100 / (1 + rs)));
        } else {
            rsi.push(50);
        }

        const windowSize = Math.min(i + 1, 20);
        const recentBars = bars.slice(i - windowSize + 1, i + 1);
        avgRange.push(recentBars.reduce((s, x) => s + (x.high - x.low), 0) / windowSize);
        avgVol.push(recentBars.reduce((s, x) => s + x.volume, 0) / windowSize);
        atr.push(avgRange[i]);

        const avgP = ema21[i];
        sideways.push(Math.abs(ema9[i] - ema21[i]) / avgP < 0.002);

        // HTF Logic Simplified
        htfUp.push(ema9[i] > ema21[i] && b.close > sma200[i]);
        htfDown.push(ema9[i] < ema21[i] && b.close < sma200[i]);

        gapUp.push(i > 0 && b.open > bars[i - 1].close * 1.001);
        gapDown.push(i > 0 && b.open < bars[i - 1].close * 0.999);

        // VolType
        if (b.volume > avgVol[i] * 2.5) volType.push("ENDING");
        else if (b.volume > avgVol[i] * 1.5) volType.push("IGNITING");
        else volType.push("NORMAL");
    }

    return { bars, ema21, ema9, ema50, sma200, rsi, avgRange, avgVol, atr, range, body, green, bottomingTail, toppingTail, volType, sideways, htfUp, htfDown, gapUp, gapDown, tail, wick };
}

// --- Pattern Detection ---
function detect3BarPlay(data: any): Signal[] {
    const signals: Signal[] = [];
    const { bars, ema21, ema9, range, green, htfUp, htfDown, avgVol, volType, bottomingTail, toppingTail } = data;
    for (let i = 3; i < bars.length; i++) {
        const ign = i - 2, rest = i - 1, trig = i;
        // Long
        if (green[ign] && range[ign] > data.avgRange[ign] * 1.5 && range[rest] < range[ign] * 0.5 && green[trig] && bars[trig].close > bars[rest].high && htfUp[trig]) {
            let conf = 5; // Base pattern
            if (bars[trig].volume > avgVol[trig]) conf++;
            if (volType[trig] === "IGNITING") conf++;
            if (bottomingTail[rest]) conf++;
            if (bars[trig].close > ema9[trig]) conf++;
            signals.push({ index: trig, direction: "LONG", pattern: "3 Bar Play", confluence: conf });
        }
        // Short
        if (!green[ign] && range[ign] > data.avgRange[ign] * 1.5 && range[rest] < range[ign] * 0.5 && !green[trig] && bars[trig].close < bars[rest].low && htfDown[trig]) {
            let conf = 5;
            if (bars[trig].volume > avgVol[trig]) conf++;
            if (volType[trig] === "IGNITING") conf++;
            if (toppingTail[rest]) conf++;
            if (bars[trig].close < ema9[trig]) conf++;
            signals.push({ index: trig, direction: "SHORT", pattern: "3 Bar Play", confluence: conf });
        }
    }
    return signals;
}

function detectBuySellSetup(data: any): Signal[] {
    const signals: Signal[] = [];
    const { bars, ema21, htfUp, htfDown, green, avgVol, rsi } = data;
    for (let i = 5; i < bars.length; i++) {
        // Red reversal (Buy Setup)
        const pullback = bars.slice(i - 3, i).filter(b => b.close < b.open).length >= 2;
        if (pullback && green[i] && bars[i].close > bars[i - 1].high && htfUp[i]) {
            let conf = 5;
            if (bars[i].volume > avgVol[i]) conf++;
            if (rsi[i] < 45) conf++; // Overextended pullback
            if (bars[i].low < ema21[i] && bars[i].close > ema21[i]) conf++; // MA Bounce
            signals.push({ index: i, direction: "LONG", pattern: "Buy Setup", confluence: conf });
        }
        // Green reversal (Sell Setup)
        const rally = bars.slice(i - 3, i).filter(b => b.close > b.open).length >= 2;
        if (rally && !green[i] && bars[i].close < bars[i - 1].low && htfDown[i]) {
            let conf = 5;
            if (bars[i].volume > avgVol[i]) conf++;
            if (rsi[i] > 55) conf++;
            if (bars[i].high > ema21[i] && bars[i].close < ema21[i]) conf++;
            signals.push({ index: i, direction: "SHORT", pattern: "Sell Setup", confluence: conf });
        }
    }
    return signals;
}

// --- Main execution ---
async function run() {
    console.log("--------------------------------------------------");
    console.log("🏛️  ANTIGRAVITY A+ STRATEGY AUDIT v2.0");
    console.log("--------------------------------------------------");

    const dataPath = path.resolve("./data/MNQH26_1min.json");
    let bars: Bar[] = [];

    if (fs.existsSync(dataPath)) {
        console.log("✅ Using cached MNQ data from ./data/");
        bars = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    } else {
        console.log("⚠️  Local data missing. Attempting Polygon fetch...");
        // Fallback to fetch if path exists but file doesn't, or just tell user to run backtester
        console.log("❌ Please run the live system or backtester to generate 'data/MNQH26_1min.json'");
        return;
    }

    if (bars.length < 500) {
        console.log("❌ Not enough data for a valid audit. Need at least 500 bars.");
        return;
    }

    const data = addIndicators(bars);
    const s1 = detect3BarPlay(data);
    const s2 = detectBuySellSetup(data);
    const allSignals = [...s1, ...s2];

    const resultsByLevel: Record<number, { wins: number; losses: number; count: number }> = {};
    for (let c = 1; c <= 12; c++) resultsByLevel[c] = { wins: 0, losses: 0, count: 0 };

    console.log(`Analyzing ${allSignals.length} signals across ${bars.length} bars...`);

    allSignals.forEach(sig => {
        const i = sig.index;
        const entry = bars[i].close;
        const risk = data.atr[i] * 1.5;
        const stop = sig.direction === "LONG" ? entry - risk : entry + risk;
        const target = sig.direction === "LONG" ? entry + risk * 2 : entry - risk * 2; // 1:2 R:R

        let outcome: "WIN" | "LOSS" | "TIMEOUT" = "TIMEOUT";
        for (let j = i + 1; j < Math.min(i + 60, bars.length); j++) {
            if (sig.direction === "LONG") {
                if (bars[j].low <= stop) { outcome = "LOSS"; break; }
                if (bars[j].high >= target) { outcome = "WIN"; break; }
            } else {
                if (bars[j].high >= stop) { outcome = "LOSS"; break; }
                if (bars[j].low <= target) { outcome = "WIN"; break; }
            }
        }

        const conf = sig.confluence;
        resultsByLevel[conf].count++;
        if (outcome === "WIN") resultsByLevel[conf].wins++;
        else if (outcome === "LOSS") resultsByLevel[conf].losses++;
    });

    console.log("\n--- Audit Results by Confluence Level ---");
    console.log("Conf | Trades | Wins | Losses | Win Rate");
    console.log("------------------------------------------");

    let aPlusWins = 0, aPlusLosses = 0;

    for (let c = 12; c >= 3; c--) {
        const res = resultsByLevel[c];
        if (res.count === 0) continue;
        const wr = ((res.wins / (res.wins + res.losses)) * 100).toFixed(1);
        const star = c >= 8 ? "⭐" : "  ";
        console.log(`${star} ${c.toString().padStart(2)} | ${res.count.toString().padStart(6)} | ${res.wins.toString().padStart(4)} | ${res.losses.toString().padStart(6)} | ${wr}%`);

        if (c >= 8) {
            aPlusWins += res.wins;
            aPlusLosses += res.losses;
        }
    }

    console.log("------------------------------------------");
    const totalAA = aPlusWins + aPlusLosses;
    const finalWR = ((aPlusWins / totalAA) * 100).toFixed(1);

    console.log(`🏆 FINAL A+ AUDIT (Conf ≥ 8)`);
    console.log(`Total A+ Trades: ${totalAA}`);
    console.log(`A+ Win Rate: ${finalWR}% 🔥`);
    console.log("------------------------------------------");
    console.log("Next Step: Run with 'npx tsx server/verify_strategy.ts' after generating data.");
}

run();
