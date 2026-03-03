import https from "https";

const CROSSTRADE_WEBHOOK_URL = process.env.CROSSTRADE_WEBHOOK_URL || "";
const CROSSTRADE_KEY = process.env.CROSSTRADE_KEY || "";
const CROSSTRADE_ACCOUNT_DEFAULT = process.env.CROSSTRADE_ACCOUNT || "SIM101";
const MAX_CONTRACTS = parseInt(process.env.MAX_CONTRACTS || "1", 10);
let dailyTradeCount = 0;

const POLYGON_TO_NT: Record<string, string> = { "BTC": "MBT", "ETH": "MET" };

const CONTRACT_CYCLES: Record<string, number[]> = {
    "ES":  [3, 6, 9, 12], "MES": [3, 6, 9, 12],
    "NQ":  [3, 6, 9, 12], "MNQ": [3, 6, 9, 12],
    "YM":  [3, 6, 9, 12], "MYM": [3, 6, 9, 12],
    "RTY": [3, 6, 9, 12], "M2K": [3, 6, 9, 12],
    "CL":  [1,2,3,4,5,6,7,8,9,10,11,12], "MCL": [1,2,3,4,5,6,7,8,9,10,11,12],
    "ZC":  [3, 5, 7, 9, 12], "ZS": [1, 3, 5, 7, 8, 9, 11],
    "ZW":  [3, 5, 7, 9, 12],
    "MBT": [1,2,3,4,5,6,7,8,9,10,11,12], "MET": [1,2,3,4,5,6,7,8,9,10,11,12],
};

function getNinjaTraderInstrument(symbol: string): string {
    if (symbol.includes(" ")) {
        return symbol;
    }

    const ntSymbol = POLYGON_TO_NT[symbol] || symbol;

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const cycle = CONTRACT_CYCLES[ntSymbol];
    if (!cycle) return `${ntSymbol} ${String(currentMonth).padStart(2, "0")}-${String(currentYear).slice(-2)}`;

    let contractMonth = cycle.find(m => m >= currentMonth);
    let contractYear = currentYear;
    if (!contractMonth) {
        contractMonth = cycle[0];
        contractYear = currentYear + 1;
    }

    const mm = String(contractMonth).padStart(2, "0");
    const yy = String(contractYear).slice(-2);
    return `${ntSymbol} ${mm}-${yy}`;
}

interface CrossTradeSignal {
    symbol: string;
    direction: "LONG" | "SHORT" | "Long" | "Short" | "BUY" | "SELL";
    qty?: number;
    orderType?: string;
    account?: string;
}

export async function sendCloseAll(account?: string): Promise<{ success: boolean; message: string; payload?: string }> {
    const targetAccount = account || CROSSTRADE_ACCOUNT_DEFAULT;

    if (!CROSSTRADE_WEBHOOK_URL || !CROSSTRADE_KEY) {
        return { success: false, message: "Missing CROSSTRADE_WEBHOOK_URL or CROSSTRADE_KEY in environment." };
    }

    const payload = `key=${CROSSTRADE_KEY};command=FLATTENEVERYTHING;`;
    console.log(`[crosstrade] Sending FLATTENEVERYTHING (all accounts)`);

    return new Promise((resolve) => {
        const req = https.request(CROSSTRADE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(payload) }
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    console.log(`[crosstrade] FLATTENEVERYTHING successful. Resp: ${data}`);
                    resolve({ success: true, message: `Close all sent: ${data}`, payload });
                } else {
                    console.error(`[crosstrade] FLATTENEVERYTHING error ${res.statusCode}: ${data}`);
                    resolve({ success: false, message: `HTTP ${res.statusCode}: ${data}`, payload });
                }
            });
        });
        req.on("error", (err) => {
            console.error(`[crosstrade] FLATTENEVERYTHING network error: ${err.message}`);
            resolve({ success: false, message: `Network error: ${err.message}`, payload });
        });
        req.write(payload);
        req.end();
    });
}

