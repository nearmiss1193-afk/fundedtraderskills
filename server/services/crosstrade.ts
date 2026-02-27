import https from "https";

const CROSSTRADE_WEBHOOK_URL = process.env.CROSSTRADE_WEBHOOK_URL || "";
const CROSSTRADE_KEY = process.env.CROSSTRADE_KEY || "";
const CROSSTRADE_ACCOUNT_DEFAULT = process.env.CROSSTRADE_ACCOUNT || "SIM101";
const MAX_CONTRACTS = parseInt(process.env.MAX_CONTRACTS || "1", 10);
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || "3", 10);

let dailyTradeCount = 0;
let lastTradeDate = new Date().toDateString();

interface CrossTradeSignal {
    symbol: string;
    direction: "LONG" | "SHORT" | "Long" | "Short" | "BUY" | "SELL";
    qty?: number;
    orderType?: string;
    account?: string;
}

export async function sendToCrossTrade(signal: CrossTradeSignal): Promise<{ success: boolean; message: string; payload?: string }> {
    const today = new Date().toDateString();
    if (today !== lastTradeDate) {
        dailyTradeCount = 0;
        lastTradeDate = today;
    }

    const targetAccount = signal.account || CROSSTRADE_ACCOUNT_DEFAULT;

    if (dailyTradeCount >= MAX_TRADES_PER_DAY) {
        const error = `Safety Block: Daily trade limit (${MAX_TRADES_PER_DAY}) reached.`;
        console.error(`[crosstrade] ${error}`);
        return { success: false, message: error };
    }

    if (!CROSSTRADE_WEBHOOK_URL || !CROSSTRADE_KEY) {
        const error = "Missing CROSSTRADE_WEBHOOK_URL or CROSSTRADE_KEY in environment.";
        console.error(`[crosstrade] ${error}`);
        return { success: false, message: error };
    }

    const dir = signal.direction.toUpperCase();
    const action = (dir === "LONG" || dir === "BUY") ? "BUY" : "SELL";
    const qty = Math.min(signal.qty || 1, MAX_CONTRACTS);

    const payload = `key=${CROSSTRADE_KEY}; command=PLACE; account=${targetAccount}; instrument=${signal.symbol}; action=${action}; qty=${qty}; order_type=${signal.orderType || "MARKET"}; tif=DAY;`;

    console.log(`[crosstrade] Sending payload to account ${targetAccount}: ${payload.replace(CROSSTRADE_KEY, "****")}`);

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
                    dailyTradeCount++;
                    console.log(`[crosstrade] Order successful. Resp: ${data}`);
                    resolve({ success: true, message: `Order sent: ${data}`, payload });
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
