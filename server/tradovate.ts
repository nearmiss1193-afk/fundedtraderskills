import https from "https";
import http from "http";

const DEMO_BASE = "https://demo.tradovateapi.com/v1";
const LIVE_BASE = "https://live.tradovateapi.com/v1";

interface TradovateConfig {
  username: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: number;
  sec: string;
  deviceId?: string;
}

interface TradovateSession {
  accessToken: string;
  expirationTime: string;
  userId: number;
  accountId: number;
  accountName: string;
  connected: boolean;
  lastError: string | null;
}

interface OrderResult {
  orderId: number | null;
  success: boolean;
  error: string | null;
  fillPrice: number | null;
}

interface BracketResult {
  entryOrderId: number | null;
  slOrderId: number | null;
  tpOrderId: number | null;
  success: boolean;
  error: string | null;
}

let session: TradovateSession | null = null;
let config: TradovateConfig | null = null;
let renewalTimer: ReturnType<typeof setInterval> | null = null;

function getConfig(): TradovateConfig | null {
  const username = process.env.TRADOVATE_USERNAME;
  const password = process.env.TRADOVATE_PASSWORD;
  const appId = process.env.TRADOVATE_APP_ID;
  const appVersion = process.env.TRADOVATE_APP_VERSION || "1.0";
  const cid = process.env.TRADOVATE_CID;
  const sec = process.env.TRADOVATE_SECRET;
  const deviceId = process.env.TRADOVATE_DEVICE_ID || "sovereign-skill-hub";

  if (!username || !password || !appId || !cid || !sec) {
    return null;
  }

  return { username, password, appId, appVersion, cid: parseInt(cid, 10), sec, deviceId };
}

