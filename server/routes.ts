import type { Express } from "express";
import { type Server } from "http";
import path from "path";
import express from "express";
import { startTrader, stopTrader, getTraderLogs, getTraderStatus, isTradingOpen, isForceTradeActive, getTradovateStatus, connectTradovate, forwardSignalToSupabase } from "./trader";
import { getTradeAck } from "./supabase";
import { loadJournal, getJournalStats, getAdvancedAnalytics, updateJournalNotes, deleteJournalEntry, clearJournal, loadSettings, saveSettings } from "./journal";
import { sendToCrossTrade } from "./services/crosstrade";
import { runBacktest } from "./backtest";

let skills: any[] = [];

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
  app.get("/", (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), "public", "index.html"));
  });

  app.use("/public", express.static(path.resolve(process.cwd(), "public")));

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

  app.post("/api/tradovate/connect", async (_req, res) => {
    const result = await connectTradovate();
    res.json(result);
  });

  app.get("/api/tradovate/status", (_req, res) => {
    res.json(getTradovateStatus());
  });

  app.post("/api/trader/start", (req, res) => {
    const { markets, timeframes, riskDollars, rewardRatio, maxOpenTrades, account, patterns, customCondition, forceTrading } = req.body;
    if (!markets?.length || !timeframes?.length || !patterns?.length) {
      return res.status(400).json({ error: "markets, timeframes, and patterns are required." });
    }
    const sessionId = startTrader({ markets, timeframes, riskDollars: riskDollars || 100, rewardRatio: rewardRatio || 2, maxOpenTrades: maxOpenTrades || 3, account: account || "SIM101", patterns, customCondition: customCondition || "", forceTrading: !!forceTrading });
    res.json({ success: true, sessionId });
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
    res.json({ success: true, settings: saved });
  });

  app.post("/api/backtest/pattern", async (req, res) => {
    const { symbol, pattern, from, to, rrRatio, maxHold } = req.body;

    const validPatterns = ["3bar", "buysetup", "breakout", "climax", "all"];
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
      const result = await runBacktest({ symbol, pattern, from, to, rrRatio, maxHold });
      if (result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[backtest] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Backtest failed" });
    }
  });

  return httpServer;
}
