import type { Express } from "express";
import { type Server } from "http";
import path from "path";
import fs from "fs";
import express from "express";
import { startTrader, stopTrader, getTraderLogs, getTraderStatus, isTradingOpen, isForceTradeActive, getTradovateStatus, connectTradovate, forwardSignalToSupabase, getSafetyStatus, getApexEvalStatus, setDailyLossLimit, getNewsFilterStatus, getFundingWhitelist } from "./trader";
import { getTradeAck } from "./supabase";
import { loadJournal, getJournalStats, getAdvancedAnalytics, updateJournalNotes, deleteJournalEntry, clearJournal, loadSettings, saveSettings } from "./journal";
import { sendToCrossTrade, sendCloseAll } from "./services/crosstrade";
import { markAccountFailed as sharedMarkFailed, resetAccountStatus as sharedResetAccount, isAccountFailed } from "./account-status";
import { runBacktest, simulateApexEval, downloadBulkCache, getBulkCacheStatus, scanCachedEdges } from "./backtest";

let skills: any[] = [];

interface AccountConfig {
  id: string;
  name: string;
  type: "sim" | "test" | "funded";
}

interface AccountStatus {
  status: "active" | "failed";
  reason?: string;
  failedAt?: string;
}

const ACCOUNTS: AccountConfig[] = [
  { id: "Sim101", name: "NinjaTrader Sim 101", type: "sim" },
  { id: "APEX22106300000115", name: "Apex Funded 50k #5", type: "funded" },
  { id: "APEX22106300000114", name: "Apex Funded 50k #4", type: "funded" },
];

const accountStatuses: Record<string, AccountStatus> = {};
ACCOUNTS.forEach(a => { accountStatuses[a.id] = { status: "active" }; });

function markAccountFailed(accountId: string, reason: string) {
  accountStatuses[accountId] = { status: "failed", reason, failedAt: new Date().toISOString() };
  sharedMarkFailed(accountId, reason);
}

function isAccountActive(accountId: string): boolean {
  return !isAccountFailed(accountId);
}

let activeAccount: AccountConfig = ACCOUNTS[0];

interface TradeSignal {
  symbol: string;
  direction: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: string;
  confluence: number;
  pattern: string;
  timestamp: string;
  source: string;
}

const signalLog: TradeSignal[] = [];

interface PermitInfo {
  permits: string[];
  estimatedFees: string;
  approvalTime: string;
  notes: string[];
  nextSteps: string[];
  officialLinks: { label: string; url: string }[];
}

