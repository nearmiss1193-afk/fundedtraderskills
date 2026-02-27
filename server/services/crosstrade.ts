import { createHmac } from "crypto";

interface CrossTradePayload {
  symbol: string;
  direction: string;
  orderType: string;
  quantity: number;
  account: string;
  timestamp: string;
}

export async function sendToCrossTrade(params: {
  symbol: string;
  direction: string;
  orderType: string;
  account?: string;
}) {
  const WEBHOOK_URL = process.env.CROSSTRADE_WEBHOOK_URL;
  const CROSSTRADE_KEY = process.env.CROSSTRADE_KEY;
  const DEFAULT_ACCOUNT = process.env.CROSSTRADE_ACCOUNT || "SIM101";

  if (!WEBHOOK_URL || !CROSSTRADE_KEY) {
    console.error("[crosstrade] Missing WEBHOOK_URL or KEY");
    return { success: false, message: "CrossTrade configuration missing" };
  }

  const targetAccount = params.account || DEFAULT_ACCOUNT;

  if (!targetAccount.toUpperCase().startsWith("SIM") && process.env.ALLOW_LIVE_TRADES !== "true") {
    return { 
      success: false, 
      message: `Safety Block: Account '${targetAccount}' is NOT a SIM account. Add 'ALLOW_LIVE_TRADES=true' to Secrets to override.` 
    };
  }

  const payload = {
    symbol: params.symbol,
    action: params.direction.toUpperCase(),
    orderType: params.orderType,
    quantity: parseInt(process.env.MAX_CONTRACTS || "1"),
    account: targetAccount
  };

  const textPayload = `${payload.symbol} ${payload.action} ${payload.quantity} ${payload.orderType} ${payload.account}`;

  console.log(`[crosstrade] Sending to CrossTrade [${targetAccount}]: ${textPayload}`);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-crosstrade-key': CROSSTRADE_KEY
      },
      body: textPayload
    });

    if (response.ok) {
      return { success: true, message: `Order sent to ${targetAccount}` };
    } else {
      const err = await response.text();
      return { success: false, message: `CrossTrade Error: ${err}` };
    }
  } catch (error) {
    return { success: false, message: `Network Error: ${error}` };
  }
}