export async function sendClosePosition(instrument: string, account?: string): Promise<{ success: boolean; message: string; payload?: string }> {
    const targetAccount = account || CROSSTRADE_ACCOUNT_DEFAULT;

    if (!CROSSTRADE_WEBHOOK_URL || !CROSSTRADE_KEY) {
        return { success: false, message: "Missing CROSSTRADE_WEBHOOK_URL or CROSSTRADE_KEY in environment." };
    }

    const payload = `key=${CROSSTRADE_KEY};command=CLOSEPOSITION;account=${targetAccount};instrument=${instrument};`;
    console.log(`[crosstrade] Sending CLOSEPOSITION for ${instrument} on account ${targetAccount}`);

    return new Promise((resolve) => {
        const req = https.request(CROSSTRADE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(payload) }
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    console.log(`[crosstrade] CLOSEPOSITION ${instrument} successful. Resp: ${data}`);
                    resolve({ success: true, message: `Close position sent: ${data}`, payload });
                } else {
                    console.error(`[crosstrade] CLOSEPOSITION ${instrument} error ${res.statusCode}: ${data}`);
                    resolve({ success: false, message: `HTTP ${res.statusCode}: ${data}`, payload });
                }
            });
        });
        req.on("error", (err) => {
            console.error(`[crosstrade] CLOSEPOSITION ${instrument} network error: ${err.message}`);
            resolve({ success: false, message: `Network error: ${err.message}`, payload });
        });
        req.write(payload);
        req.end();
    });
}

export async function sendToCrossTrade(signal: CrossTradeSignal): Promise<{ success: boolean; message: string; payload?: string }> {
    const targetAccount = signal.account || CROSSTRADE_ACCOUNT_DEFAULT;

    if (!CROSSTRADE_WEBHOOK_URL || !CROSSTRADE_KEY) {
        const error = "Missing CROSSTRADE_WEBHOOK_URL or CROSSTRADE_KEY in environment.";
        console.error(`[crosstrade] ${error}`);
        return { success: false, message: error };
    }

    const dir = signal.direction.toUpperCase();
    const action = (dir === "LONG" || dir === "BUY") ? "BUY" : "SELL";
    const qty = Math.min(signal.qty || 1, MAX_CONTRACTS);

    const ntInstrument = getNinjaTraderInstrument(signal.symbol);
    const payload = `key=${CROSSTRADE_KEY};command=PLACE;account=${targetAccount};instrument=${ntInstrument};action=${action};qty=${qty};order_type=${signal.orderType || "MARKET"};tif=DAY;`;

    console.log(`[crosstrade] Sending payload to account ${targetAccount} (${signal.symbol} → ${ntInstrument}): ${payload.replace(CROSSTRADE_KEY, "****")}`);

    return new Promise((resolve) => {
        const req = https.request(CROSSTRADE_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "Content-Length": Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    let hasError = false;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            hasError = true;
                            console.error(`[crosstrade] Order REJECTED by NinjaTrader: ${parsed.error}`);
                            resolve({ success: false, message: `Rejected: ${parsed.error}`, payload });
                            return;
                        }
                    } catch (_) {}
                    if (!hasError) {
                        dailyTradeCount++;
                        console.log(`[crosstrade] Order successful. Resp: ${data}`);
                        resolve({ success: true, message: `Order sent: ${data}`, payload });
                    }
                } else {
                    console.error(`[crosstrade] Error ${res.statusCode}: ${data}`);
                    resolve({ success: false, message: `HTTP ${res.statusCode}: ${data}`, payload });
                }
            });
        });

        req.on("error", (err) => {
            console.error(`[crosstrade] Network error: ${err.message}`);
            resolve({ success: false, message: `Network error: ${err.message}`, payload });
        });

        req.write(payload);
        req.end();
    });
}
