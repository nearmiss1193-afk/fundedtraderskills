import type { Express } from "express";
import { type Server } from "http";
import path from "path";
import express from "express";

let skills: any[] = [];

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

  return httpServer;
}
