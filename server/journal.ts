import fs from "fs";
import path from "path";

const JOURNAL_FILE = path.join(process.cwd(), "data", "trade_journal.json");
const SETTINGS_FILE = path.join(process.cwd(), "data", "trader_settings.json");

function ensureDataDir() {
  const dir = path.dirname(JOURNAL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
}

export interface TraderSettings {
  riskPct: number;
  rewardRatio: number;
  enabledPatterns: string[];
}

const DEFAULT_SETTINGS: TraderSettings = {
  riskPct: 0.5,
  rewardRatio: 2,
  enabledPatterns: ["3bar", "buysetup", "breakout", "climax", "mabounce"],
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

export function loadSettings(): TraderSettings {
  ensureDataDir();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) };
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