function getPermitInfo(renovationType: string, propertyType: string, county: string, details: string): PermitInfo {
  const countyData: Record<string, { name: string; office: string; url: string; phone: string }> = {
    "polk": { name: "Polk County / City of Lakeland", office: "Polk County Building Division", url: "https://www.polk-county.net/building-division", phone: "(863) 534-6080" },
    "orange": { name: "Orange County / City of Orlando", office: "Orange County Building Safety Division", url: "https://www.orangecountyfl.net/BuildingPermitting.aspx", phone: "(407) 836-5540" },
    "hillsborough": { name: "Hillsborough County", office: "Hillsborough County Building Services", url: "https://www.hillsboroughcounty.org/residents/property-owners-and-renters/building-and-renovations", phone: "(813) 272-5600" },
    "pasco": { name: "Pasco County", office: "Pasco County Building Division", url: "https://www.pascocountyfl.net/157/Building-Construction-Services", phone: "(727) 847-8129" },
    "other": { name: "Florida (General)", office: "Local County Building Department", url: "https://www.floridabuilding.org", phone: "Check local directory" },
  };

  const info = countyData[county] || countyData["other"];

  const permits: string[] = [];
  const notes: string[] = [];
  let feeLow = 0;
  let feeHigh = 0;
  let approvalDays = "";

  notes.push("All work must comply with the Florida Building Code (FBC) 8th Edition (2023).");
  notes.push("Florida Wind Mitigation: structures must meet hurricane-resistance standards per FBC Section 1609.");

  switch (renovationType) {
    case "kitchen":
      permits.push("General Building Permit");
      permits.push("Electrical Permit (new circuits, outlets, appliance wiring)");
      permits.push("Plumbing Permit (sink relocation, gas line, dishwasher)");
      if (details.toLowerCase().includes("gas") || details.toLowerCase().includes("range")) {
        permits.push("Mechanical/Gas Permit (gas appliance hookup)");
      }
      feeLow = 250; feeHigh = 900;
      approvalDays = "5-15 business days";
      notes.push("Moving walls may require structural engineering review.");
      notes.push("Florida Energy Conservation Code requires updated insulation if exterior walls are opened.");
      break;
    case "bathroom":
      permits.push("General Building Permit");
      permits.push("Plumbing Permit (fixture relocation, water heater, drain lines)");
      permits.push("Electrical Permit (GFCI outlets, exhaust fan, lighting)");
      feeLow = 200; feeHigh = 700;
      approvalDays = "5-10 business days";
      notes.push("All bathroom outlets must be GFCI protected per NEC 210.8.");
      notes.push("Shower/tub waterproofing must meet Florida Building Code Section 1210.");
      break;
    case "roof":
      permits.push("Roofing Permit (required for all roof work in Florida)");
      permits.push("Notice of Commencement (must be recorded before work begins)");
      feeLow = 200; feeHigh = 600;
      approvalDays = "3-10 business days";
      notes.push("CRITICAL: Roof must meet FBC High-Velocity Hurricane Zone (HVHZ) standards if applicable.");
      notes.push("Roofing contractor must be licensed and insured in the State of Florida.");
      notes.push("Re-roofing over existing layers may be limited to one layer per FBC Section 706.3.");
      notes.push("Product approval required: all roofing materials must be Florida Product Approved.");
      break;
    case "addition":
      permits.push("General Building Permit (with full plan review)");
      permits.push("Electrical Permit");
      permits.push("Plumbing Permit (if adding bath/kitchen)");
      permits.push("Mechanical Permit (HVAC extension)");
      permits.push("Notice of Commencement");
      permits.push("Zoning Approval / Setback Verification");
      feeLow = 800; feeHigh = 3500;
      approvalDays = "15-30 business days";
      notes.push("Requires stamped architectural and structural drawings by a licensed FL engineer/architect.");
      notes.push("Must comply with local zoning setbacks, lot coverage, and FAR (Floor Area Ratio).");
      notes.push("Impact fees may apply for additional square footage.");
      notes.push("Flood zone determination required - may need elevation certificate (FEMA).");
      break;
    case "pool":
      permits.push("Pool/Spa Construction Permit");
      permits.push("Electrical Permit (pump, lighting, bonding)");
      permits.push("Plumbing Permit (water supply, drainage)");
      permits.push("Fence/Barrier Permit (Florida Residential Pool Safety Act)");
      permits.push("Notice of Commencement");
      feeLow = 500; feeHigh = 1500;
      approvalDays = "10-20 business days";
      notes.push("MANDATORY: Pool barrier (fence/screen) required per FL Statute 515.27 - minimum 4ft height.");
      notes.push("At least one approved safety feature required: alarm, safety cover, or self-closing door.");
      notes.push("Pool contractor must hold CPC license (Certified Pool Contractor).");
      notes.push("Underground utility locate (Sunshine 811) required before excavation.");
      break;
    case "electrical":
      permits.push("Electrical Permit");
      permits.push("Panel Upgrade Permit (if upgrading service)");
      feeLow = 100; feeHigh = 450;
      approvalDays = "3-7 business days";
      notes.push("Panel upgrades require utility company coordination (Duke/OUC/TECO).");
      notes.push("Must meet NEC 2020 as adopted by Florida Building Code.");
      notes.push("Arc-fault circuit interrupters (AFCI) required in bedrooms, living areas per NEC 210.12.");
      break;
    case "plumbing":
      permits.push("Plumbing Permit");
      feeLow = 100; feeHigh = 400;
      approvalDays = "3-7 business days";
      notes.push("Water heater replacement requires permit in Florida.");
      notes.push("Backflow prevention devices required per FL Plumbing Code.");
      notes.push("Re-piping a house (polybutylene replacement) requires full plumbing permit.");
      break;
    default:
      permits.push("General Building Permit (scope-dependent)");
      feeLow = 150; feeHigh = 1000;
      approvalDays = "5-15 business days";
      notes.push("Contact your local building department to confirm specific permit requirements.");
      break;
  }

  if (propertyType === "commercial") {
    feeLow = Math.round(feeLow * 1.5);
    feeHigh = Math.round(feeHigh * 2);
    permits.push("Commercial Plan Review (fire, ADA, occupancy)");
    notes.push("Commercial projects require Fire Marshal review and ADA compliance.");
    approvalDays = approvalDays.replace(/(\d+)/g, (m) => String(Math.round(Number(m) * 1.5)));
  }

  if (propertyType === "multifamily") {
    feeLow = Math.round(feeLow * 1.25);
    feeHigh = Math.round(feeHigh * 1.5);
    notes.push("Multifamily projects may require Fire Marshal review depending on unit count.");
  }

  const nextSteps = [
    `Contact ${info.office} at ${info.phone} to confirm requirements for your specific project.`,
    "Hire a licensed & insured Florida contractor (verify at myfloridalicense.com).",
    "File a Notice of Commencement with the County Clerk if project value exceeds $2,500.",
    "Schedule required inspections at each phase (foundation, framing, rough-in, final).",
    "Obtain a Certificate of Completion / final inspection sign-off before closing out the project.",
  ];

  const officialLinks = [
    { label: `${info.name} - Building Permits`, url: info.url },
    { label: "Florida Building Code Online", url: "https://www.floridabuilding.org/bc/bc_default.aspx" },
    { label: "Verify FL Contractor License", url: "https://www.myfloridalicense.com/wl11.asp" },
    { label: "Sunshine 811 (Call Before You Dig)", url: "https://www.sunshine811.com" },
    { label: "FEMA Flood Map Service", url: "https://msc.fema.gov/portal/home" },
  ];

  return {
    permits,
    estimatedFees: `$${feeLow} - $${feeHigh}`,
    approvalTime: approvalDays,
    notes,
    nextSteps,
    officialLinks,
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const savedSettings = loadSettings();
  if (savedSettings.dailyLossLimit && savedSettings.dailyLossLimit > 0) {
    setDailyLossLimit(savedSettings.dailyLossLimit);
  }

  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const html = fs.readFileSync(path.resolve(process.cwd(), "public", "index.html"), "utf-8");
    res.type("html").send(html);
  });

  app.use("/public", express.static(path.resolve(process.cwd(), "public"), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); } }));

  app.get("/health", (_req, res) => res.send("OK"));

  app.post("/api/create-skill", (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const skill = { id: Date.now(), name, description: description || "", createdAt: new Date() };
    skills.push(skill);
    res.json({ success: true, skill });
  });

  app.get("/api/skills", (_req, res) => res.json(skills));

  app.post("/api/florida-permit-checker", (req, res) => {
    const { renovationType, propertyType, county, details } = req.body;
    if (!renovationType || !propertyType || !county) {
      return res.status(400).json({ error: "renovationType, propertyType, and county are required." });
    }
    const result = getPermitInfo(renovationType, propertyType, county, details || "");
    res.json({ success: true, ...result });
  });

  app.get("/api/trader/status", (_req, res) => {
    const tvStatus = getTradovateStatus();
    res.json({ tradingOpen: isTradingOpen(), forceActive: isForceTradeActive(), tradovate: tvStatus });
  });

  app.get("/api/trader/safety", (_req, res) => {
    res.json({ ...getSafetyStatus(), newsFilter: getNewsFilterStatus() });
  });

  app.get("/api/trader/apex-eval", (req, res) => {
    const plan = (req.query.plan as string) || "50k";
    res.json(getApexEvalStatus(undefined, plan));
  });

  app.post("/api/tradovate/connect", async (_req, res) => {
    const result = await connectTradovate();
    res.json(result);
  });

  app.get("/api/tradovate/status", (_req, res) => {
    res.json(getTradovateStatus());
  });

  app.post("/api/trader/start", (req, res) => {
    const { markets, timeframes, riskDollars, rewardRatio, maxOpenTrades, dailyLossLimit, account, accounts, patterns, customCondition, forceTrading, fundingMode } = req.body;
    if (!markets?.length || !timeframes?.length || !patterns?.length) {
      return res.status(400).json({ error: "markets, timeframes, and patterns are required." });
    }
    if (dailyLossLimit && dailyLossLimit > 0) {
      setDailyLossLimit(dailyLossLimit);
    }
    const resolvedAccounts = Array.isArray(accounts) && accounts.length > 0 ? accounts : [account || "SIM101"];
    const sessionId = startTrader({ markets, timeframes, riskDollars: riskDollars || 100, rewardRatio: rewardRatio || 2, maxOpenTrades: maxOpenTrades || 3, account: resolvedAccounts[0], accounts: resolvedAccounts, patterns, customCondition: customCondition || "", forceTrading: !!forceTrading, fundingMode: !!fundingMode });
    res.json({ success: true, sessionId, accounts: resolvedAccounts });
  });

  app.post("/api/trader/stop", (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required." });
    const stopped = stopTrader(sessionId);
    res.json({ success: stopped });
  });

  app.get("/api/trader/logs/:sessionId", (req, res) => {
    const after = req.query.after ? Number(req.query.after) : undefined;
    const logs = getTraderLogs(req.params.sessionId, after);
    const status = getTraderStatus(req.params.sessionId);
    res.json({ logs, status });
  });

  app.get("/api/trader/funding-whitelist", (_req, res) => {
    res.json({ whitelist: getFundingWhitelist() });
  });

  app.post("/api/trade-signal", async (req, res) => {
    const { symbol, direction, entryPrice, stopLoss, takeProfit, riskReward, confluence, pattern } = req.body;
    if (!symbol || !direction || entryPrice == null || stopLoss == null || takeProfit == null) {
      return res.status(400).json({ success: false, error: "Missing required fields: symbol, direction, entryPrice, stopLoss, takeProfit" });
    }
    const now = new Date();
    const estOffset = -5 * 60;
    const est = new Date(now.getTime() + (now.getTimezoneOffset() + estOffset) * 60000);
    const ts = est.toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });

    const signal: TradeSignal = {
      symbol: String(symbol).toUpperCase(),
      direction: String(direction),
      entryPrice: Number(entryPrice),
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
      riskReward: riskReward || "1:2",
      confluence: confluence || 0,
      pattern: pattern || "Unknown",
      timestamp: ts,
      source: req.body.source || "external",
    };

    signalLog.push(signal);
    if (signalLog.length > 200) signalLog.shift();

    const safety = getSafetyStatus();
    if (safety.dailyLimitHit) {
      console.warn(`[trade-signal] BLOCKED by daily loss limit: $${safety.dailyPnl.toFixed(2)}`);
      return res.status(403).json({ success: false, error: "Daily loss limit reached — trading paused", safety });
    }

    console.log(`[trade-signal] ${signal.source.toUpperCase()} | ${signal.direction} ${signal.symbol} @ ${signal.entryPrice} | SL: ${signal.stopLoss} TP: ${signal.takeProfit} | ${signal.pattern} (${signal.confluence}) | R:R ${signal.riskReward}`);

    let signalId = "";
    let queueStatus = "skipped";
    try {
      const result = await forwardSignalToSupabase({
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        riskReward: signal.riskReward,
        confluence: signal.confluence,
        pattern: signal.pattern,
        qty: req.body.qty || 1,
        source: signal.source,
      });
      signalId = result.signalId;
      queueStatus = result.status;
      console.log(`[trade-signal] Supabase queue result for ${signal.symbol}: status=${result.status} signalId=${result.signalId}`);
    } catch (err: any) {
      console.error(`[trade-signal] Supabase queue error for ${signal.symbol}: ${err.message}`);
      return res.status(502).json({ success: false, error: `Supabase insert failed: ${err.message}`, signal });
    }

    res.json({ success: true, message: "Signal received", signal, signalId, queueStatus });
  });

  app.get("/api/trade-signals", (_req, res) => {
    res.json({ signals: signalLog, count: signalLog.length });
  });

  app.get("/api/trade-ack/:signalId", async (req, res) => {
    try {
      const ack = await getTradeAck(req.params.signalId);
      if (ack === null && !process.env.SUPABASE_URL) {
        return res.json({ status: "error", signalId: req.params.signalId, reason: "Supabase not configured" });
      }
      if (ack) {
        res.json(ack);
      } else {
        res.json({ status: "pending", signalId: req.params.signalId });
      }
    } catch (err: any) {
      res.status(500).json({ status: "error", signalId: req.params.signalId, reason: err.message });
    }
  });

  app.post("/api/crosstrade/test", async (req, res) => {
    const { symbol, direction, account } = req.body;
    if (!symbol || !direction) {
      return res.status(400).json({ success: false, error: "Missing symbol or direction" });
    }
    const result = await sendToCrossTrade({
      symbol: symbol.toUpperCase(),
      direction: direction,
      orderType: "MARKET",
      account: account
    });
    res.json(result);
  });

  app.post("/api/trader/close-all", async (req, res) => {
    const { account } = req.body;
    try {
      const result = await sendCloseAll(account || "Sim101");
      console.log(`[trader] Close all positions: account=${account || "sim101"} result=${result.message}`);
      res.json({ success: result.success, message: result.message });
    } catch (err: any) {
      console.error(`[trader] Close all error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/accounts", (_req, res) => {
    res.json({ accounts: ACCOUNTS, active: activeAccount });
  });

  app.get("/api/apex/eval-status", (_req, res) => {
    const safety = getSafetyStatus();
    const evalStatus = getApexEvalStatus();

    const accountsWithStatus = ACCOUNTS.map(a => {
      const st = accountStatuses[a.id] || { status: "active" };
      if (a.type === "funded" && st.status === "active") {
        if (safety.dailyLimitHit) {
          markAccountFailed(a.id, "Daily loss limit breached");
          return { ...a, status: "failed" as const, reason: "Daily loss limit breached" };
        }
        const dd = evalStatus.trailingDrawdown;
        if (dd <= -0.03) {
          markAccountFailed(a.id, `Trailing drawdown breached (${(dd * 100).toFixed(1)}%)`);
          return { ...a, status: "failed" as const, reason: `Trailing drawdown breached (${(dd * 100).toFixed(1)}%)` };
        }
      }
      return { ...a, status: st.status, reason: st.reason, failedAt: st.failedAt };
    });

    res.json(accountsWithStatus);
  });

  app.post("/api/apex/reset-account", (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ success: false, error: "accountId required" });
    if (!accountStatuses[accountId]) return res.status(404).json({ success: false, error: "Account not found" });
    accountStatuses[accountId] = { status: "active" };
    sharedResetAccount(accountId);
    console.log(`[apex] Account ${accountId} status reset to active`);
    res.json({ success: true, message: `${accountId} reset to active` });
  });

  app.post("/api/config/set-account", (req, res) => {
    const { account } = req.body;
    if (!account) {
      return res.status(400).json({ success: false, error: "Missing account id" });
    }
    const found = ACCOUNTS.find(a => a.id === account);
    if (!found) {
      return res.status(400).json({ success: false, error: `Unknown account: ${account}` });
    }
    if (!isAccountActive(account)) {
      return res.status(400).json({ success: false, error: `Account ${account} has failed eval — cannot select` });
    }
    if (found.type === "funded" && process.env.ALLOW_LIVE_TRADES !== "true") {
      console.warn(`[account] Switched to funded account ${found.id} — execution disabled (ALLOW_LIVE_TRADES != true)`);
    }
    activeAccount = found;
    console.log(`[account] Active account switched to: ${found.id} (${found.type})`);
    res.json({ success: true, account: activeAccount });
  });

  app.get("/api/journal", (_req, res) => {
    const entries = loadJournal();
    const stats = getJournalStats(entries);
    res.json({ entries, stats });
  });

  app.patch("/api/journal/:id/notes", (req, res) => {
    const { notes } = req.body;
    const ok = updateJournalNotes(req.params.id, notes || "");
    res.json({ success: ok });
  });

  app.delete("/api/journal/:id", (req, res) => {
    const ok = deleteJournalEntry(req.params.id);
    res.json({ success: ok });
  });

  app.delete("/api/journal", (_req, res) => {
    clearJournal();
    res.json({ success: true });
  });

  app.get("/api/journal/csv", (_req, res) => {
    const entries = loadJournal();
    const header = "Timestamp,Symbol,Timeframe,Pattern,Direction,Entry,Stop,Target,Exit,P&L Points,P&L $,Confluence,Outcome,R:R Achieved,Reason,Notes";
    const rows = entries.map(e =>
      [e.timestamp, e.symbol, e.timeframe, e.pattern, e.direction,
       e.entry, e.stop, e.target, e.exit, e.pnlPoints, e.pnlDollars,
       e.confluence, e.outcome, e.achievedRR,
       `"${(e.reason || "").replace(/"/g, '""')}"`,
       `"${(e.notes || "").replace(/"/g, '""')}"`
      ].join(",")
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=trade_journal.csv");
    res.send([header, ...rows].join("\n"));
  });

  app.get("/api/journal/analytics", (req, res) => {
    let entries = loadJournal();
    const patterns = req.query.patterns ? String(req.query.patterns).split(",") : null;
    const timeframes = req.query.timeframes ? String(req.query.timeframes).split(",") : null;
    if (patterns) {
      const allowedCombos = new Set<string>();
      const keyMap: Record<string, {pattern: string; direction: string}> = {
        "3bar_long": {pattern: "3 Bar Play", direction: "LONG"},
        "3bar_short": {pattern: "3 Bar Play", direction: "SHORT"},
        "buysetup": {pattern: "Buy Setup", direction: "LONG"},
        "sellsetup": {pattern: "Sell Setup", direction: "SHORT"},
        "breakout_long": {pattern: "Pivot Breakout", direction: "LONG"},
        "breakout_short": {pattern: "Pivot Breakout", direction: "SHORT"},
        "climax_long": {pattern: "Climax Reversal", direction: "LONG"},
        "climax_short": {pattern: "Climax Reversal", direction: "SHORT"},
      };
      for (const p of patterns) {
        const m = keyMap[p];
        if (m) allowedCombos.add(`${m.pattern}|${m.direction}`);
      }
      entries = entries.filter(e => allowedCombos.has(`${e.pattern}|${e.direction}`));
    }
    if (timeframes) {
      entries = entries.filter(e => timeframes.includes(e.timeframe));
    }
    const analytics = getAdvancedAnalytics(entries);
    res.json(analytics);
  });

  app.get("/api/settings", (_req, res) => {
    res.json(loadSettings());
  });

  app.post("/api/settings", (req, res) => {
    const saved = saveSettings(req.body);
    if (saved.dailyLossLimit && saved.dailyLossLimit > 0) {
      setDailyLossLimit(saved.dailyLossLimit);
    }
    res.json({ success: true, settings: saved });
  });

  app.post("/api/backtest/pattern", async (req, res) => {
    const { symbol, pattern, from, to, rrRatio, maxHold, minConfluence, timeframe, dataSource } = req.body;
    const validTimeframes = ["daily", "day", "5min", "15min", "30min", "1min", "2min", "3min", "1hour", "4hour", "week", "weekly"];
    const tf = timeframe && validTimeframes.includes(timeframe) ? timeframe : "daily";

    const validPatterns = ["3bar", "4bar", "buysetup", "retest", "breakout", "climax", "cuphandle", "inversecuphandle", "doubletop", "doublebottom", "headshoulders", "invheadshoulders", "wedge", "bullflag", "bearflag", "flagpullback", "bullflagpullback", "bearflagpullback", "flagpullbacksetup", "beartrap", "vwapbounce", "all"];
    if (pattern && !validPatterns.includes(pattern)) {
      return res.status(400).json({ success: false, error: `Invalid pattern: ${pattern}. Valid: ${validPatterns.join(", ")}` });
    }
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ success: false, error: "Invalid 'from' date format. Use YYYY-MM-DD." });
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ success: false, error: "Invalid 'to' date format. Use YYYY-MM-DD." });
    }

    try {
      const result = await runBacktest({ symbol, pattern, from, to, rrRatio, maxHold, minConfluence: Number(minConfluence) || 0, timeframe: tf, dataSource });
      if (result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }
      const { allTrades: _ignored, ...cleanResult } = result;
      res.json({ success: true, ...cleanResult });
    } catch (err: any) {
      console.error("[backtest] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Backtest failed" });
    }
  });

  app.get("/api/backtest/scan-edges", (req, res) => {
    const minWR = Number(req.query.minWinRate) || 45;
    const minT = Number(req.query.minTrades) || 5;
    const minC = Number(req.query.minConfluence) || 5;
    const edges = scanCachedEdges(minWR, minT, minC);
    res.json({ edges, count: edges.length, filters: { minWinRate: minWR, minTrades: minT, minConfluence: minC } });
  });

  app.post("/api/backtest/multi", async (req, res) => {
    const { symbols, pattern, patterns, from, to, rrRatio, maxHold, minConfluence, startDate, endDate, timeframe, timeframes, dataSource } = req.body;
    const symList: string[] = Array.isArray(symbols) ? symbols.slice(0, 25) : ["ES", "NQ", "CL", "GC", "ZS"];
    const validPatterns = ["3bar", "4bar", "buysetup", "retest", "breakout", "climax", "cuphandle", "inversecuphandle", "doubletop", "doublebottom", "headshoulders", "invheadshoulders", "wedge", "bullflag", "bearflag", "flagpullback", "bullflagpullback", "bearflagpullback", "flagpullbacksetup", "beartrap", "vwapbounce", "all"];
    const patternList: string[] = Array.isArray(patterns) ? patterns.filter((p: string) => validPatterns.includes(p)) : (pattern && validPatterns.includes(pattern) ? [pattern] : ["all"]);
    const dateFrom = from || startDate || "2020-01-01";
    const dateTo = to || endDate || new Date().toISOString().slice(0, 10);
    const rr = Number(rrRatio) || 2;
    const hold = Number(maxHold) || 5;
    const minConf = Number(minConfluence) || 0;
    const validTfList = ["daily", "day", "5min", "15min", "30min", "1min", "2min", "3min", "1hour", "4hour", "week", "weekly"];
    const tfList: string[] = Array.isArray(timeframes)
      ? timeframes.filter((t: string) => validTfList.includes(t))
      : (timeframe && validTfList.includes(timeframe) ? [timeframe] : ["daily"]);

    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ success: false, error: "Invalid date format. Use YYYY-MM-DD." });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ success: false, error: "Invalid date format. Use YYYY-MM-DD." });
    }

    const results: any[] = [];
    let totalTrades = 0, totalWins = 0, totalLosses = 0, totalPnl = 0, totalGrossWin = 0, totalGrossLoss = 0;
    const patternAgg: Record<string, { trades: number; wins: number; losses: number; pnl: number; grossWin: number; grossLoss: number }> = {};
    const heatmapCells: { symbol: string; pattern: string; trades: number; wins: number; winRate: number; pf: number; pnl: number; expectancy: number }[] = [];

    for (const sym of symList) {
      const symUpper = String(sym).toUpperCase();
      let symTrades = 0, symWins = 0, symLosses = 0, symPnl = 0, symPF = 0, symWR = 0;
      const symTradeList: any[] = [];

      for (const tf of tfList) {
      for (const pat of patternList) {
        try {
          const r = await runBacktest({ symbol: symUpper, pattern: pat, from: dateFrom, to: dateTo, rrRatio: rr, maxHold: hold, minConfluence: minConf, timeframe: tf, dataSource });
          if (!r.error && r.totalTrades > 0) {
            symTrades += r.totalTrades;
            symWins += r.wins;
            symLosses += r.losses;
            symPnl += r.totalPnlDollars;
            if (r.trades) symTradeList.push(...r.trades);

            if (!patternAgg[pat]) patternAgg[pat] = { trades: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
            patternAgg[pat].trades += r.totalTrades;
            patternAgg[pat].wins += r.wins;
            patternAgg[pat].losses += r.losses;
            patternAgg[pat].pnl += r.totalPnlDollars;
            const patGW = (r.trades || []).filter((t: any) => t.pnlDollars > 0).reduce((s: number, t: any) => s + t.pnlDollars, 0);
            const patGL = Math.abs((r.trades || []).filter((t: any) => t.pnlDollars < 0).reduce((s: number, t: any) => s + t.pnlDollars, 0));
            patternAgg[pat].grossWin += patGW;
            patternAgg[pat].grossLoss += patGL;

            const cellWR = r.totalTrades > 0 ? Math.round((r.wins / r.totalTrades) * 10000) / 100 : 0;
            const cellPF = patGL > 0 ? Math.round((patGW / patGL) * 100) / 100 : (patGW > 0 ? 99 : 0);
            heatmapCells.push({
              symbol: symUpper,
              pattern: pat,
              trades: r.totalTrades,
              wins: r.wins,
              winRate: cellWR,
              pf: cellPF,
              pnl: Math.round(r.totalPnlDollars * 100) / 100,
              expectancy: r.totalTrades > 0 ? Math.round((r.totalPnlDollars / r.totalTrades) * 100) / 100 : 0,
            });
          }
        } catch (err: any) {
          console.error(`[backtest/multi] ${symUpper}/${pat}/${tf}: ${err.message}`);
        }
      }
      }

      symWR = symTrades > 0 ? symWins / symTrades : 0;
      const grossW = symTradeList.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0);
      const grossL = Math.abs(symTradeList.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0));
      symPF = grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : (grossW > 0 ? 99 : 0);

      totalTrades += symTrades;
      totalWins += symWins;
      totalLosses += symLosses;
      totalPnl += symPnl;
      totalGrossWin += grossW;
      totalGrossLoss += grossL;

      results.push({
        symbol: symUpper,
        tradeCount: symTrades,
        winRate: Math.round(symWR * 10000) / 100,
        profitFactor: symPF,
        totalPnL: Math.round(symPnl * 100) / 100,
        totalPnlDollars: Math.round(symPnl * 100) / 100,
        wins: symWins,
        losses: symLosses,
        expectancy: symTrades > 0 ? Math.round((symPnl / symTrades) * 100) / 100 : 0,
        trades: symTradeList,
        success: true,
      });
    }

    const overallWR = totalTrades > 0 ? totalWins / totalTrades : 0;
    const overallPF = totalGrossLoss > 0 ? Math.round((totalGrossWin / totalGrossLoss) * 100) / 100 : (totalGrossWin > 0 ? 99 : 0);

    const patternBreakdown: Record<string, { count: number; wins: number; winRate: number; profitFactor: number; pnl: number; expectancy: number }> = {};
    for (const [pat, agg] of Object.entries(patternAgg)) {
      const wr = agg.trades > 0 ? Math.round((agg.wins / agg.trades) * 10000) / 100 : 0;
      const pf = agg.grossLoss > 0 ? Math.round((agg.grossWin / agg.grossLoss) * 100) / 100 : (agg.grossWin > 0 ? 99 : 0);
      patternBreakdown[pat] = {
        count: agg.trades,
        wins: agg.wins,
        winRate: wr,
        profitFactor: pf,
        pnl: Math.round(agg.pnl * 100) / 100,
        expectancy: agg.trades > 0 ? Math.round((agg.pnl / agg.trades) * 100) / 100 : 0,
      };
    }

    const multiTfAlignments: { symbol: string; pattern: string; timeframes: string[]; entryDate: string; bonus: number }[] = [];
    if (tfList.length > 1) {
      const tradeIndex: Record<string, { tf: string; pattern: string; direction: string; entryDate: string }[]> = {};
      for (const r of results) {
        if (!r.trades) continue;
        for (const t of r.trades) {
          const dateKey = t.entryDate || t.date || "";
          if (!dateKey) continue;
          const key = `${r.symbol}|${t.pattern || ""}|${dateKey}|${t.direction || ""}`;
          if (!tradeIndex[key]) tradeIndex[key] = [];
          tradeIndex[key].push({ tf: t.timeframe || "", pattern: t.pattern || "", direction: t.direction || "", entryDate: dateKey });
        }
      }
      for (const [key, entries] of Object.entries(tradeIndex)) {
        const uniqueTfs = [...new Set(entries.map(e => e.tf))];
        if (uniqueTfs.length >= 2) {
          const [sym, pat, dt] = key.split("|");
          const bonus = (uniqueTfs.length - 1) * 1.5;
          multiTfAlignments.push({ symbol: sym, pattern: pat, timeframes: uniqueTfs, entryDate: dt, bonus });
        }
      }
    }

    res.json({
      success: true,
      summary: {
        symbolsScanned: symList.length,
        patternsUsed: patternList,
        timeframesUsed: tfList,
        totalTrades,
        totalWins,
        totalLosses,
        winRate: Math.round(overallWR * 10000) / 100,
        profitFactor: overallPF,
        netPnL: Math.round(totalPnl * 100) / 100,
        minConfluence: minConf,
        period: `${dateFrom} to ${dateTo}`,
        multiTfAlignments: multiTfAlignments.length,
      },
      patternBreakdown,
      heatmap: heatmapCells,
      multiTfAlignments,
      results,
    });
  });

  app.post("/api/backtest/apex-sim", async (req, res) => {
    const { symbol, pattern, from, to, rrRatio, maxHold, minConfluence, timeframe,
            accountSize, profitTarget, trailingDrawdownMax, dailyLossLimit, minTradeDays, riskPerTrade, mode, dataSource } = req.body;

    const validTimeframes = ["daily", "day", "5min", "15min", "30min", "1min", "2min", "3min", "1hour", "4hour", "week", "weekly"];
    const tf = timeframe && validTimeframes.includes(timeframe) ? timeframe : "daily";
    const validPatterns = ["3bar", "4bar", "buysetup", "retest", "breakout", "climax", "cuphandle", "inversecuphandle", "doubletop", "doublebottom", "headshoulders", "invheadshoulders", "wedge", "bullflag", "bearflag", "flagpullback", "bullflagpullback", "bearflagpullback", "flagpullbacksetup", "beartrap", "vwapbounce", "all"];
    if (pattern && !validPatterns.includes(pattern)) {
      return res.status(400).json({ success: false, error: `Invalid pattern: ${pattern}` });
    }

    try {
      const result = await runBacktest({ symbol, pattern, from, to, rrRatio, maxHold, minConfluence: Number(minConfluence) || 0, timeframe: tf, dataSource });
      if (result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }
      if (result.totalTrades === 0) {
        return res.json({ success: true, backtest: result, apexSim: null, message: "No trades found to simulate" });
      }

      const allTrades = result.allTrades || result.trades || [];
      const simConfig = {
        accountSize: Number(accountSize) || 50000,
        profitTarget: Number(profitTarget) || 1000,
        trailingDrawdownMax: Number(trailingDrawdownMax) || 1500,
        dailyLossLimit: Number(dailyLossLimit) || 1500,
        minTradeDays: Number(minTradeDays) || 5,
        riskPerTrade: Number(riskPerTrade) || 100,
        mode: (mode === "funded" ? "funded" : "eval") as "eval" | "funded",
      };

      const apexSim = simulateApexEval(allTrades, simConfig);
      const { allTrades: _at, ...backtestClean } = result;
      res.json({ success: true, backtest: backtestClean, apexSim });
    } catch (err: any) {
      console.error("[apex-sim] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Apex simulation failed" });
    }
  });

  app.post("/api/backtest/download-bulk", async (req, res) => {
    const { symbols, timeframes } = req.body || {};
    console.log(`[bulk] Bulk cache download requested for ${(symbols || []).length || 'all'} symbols`);
    res.json({ status: "started", message: "Bulk download started in background. Poll /api/backtest/cache-status for progress." });
    downloadBulkCache(symbols, timeframes).then(result => {
      console.log(`[bulk] Complete: ${result.completed.length} cached, ${result.errors.length} errors`);
    }).catch(err => {
      console.error("[bulk] Fatal error:", err);
    });
  });

  app.get("/api/backtest/cache-status", (_req, res) => {
    res.json(getBulkCacheStatus());
  });

  const SCAN_ARCHIVE_PATH = path.resolve("scan_archive.json");

  function loadScanArchive(): any[] {
    try {
      if (fs.existsSync(SCAN_ARCHIVE_PATH)) {
        return JSON.parse(fs.readFileSync(SCAN_ARCHIVE_PATH, "utf-8"));
      }
    } catch {}
    return [];
  }

  function saveScanArchive(data: any[]) {
    fs.writeFileSync(SCAN_ARCHIVE_PATH, JSON.stringify(data, null, 2));
  }

  app.get("/api/scan-archive", (_req, res) => {
    res.json({ success: true, scans: loadScanArchive() });
  });

  app.post("/api/scan-archive", (req, res) => {
    const { scan } = req.body;
    if (!scan) return res.status(400).json({ success: false, error: "No scan data" });
    const archive = loadScanArchive();
    scan.id = Date.now().toString();
    scan.savedAt = new Date().toISOString();
    archive.unshift(scan);
    if (archive.length > 20) archive.length = 20;
    saveScanArchive(archive);
    res.json({ success: true, id: scan.id });
  });

  app.delete("/api/scan-archive/:id", (req, res) => {
    const archive = loadScanArchive().filter((s: any) => s.id !== req.params.id);
    saveScanArchive(archive);
    res.json({ success: true });
  });

  let optimizerRunning = false;
  let optimizerProgress = { status: "idle", current: 0, total: 0, label: "", results: [] as any[] };

  app.post("/api/optimizer/run", async (req, res) => {
    if (optimizerRunning) {
      return res.status(409).json({ success: false, error: "Optimizer already running" });
    }

    const { months, timeframes, rrRatios, minConfluence, symbols } = req.body;
    const tfList = Array.isArray(timeframes) ? timeframes : ["5min", "15min"];
    const rrList = Array.isArray(rrRatios) ? rrRatios : [1.5, 2, 2.5, 3];
    const minConf = Number(minConfluence) || 0;
    const monthsBack = Number(months) || 6;

    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setMonth(fromDate.getMonth() - monthsBack);
    const from = fromDate.toISOString().slice(0, 10);

    const defaultSymbols = ["ES", "NQ", "YM", "RTY", "CL", "GC", "SI", "ZC", "ZS"];
    const symList = Array.isArray(symbols) ? symbols : defaultSymbols;
    const patternList = ["3bar", "4bar", "buysetup", "retest", "breakout", "climax", "cuphandle", "inversecuphandle", "doubletop", "doublebottom", "headshoulders", "invheadshoulders", "wedge"];

    const combos: { symbol: string; pattern: string; tf: string; rr: number }[] = [];
    for (const sym of symList) {
      for (const pat of patternList) {
        for (const tf of tfList) {
          for (const rr of rrList) {
            combos.push({ symbol: sym, pattern: pat, tf, rr });
          }
        }
      }
    }

    optimizerRunning = true;
    optimizerProgress = { status: "running", current: 0, total: combos.length, label: "Starting...", results: [] };

    res.json({ success: true, totalCombos: combos.length, message: `Optimizer started: ${combos.length} combinations (${symList.length} symbols × ${patternList.length} patterns × ${tfList.length} TFs × ${rrList.length} R:R). Poll /api/optimizer/status for progress.` });

    (async () => {
      const allResults: any[] = [];
      for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        optimizerProgress.current = i + 1;
        optimizerProgress.label = `${c.symbol} / ${c.pattern} / ${c.tf} / R:R ${c.rr}`;

        try {
          const r = await runBacktest({ symbol: c.symbol, pattern: c.pattern, from, to, rrRatio: c.rr, maxHold: 5, minConfluence: minConf, timeframe: c.tf });
          if (!r.error && r.totalTrades >= 3) {
            allResults.push({
              symbol: c.symbol,
              pattern: c.pattern,
              tf: c.tf,
              rr: c.rr,
              trades: r.totalTrades,
              wins: r.wins,
              losses: r.losses,
              winRate: r.winRate,
              pf: r.profitFactor,
              pnl: Math.round(r.totalPnlDollars * 100) / 100,
              expectancy: r.expectancy,
              maxDD: r.maxDrawdownPct,
              bestTrade: r.bestTrade,
              worstTrade: r.worstTrade,
            });
          }
        } catch (err: any) {
          console.error(`[optimizer] ${c.symbol}/${c.pattern}/${c.tf}/RR${c.rr}: ${err.message}`);
        }
      }

      allResults.sort((a, b) => {
        const scoreA = (a.pf >= 1.2 ? a.pnl : 0) + (a.winRate * 10) + (a.pf * 100) + (a.expectancy * 5);
        const scoreB = (b.pf >= 1.2 ? b.pnl : 0) + (b.winRate * 10) + (b.pf * 100) + (b.expectancy * 5);
        return scoreB - scoreA;
      });

      optimizerProgress = {
        status: "complete",
        current: combos.length,
        total: combos.length,
        label: "Complete",
        results: allResults,
      };
      optimizerRunning = false;

      try {
        const archive = loadScanArchive();
        const top10 = allResults.slice(0, 10);
        const worst5 = [...allResults].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
        archive.unshift({
          id: Date.now().toString(),
          savedAt: new Date().toISOString(),
          label: `Optimizer Scan ${from} to ${to} | ${tfList.join(",")} | R:R ${rrList.join(",")} | minConf ${minConf}`,
          summary: {
            totalCombos: combos.length,
            profitableCombos: allResults.filter(r => r.pnl > 0).length,
            totalResults: allResults.length,
            period: `${from} to ${to}`,
            timeframesUsed: tfList,
            symbolsScanned: symList.length,
            rrRatios: rrList,
            minConfluence: minConf,
          },
          top10,
          worst5,
          allResults: allResults.slice(0, 50),
        });
        if (archive.length > 20) archive.length = 20;
        saveScanArchive(archive);
        console.log(`[optimizer] Complete: ${allResults.length} combos with trades, top PnL: $${allResults[0]?.pnl || 0}`);
      } catch (err: any) {
        console.error("[optimizer] Failed to save:", err.message);
      }
    })();
  });

  app.get("/api/optimizer/status", (_req, res) => {
    const top20 = optimizerProgress.results.length > 0
      ? [...optimizerProgress.results].slice(0, 20)
      : [];
    const worst10 = optimizerProgress.results.length > 0
      ? [...optimizerProgress.results].sort((a, b) => a.pnl - b.pnl).slice(0, 10)
      : [];
    res.json({
      ...optimizerProgress,
      pct: optimizerProgress.total > 0 ? Math.round((optimizerProgress.current / optimizerProgress.total) * 100) : 0,
      top20,
      worst10,
      totalResults: optimizerProgress.results.length,
    });
  });

  return httpServer;
}