function apiRequest(method: string, path: string, body?: any, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(DEMO_BASE + path);
    const isHttps = url.protocol === "https:";
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    };

    if (token) {
      options.headers!["Authorization"] = `Bearer ${token}`;
    }

    const req = (isHttps ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export async function connectTradovate(): Promise<{ connected: boolean; message: string }> {
  config = getConfig();

  if (!config) {
    console.log("[tradovate] Missing credentials — running in simulation-only mode");
    return { connected: false, message: "Missing Tradovate credentials. Set TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_APP_ID, TRADOVATE_CID, TRADOVATE_SECRET in environment." };
  }

  try {
    console.log("[tradovate] Authenticating with demo account...");
    const authResult = await apiRequest("POST", "/auth/accesstokenrequest", {
      name: config.username,
      password: config.password,
      appId: config.appId,
      appVersion: config.appVersion,
      cid: config.cid,
      sec: config.sec,
      deviceId: config.deviceId,
    });

    if (!authResult.accessToken) {
      const errMsg = authResult["p-ticket"] ? "MFA required — check Tradovate app for approval" : JSON.stringify(authResult);
      session = { accessToken: "", expirationTime: "", userId: 0, accountId: 0, accountName: "", connected: false, lastError: errMsg };
      console.log(`[tradovate] Auth failed: ${errMsg}`);
      return { connected: false, message: `Auth failed: ${errMsg}` };
    }

    const accounts = await apiRequest("GET", "/account/list", undefined, authResult.accessToken);
    const demoAccount = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;

    if (!demoAccount) {
      session = { accessToken: authResult.accessToken, expirationTime: authResult.expirationTime, userId: authResult.userId, accountId: 0, accountName: "", connected: false, lastError: "No accounts found" };
      console.log("[tradovate] Auth succeeded but no accounts found");
      return { connected: false, message: "Authenticated but no trading accounts found" };
    }

    session = {
      accessToken: authResult.accessToken,
      expirationTime: authResult.expirationTime,
      userId: authResult.userId,
      accountId: demoAccount.id,
      accountName: demoAccount.name || `Account ${demoAccount.id}`,
      connected: true,
      lastError: null,
    };

    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = setInterval(async () => {
      const ok = await renewToken();
      if (!ok && session) {
        session.connected = false;
        session.lastError = "Token renewal failed — reconnect needed";
      }
    }, 45 * 60 * 1000);

    console.log(`[tradovate] Connected to Tradovate paper account: ${session.accountName} (ID: ${session.accountId})`);
    return { connected: true, message: `Connected to Tradovate paper account: ${session.accountName}` };
  } catch (err: any) {
    const errMsg = err.message || String(err);
    session = { accessToken: "", expirationTime: "", userId: 0, accountId: 0, accountName: "", connected: false, lastError: errMsg };
    console.log(`[tradovate] Connection failed: ${errMsg}`);
    return { connected: false, message: `Connection failed: ${errMsg}` };
  }
}

export function isTradovateConnected(): boolean {
  return session?.connected === true;
}

export function getTradovateStatus(): { connected: boolean; accountName: string; lastError: string | null } {
  if (!session) return { connected: false, accountName: "", lastError: "Not initialized" };
  return { connected: session.connected, accountName: session.accountName, lastError: session.lastError };
}

const TRADOVATE_SYMBOL_MAP: Record<string, string> = {
  ES: "ESH5", MES: "MESH5", NQ: "NQH5", MNQ: "MNQH5",
  YM: "YMH5", MYM: "MYMH5", RTY: "RTYH5", M2K: "M2KH5",
  CL: "CLJ5", MCL: "MCLJ5", GC: "GCJ5", MGC: "MGCJ5",
  SI: "SIH5", HG: "HGH5", PL: "PLJ5", PA: "PAH5",
  BTC: "BTCH5", ETH: "ETHH5",
  ZB: "ZBH5", ZN: "ZNH5", ZT: "ZTH5", ZF: "ZFH5",
  ZC: "ZCH5", ZS: "ZSH5", ZW: "ZWH5",
};

function getTradovateSymbol(symbol: string): string {
  return TRADOVATE_SYMBOL_MAP[symbol] || symbol;
}

async function findContractId(symbol: string): Promise<number | null> {
  if (!session?.connected) return null;
  try {
    const tvSymbol = getTradovateSymbol(symbol);
    const result = await apiRequest("GET", `/contract/find?name=${encodeURIComponent(tvSymbol)}`, undefined, session.accessToken);
    return result?.id || null;
  } catch (err: any) {
    console.log(`[tradovate] Contract lookup failed for ${symbol}: ${err.message}`);
    return null;
  }
}

export async function placeMarketOrder(
  symbol: string,
  direction: "LONG" | "SHORT",
  qty: number = 1
): Promise<OrderResult> {
  if (!session?.connected) {
    return { orderId: null, success: false, error: "Not connected to Tradovate", fillPrice: null };
  }

  try {
    const contractId = await findContractId(symbol);
    if (!contractId) {
      return { orderId: null, success: false, error: `Contract not found: ${symbol}`, fillPrice: null };
    }

    const action = direction === "LONG" ? "Buy" : "Sell";
    const orderResult = await apiRequest("POST", "/order/placeorder", {
      accountSpec: session.accountName,
      accountId: session.accountId,
      action,
      symbol: getTradovateSymbol(symbol),
      orderQty: qty,
      orderType: "Market",
      isAutomated: true,
    }, session.accessToken);

    const orderId = orderResult?.orderId || orderResult?.id || null;
    console.log(`[tradovate] Market order placed: ${action} ${qty} ${symbol} — Order ID: ${orderId}`);

    return { orderId, success: true, error: null, fillPrice: null };
  } catch (err: any) {
    console.log(`[tradovate] Order failed: ${err.message}`);
    return { orderId: null, success: false, error: err.message, fillPrice: null };
  }
}

export async function placeBracketOrder(
  symbol: string,
  direction: "LONG" | "SHORT",
  entry: number,
  stop: number,
  target: number,
  qty: number = 1
): Promise<BracketResult> {
  if (!session?.connected) {
    return { entryOrderId: null, slOrderId: null, tpOrderId: null, success: false, error: "Not connected to Tradovate" };
  }

  try {
    const contractId = await findContractId(symbol);
    if (!contractId) {
      return { entryOrderId: null, slOrderId: null, tpOrderId: null, success: false, error: `Contract not found: ${symbol}` };
    }

    const action = direction === "LONG" ? "Buy" : "Sell";
    const exitAction = direction === "LONG" ? "Sell" : "Buy";

    const bracketResult = await apiRequest("POST", "/order/placeOSO", {
      accountSpec: session.accountName,
      accountId: session.accountId,
      action,
      symbol: getTradovateSymbol(symbol),
      orderQty: qty,
      orderType: "Market",
      isAutomated: true,
      bracket1: {
        action: exitAction,
        orderType: "Stop",
        price: stop,
        contractId,
      },
      bracket2: {
        action: exitAction,
        orderType: "Limit",
        price: target,
        contractId,
      },
    }, session.accessToken);

    const entryOrderId = bracketResult?.orderId || bracketResult?.id || null;
    console.log(`[tradovate] Bracket order placed: ${action} ${qty} ${symbol} — Entry: ${entry}, SL: ${stop}, TP: ${target} — Order ID: ${entryOrderId}`);

    return {
      entryOrderId,
      slOrderId: bracketResult?.oso1Id || null,
      tpOrderId: bracketResult?.oso2Id || null,
      success: true,
      error: null,
    };
  } catch (err: any) {
    console.log(`[tradovate] Bracket order failed: ${err.message}`);
    return { entryOrderId: null, slOrderId: null, tpOrderId: null, success: false, error: err.message };
  }
}

export async function cancelOrder(orderId: number): Promise<boolean> {
  if (!session?.connected) return false;
  try {
    await apiRequest("POST", "/order/cancelorder", { orderId }, session.accessToken);
    console.log(`[tradovate] Order ${orderId} cancelled`);
    return true;
  } catch (err: any) {
    console.log(`[tradovate] Cancel failed for order ${orderId}: ${err.message}`);
    return false;
  }
}

export async function getPositions(): Promise<any[]> {
  if (!session?.connected) return [];
  try {
    const positions = await apiRequest("GET", "/position/list", undefined, session.accessToken);
    return Array.isArray(positions) ? positions : [];
  } catch (err: any) {
    console.log(`[tradovate] Failed to get positions: ${err.message}`);
    return [];
  }
}

export async function closePosition(contractId: number): Promise<boolean> {
  if (!session?.connected) return false;
  try {
    await apiRequest("POST", "/order/liquidateposition", {
      accountId: session.accountId,
      contractId,
    }, session.accessToken);
    console.log(`[tradovate] Position liquidated for contract ${contractId}`);
    return true;
  } catch (err: any) {
    console.log(`[tradovate] Liquidate failed: ${err.message}`);
    return false;
  }
}

export async function getAccountBalance(): Promise<{ balance: number; realizedPnl: number; unrealizedPnl: number } | null> {
  if (!session?.connected) return null;
  try {
    const cashBalances = await apiRequest("GET", `/cashBalance/getCashBalanceSnapshot?accountId=${session.accountId}`, undefined, session.accessToken);
    return {
      balance: cashBalances?.totalCashValue || 0,
      realizedPnl: cashBalances?.realizedPnl || 0,
      unrealizedPnl: cashBalances?.unrealizedPnl || 0,
    };
  } catch (err: any) {
    console.log(`[tradovate] Balance fetch failed: ${err.message}`);
    return null;
  }
}

export async function renewToken(): Promise<boolean> {
  if (!session?.accessToken) return false;
  try {
    const result = await apiRequest("POST", "/auth/renewaccesstoken", undefined, session.accessToken);
    if (result?.accessToken) {
      session.accessToken = result.accessToken;
      session.expirationTime = result.expirationTime;
      console.log("[tradovate] Token renewed");
      return true;
    }
    return false;
  } catch (err: any) {
    console.log(`[tradovate] Token renewal failed: ${err.message}`);
    return false;
  }
}
