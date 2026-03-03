import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — signal queue disabled");
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export interface SignalPayload {
  signalId: string;
  symbol: string;
  instrument?: string | null;
  direction: string;
  qty: number;
  orderType: string;
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  pattern: string | null;
  confluence: number | null;
  riskReward: string | null;
  accountHint?: string | null;
}

export async function enqueueSignal(signal: SignalPayload): Promise<{ status: string; signalId: string }> {
  const signalId = signal.signalId || `sig-${Date.now()}`;

  if (!supabase) {
    console.log(`[supabase] Client not initialized — signal ${signalId} not queued`);
    return { status: "skipped", signalId };
  }

  const payload = {
    signal_id: signalId,
    status: "NEW",
    symbol: signal.symbol,
    instrument: signal.instrument ?? null,
    direction: signal.direction,
    qty: signal.qty ?? 1,
    order_type: signal.orderType ?? "MARKET",
    entry_price: signal.entryPrice ?? null,
    stop_loss: signal.stopLoss,
    take_profit: signal.takeProfit,
    pattern: signal.pattern ?? null,
    confluence: signal.confluence != null ? Math.round(signal.confluence) : null,
    risk_reward: signal.riskReward ? parseFloat(signal.riskReward.replace(/^1:/, "")) || null : null,
    account_hint: signal.accountHint ?? null,
    source: "replit",
    client_tag: "v1",
  };

  const { error } = await supabase.from("trade_signals").insert([payload]);
  if (error) {
    console.error(`[supabase] Insert error for ${signalId}: ${error.message}`);
    throw error;
  }

  console.log(`[supabase] Signal queued: ${signalId} | ${signal.direction} ${signal.symbol} qty=${signal.qty}`);
  return { status: "queued", signalId };
}

export async function getTradeAck(signalId: string): Promise<{ status: string; signalId: string; orderId?: string; message?: string; reason?: string } | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("trade_acks")
    .select("*")
    .eq("signal_id", signalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[supabase] ACK query error for ${signalId}: ${error.message}`);
    return null;
  }

  if (!data) return null;

  return {
    status: data.status,
    signalId: data.signal_id,
    orderId: data.order_id || undefined,
    message: data.message || undefined,
    reason: data.reason || undefined,
  };
}
