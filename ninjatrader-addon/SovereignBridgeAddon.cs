/*
 * Sovereign Skill Hub — NinjaTrader 8 AddOn
 * ==========================================
 * TCP listener on port 7777 that receives JSON trade signals,
 * places SIM orders, and returns ACK responses.
 *
 * Installation:
 *   1. In NinjaTrader 8: Tools → NinjaScript Editor → right-click AddOns → New AddOn
 *   2. Name it "SovereignBridge"
 *   3. Replace all content with this file
 *   4. Press F5 to compile
 *   5. Go to Control Center → New → NinjaScript Output to see logs
 *   6. The addon auto-starts when NinjaTrader loads
 *
 * Safety:  SIM ONLY — rejects any non-Sim account
 * Symbols: ES and MES only
 */

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class SovereignBridge : AddOnBase
    {
        private TcpListener _listener;
        private CancellationTokenSource _cts;
        private const int PORT = 7777;
        private static readonly HashSet<string> AllowedSymbols = new HashSet<string> { "ES", "MES" };
        private static readonly HashSet<string> AllowedDirections = new HashSet<string> { "BUY", "SELL" };
        private Account _simAccount;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description = "Sovereign Skill Hub Bridge — receives trade signals via TCP and places SIM orders";
                Name = "SovereignBridge";
            }
            else if (State == State.Active)
            {
                _cts = new CancellationTokenSource();
                Task.Run(() => StartListener(_cts.Token));
                Log("SovereignBridge AddOn ACTIVE — TCP listener starting on port " + PORT, LogLevel.Information);
            }
            else if (State == State.Terminated)
            {
                StopListener();
                Log("SovereignBridge AddOn TERMINATED", LogLevel.Information);
            }
        }

        private void StartListener(CancellationToken ct)
        {
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, PORT);
                _listener.Start();
                Log($"TCP listener started on 127.0.0.1:{PORT}", LogLevel.Information);

                while (!ct.IsCancellationRequested)
                {
                    if (_listener.Pending())
                    {
                        var client = _listener.AcceptTcpClient();
                        Task.Run(() => HandleClient(client), ct);
                    }
                    else
                    {
                        Thread.Sleep(50);
                    }
                }
            }
            catch (Exception ex)
            {
                if (!ct.IsCancellationRequested)
                    Log($"Listener error: {ex.Message}", LogLevel.Error);
            }
        }

        private void StopListener()
        {
            _cts?.Cancel();
            try { _listener?.Stop(); } catch { }
        }

        private void HandleClient(TcpClient client)
        {
            string signalId = "unknown";
            try
            {
                using (client)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                using (var writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true })
                {
                    client.ReceiveTimeout = 5000;
                    string line = reader.ReadLine();
                    if (string.IsNullOrWhiteSpace(line))
                    {
                        Log("Empty request received", LogLevel.Warning);
                        return;
                    }

                    Log($"Received: {line}", LogLevel.Information);

                    JObject order;
                    try { order = JObject.Parse(line); }
                    catch (Exception ex)
                    {
                        var errAck = new JObject
                        {
                            ["status"] = "rejected",
                            ["signalId"] = signalId,
                            ["reason"] = $"Invalid JSON: {ex.Message}"
                        };
                        writer.WriteLine(errAck.ToString(Formatting.None));
                        return;
                    }

                    signalId = order.Value<string>("signalId") ?? "unknown";
                    string symbol = (order.Value<string>("symbol") ?? "").ToUpper();
                    string direction = (order.Value<string>("direction") ?? "").ToUpper();
                    string accountName = order.Value<string>("accountName") ?? "Sim101";
                    int qty = order.Value<int?>("qty") ?? 1;
                    double stopLoss = order.Value<double?>("stopLoss") ?? 0;
                    double takeProfit = order.Value<double?>("takeProfit") ?? 0;
                    string pattern = order.Value<string>("pattern") ?? "";

                    Log($"[{signalId}] Processing: {direction} {symbol} qty={qty} SL={stopLoss} TP={takeProfit} pattern={pattern}", LogLevel.Information);

                    if (!accountName.StartsWith("Sim", StringComparison.OrdinalIgnoreCase))
                    {
                        SendReject(writer, signalId, "SAFETY: Only SIM accounts allowed. Got: " + accountName);
                        return;
                    }

                    if (!AllowedSymbols.Contains(symbol))
                    {
                        SendReject(writer, signalId, $"Symbol '{symbol}' not allowed. Must be ES or MES.");
                        return;
                    }

                    if (!AllowedDirections.Contains(direction))
                    {
                        SendReject(writer, signalId, $"Direction '{direction}' not allowed. Must be BUY or SELL.");
                        return;
                    }

                    if (qty <= 0 || qty > 10)
                    {
                        SendReject(writer, signalId, $"Qty {qty} out of range (1-10).");
                        return;
                    }

                    _simAccount = null;
                    lock (Account.All)
                    {
                        _simAccount = Account.All.FirstOrDefault(a =>
                            a.Name.Equals(accountName, StringComparison.OrdinalIgnoreCase));
                    }

                    if (_simAccount == null)
                    {
                        SendReject(writer, signalId, $"Account '{accountName}' not found in NinjaTrader.");
                        return;
                    }

                    if (_simAccount.ConnectionStatus != ConnectionStatus.Connected)
                    {
                        SendReject(writer, signalId, $"Account '{accountName}' not connected.");
                        return;
                    }

                    var instrument = Instrument.GetInstrument(symbol);
                    if (instrument == null)
                    {
                        SendReject(writer, signalId, $"Instrument '{symbol}' not found.");
                        return;
                    }

                    var orderAction = direction == "BUY" ? OrderAction.Buy : OrderAction.Sell;

                    try
                    {
                        var entryOrder = _simAccount.CreateOrder(
                            instrument,
                            orderAction,
                            OrderType.Market,
                            TimeInForce.Gtc,
                            qty,
                            0,
                            0,
                            string.Empty,
                            "SovereignEntry_" + signalId,
                            null
                        );

                        _simAccount.Submit(new[] { entryOrder });
                        string orderId = entryOrder.OrderId ?? ("NT-" + signalId);

                        Log($"[{signalId}] Order submitted: {direction} {qty} {symbol} orderId={orderId}", LogLevel.Information);

                        if (stopLoss > 0)
                        {
                            var slAction = direction == "BUY" ? OrderAction.Sell : OrderAction.Buy;
                            var slOrder = _simAccount.CreateOrder(
                                instrument,
                                slAction,
                                OrderType.StopMarket,
                                TimeInForce.Gtc,
                                qty,
                                0,
                                stopLoss,
                                string.Empty,
                                "SovereignSL_" + signalId,
                                null
                            );
                            _simAccount.Submit(new[] { slOrder });
                            Log($"[{signalId}] Stop loss set at {stopLoss}", LogLevel.Information);
                        }

                        if (takeProfit > 0)
                        {
                            var tpAction = direction == "BUY" ? OrderAction.Sell : OrderAction.Buy;
                            var tpOrder = _simAccount.CreateOrder(
                                instrument,
                                tpAction,
                                OrderType.Limit,
                                TimeInForce.Gtc,
                                qty,
                                takeProfit,
                                0,
                                string.Empty,
                                "SovereignTP_" + signalId,
                                null
                            );
                            _simAccount.Submit(new[] { tpOrder });
                            Log($"[{signalId}] Take profit set at {takeProfit}", LogLevel.Information);
                        }

                        var ack = new JObject
                        {
                            ["status"] = "accepted",
                            ["signalId"] = signalId,
                            ["orderId"] = orderId,
                            ["message"] = $"Order submitted to SIM ({accountName}): {direction} {qty} {symbol}"
                        };
                        writer.WriteLine(ack.ToString(Formatting.None));
                        Log($"[{signalId}] ACK sent: accepted orderId={orderId}", LogLevel.Information);
                    }
                    catch (Exception ex)
                    {
                        Log($"[{signalId}] Order error: {ex.Message}", LogLevel.Error);
                        SendReject(writer, signalId, $"Order error: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"[{signalId}] Client handler error: {ex.Message}", LogLevel.Error);
            }
        }

        private void SendReject(StreamWriter writer, string signalId, string reason)
        {
            Log($"[{signalId}] REJECTED: {reason}", LogLevel.Warning);
            var ack = new JObject
            {
                ["status"] = "rejected",
                ["signalId"] = signalId,
                ["reason"] = reason
            };
            writer.WriteLine(ack.ToString(Formatting.None));
        }

        private void Log(string msg, LogLevel level)
        {
            NinjaTrader.Code.Output.Process($"[SovereignBridge] {msg}", PrintTo.OutputTab1);
        }
    }
}
