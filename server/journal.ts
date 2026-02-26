import fs from "fs";
import path from "path";

const JOURNAL_FILE = path.join(process.cwd(), "data", "trade_journal.json");
const SETTINGS_FILE = path.join(process.cwd(), "data", "trader_settings.json");

function ensureDataDir() {
  const dir = path.dirname(JOURNAL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export interface ConfluenceChecklist {
  patternMatch: boolean;
  volumeConfirmation: boolean;
  maRespect: boolean;
  priorPivotSR: boolean;
  barFormation: boolean;
}

export interface JournalEntry {
  id: string;
  timestamp: string;
  symbol: string;
  timeframe: string;
  pattern: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  exit: number;
  pnlPoints: number;
  pnlDollars: number;
  confluence: number;
  confluenceLabel: string;
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  reason: string;
  notes: string;
  rewardRatio: number;
  achievedRR: number;
  dataSource: string;
  checklist?: ConfluenceChecklist;
}

export interface TraderSettings {
  riskPct: number;
  rewardRatio: number;
  enabledPatterns: string[];
  enabledTimeframes: string[];
}

const DEFAULT_SETTINGS: TraderSettings = {
  riskPct: 0.5,
  rewardRatio: 2,
  enabledPatterns: ["3bar_long", "3bar_short", "buysetup", "sellsetup", "breakout_long", "breakout_short", "climax_long", "climax_short", "mabounce_long", "mabounce_short"],
  enabledTimeframes: ["2min", "5min", "15min", "1hour", "4hour", "daily"],
};

export function loadJournal(): JournalEntry[] {
  ensureDataDir();
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

export function saveJournal(entries: JournalEntry[]): void {
  try {
    ensureDataDir();
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error("[journal] Failed to save journal:", err);
  }
}

export function addJournalEntry(entry: JournalEntry): void {
  try {
    const entries = loadJournal();
    entries.push(entry);
    saveJournal(entries);
  } catch (err) {
    console.error("[journal] Failed to add entry:", err);
  }
}

export function updateJournalNotes(id: string, notes: string): boolean {
  try {
    const entries = loadJournal();
    const entry = entries.find(e => e.id === id);
    if (!entry) return false;
    entry.notes = notes;
    saveJournal(entries);
    return true;
  } catch (err) {
    console.error("[journal] Failed to update notes:", err);
    return false;
  }
}

export function deleteJournalEntry(id: string): boolean {
  try {
    const entries = loadJournal();
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    saveJournal(entries);
    return true;
  } catch (err) {
    console.error("[journal] Failed to delete entry:", err);
    return false;
  }
}

export function clearJournal(): void {
  try {
    saveJournal([]);
  } catch (err) {
    console.error("[journal] Failed to clear journal:", err);
  }
}

function migratePatternKeys(patterns: string[]): string[] {
  const migrationMap: Record<string, string[]> = {
    "3bar": ["3bar_long", "3bar_short"],
    "buysetup": ["buysetup", "sellsetup"],
    "breakout": ["breakout_long", "breakout_short"],
    "climax": ["climax_long", "climax_short"],
    "mabounce": ["mabounce_long", "mabounce_short"],
  };
  const newKeys = new Set<string>();
  for (const p of patterns) {
    if (migrationMap[p]) {
      migrationMap[p].forEach(k => newKeys.add(k));
    } else {
      newKeys.add(p);
    }
  }
  return [...newKeys];
}

export function loadSettings(): TraderSettings {
  ensureDataDir();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      const legacyKeys = ["3bar", "breakout", "climax", "mabounce"];
      const needsMigration = raw.enabledPatterns && raw.enabledPatterns.some((p: string) => legacyKeys.includes(p));
      const missingNewKeys = raw.enabledPatterns && !raw.enabledPatterns.some((p: string) => p.includes("_long") || p.includes("_short") || p === "sellsetup");
      if (needsMigration || missingNewKeys) {
        raw.enabledPatterns = migratePatternKeys(raw.enabledPatterns);
      }
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Partial<TraderSettings>): TraderSettings {
  try {
    ensureDataDir();
    const current = loadSettings();
    const merged = { ...current, ...settings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    return merged;
  } catch (err) {
    console.error("[journal] Failed to save settings:", err);
    return loadSettings();
  }
}

export function getAdvancedAnalytics(entries: JournalEntry[]) {
  if (entries.length === 0) return { byPattern: [], bySymbol: [], byTimeframe: [], byConfluence: [], recommendations: [], overall: { winRate: 0, profitFactor: 0, expectancy: 0, totalPnl: 0, totalTrades: 0 } };

  function groupStats(groupedMap: Record<string, JournalEntry[]>) {
    return Object.entries(groupedMap).map(([key, trades]) => {
      const wins = trades.filter(t => t.outcome === "WIN").length;
      const winRate = Math.round((wins / trades.length) * 1000) / 10;
      const avgRR = trades.length > 0 ? Math.round(trades.reduce((s, t) => s + (t.achievedRR || 0), 0) / trades.length * 100) / 100 : 0;
      const totalPnl = Math.round(trades.reduce((s, t) => s + t.pnlDollars, 0) * 100) / 100;
      const grossProfit = trades.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0);
      const grossLoss = Math.abs(trades.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0));
      const profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 99.99 : 0;
      return { name: key, trades: trades.length, wins, winRate, avgRR, totalPnl, profitFactor };
    }).sort((a, b) => b.totalPnl - a.totalPnl);
  }

  const byPatternMap: Record<string, JournalEntry[]> = {};
  const bySymbolMap: Record<string, JournalEntry[]> = {};
  const byTimeframeMap: Record<string, JournalEntry[]> = {};
  const byConfluenceMap: Record<string, JournalEntry[]> = {};

  entries.forEach(e => {
    (byPatternMap[e.pattern] = byPatternMap[e.pattern] || []).push(e);
    (bySymbolMap[e.symbol] = bySymbolMap[e.symbol] || []).push(e);
    (byTimeframeMap[e.timeframe] = byTimeframeMap[e.timeframe] || []).push(e);
    const confLevel = e.confluence >= 7 ? "7+ (A+)" : e.confluence >= 5 ? "5-6 (High)" : e.confluence >= 3 ? "3-4 (Moderate)" : "1-2 (Low)";
    (byConfluenceMap[confLevel] = byConfluenceMap[confLevel] || []).push(e);
  });

  const byPattern = groupStats(byPatternMap);
  const bySymbol = groupStats(bySymbolMap);
  const byTimeframe = groupStats(byTimeframeMap);
  const byConfluence = groupStats(byConfluenceMap);

  const totalWins = entries.filter(e => e.outcome === "WIN").length;
  const overallWinRate = Math.round((totalWins / entries.length) * 1000) / 10;
  const gp = entries.filter(e => e.pnlDollars > 0).reduce((s, e) => s + e.pnlDollars, 0);
  const gl = Math.abs(entries.filter(e => e.pnlDollars < 0).reduce((s, e) => s + e.pnlDollars, 0));
  const overallPF = gl > 0 ? Math.round((gp / gl) * 100) / 100 : gp > 0 ? 99.99 : 0;
  const avgWin = totalWins > 0 ? gp / totalWins : 0;
  const totalLosses = entries.filter(e => e.outcome === "LOSS").length;
  const avgLoss = totalLosses > 0 ? gl / totalLosses : 0;
  const expectancy = entries.length > 0 ? Math.round(((overallWinRate / 100 * avgWin) - ((1 - overallWinRate / 100) * avgLoss)) * 100) / 100 : 0;
  const totalPnl = Math.round(entries.reduce((s, e) => s + e.pnlDollars, 0) * 100) / 100;

  const recommendations: string[] = [];
  byPattern.forEach(p => {
    if (p.trades >= 3 && p.winRate >= 65) {
      recommendations.push(`Increase size on ${p.name} - ${p.winRate}% win rate over ${p.trades} trades`);
    }
    if (p.trades >= 3 && p.winRate < 35) {
      recommendations.push(`Reduce or eliminate ${p.name} - only ${p.winRate}% win rate over ${p.trades} trades`);
    }
  });
  byTimeframe.forEach(tf => {
    if (tf.trades >= 3 && tf.winRate >= 65) {
      recommendations.push(`${tf.name} timeframe is your sweet spot - ${tf.winRate}% win rate`);
    }
  });
  byConfluence.forEach(c => {
    if (c.name.includes("A+") && c.trades >= 2 && c.winRate >= 60) {
      recommendations.push(`High confluence setups are paying off - ${c.winRate}% win rate. Be patient for A+ entries.`);
    }
  });
  if (bySymbol.length > 0 && bySymbol[0].trades >= 3) {
    recommendations.push(`${bySymbol[0].name} is your best symbol (+$${bySymbol[0].totalPnl}). Focus your edge there.`);
  }
  if (recommendations.length === 0) {
    recommendations.push("Keep trading and building data. At least 10 trades needed for meaningful edge analysis.");
  }

  return {
    byPattern, bySymbol, byTimeframe, byConfluence, recommendations,
    overall: { winRate: overallWinRate, profitFactor: overallPF, expectancy, totalPnl, totalTrades: entries.length }
  };
}

export function getJournalStats(entries: JournalEntry[]) {
  if (entries.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, breakevens: 0,
      winRate: 0, profitFactor: 0, totalPnl: 0,
      bestSymbol: "--", bestPattern: "--", avgRR: 0,
    };
  }

  const wins = entries.filter(e => e.outcome === "WIN").length;
  const losses = entries.filter(e => e.outcome === "LOSS").length;
  const breakevens = entries.filter(e => e.outcome === "BREAKEVEN").length;
  const winRate = entries.length > 0 ? (wins / entries.length) * 100 : 0;

  const grossProfit = entries.filter(e => e.pnlDollars > 0).reduce((s, e) => s + e.pnlDollars, 0);
  const grossLoss = Math.abs(entries.filter(e => e.pnlDollars < 0).reduce((s, e) => s + e.pnlDollars, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalPnl = entries.reduce((s, e) => s + e.pnlDollars, 0);

  const symbolPnl: Record<string, number> = {};
  const patternPnl: Record<string, number> = {};
  entries.forEach(e => {
    symbolPnl[e.symbol] = (symbolPnl[e.symbol] || 0) + e.pnlDollars;
    patternPnl[e.pattern] = (patternPnl[e.pattern] || 0) + e.pnlDollars;
  });

  const bestSymbol = Object.entries(symbolPnl).sort((a, b) => b[1] - a[1])[0]?.[0] || "--";
  const bestPattern = Object.entries(patternPnl).sort((a, b) => b[1] - a[1])[0]?.[0] || "--";

  const avgRR = entries.length > 0
    ? entries.reduce((s, e) => s + (e.achievedRR || 0), 0) / entries.length
    : 0;

  return {
    totalTrades: entries.length, wins, losses, breakevens,
    winRate: Math.round(winRate * 10) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    bestSymbol, bestPattern,
    avgRR: Math.round(avgRR * 100) / 100,
  };
}
