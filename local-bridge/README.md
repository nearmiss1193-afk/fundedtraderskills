# Sovereign Skill Hub — Local Bridge Setup

## Architecture

```
Replit App (cloud)
    │ POST /api/trade-signal
    ▼
ngrok tunnel (https://jeanie-makable-deon.ngrok-free.dev)
    │
    ▼
Python Bridge (localhost:5000)
    │ TCP socket
    ▼
NinjaTrader 8 AddOn (localhost:7777)
    │ Places SIM order
    ▼
ACK flows back: NT → Bridge → Replit logs
```

## Quick Start

### 1. Python Bridge (your local PC)

```bash
cd local-bridge
pip install -r requirements.txt
python bridge.py
```

Bridge runs on `http://localhost:5000`.

### 2. ngrok Tunnel

```bash
ngrok http 5000 --url jeanie-makable-deon.ngrok-free.dev
```

### 3. NinjaTrader 8 AddOn

1. Open NinjaTrader 8
2. Go to **Tools → NinjaScript Editor**
3. Right-click **AddOns** → **New AddOn**
4. Name it `SovereignBridge`
5. Replace all content with `ninjatrader-addon/SovereignBridgeAddon.cs`
6. Press **F5** to compile
7. Open **Control Center → New → NinjaScript Output** to see logs
8. Make sure a **Sim101** account is connected

### 4. Test

Click the **Test Signal** button in the Replit app. You should see:

- **Replit logs**: `Signal sent to ngrok bridge successfully` + `Bridge ACK: status=accepted`
- **Python bridge**: `Forwarding to NinjaTrader` + `NT ACK: accepted`
- **NinjaTrader Output**: `Order submitted to SIM`

## Signal Flow

1. Replit generates signal with `signalId`
2. POST to `TRADE_BRIDGE_URL` (ngrok → Python bridge)
3. Bridge validates symbol (ES/MES only), direction (BUY/SELL only)
4. Bridge forwards via TCP to NinjaTrader on port 7777
5. NinjaTrader AddOn validates, places SIM order, returns ACK
6. Bridge returns ACK to Replit
7. Replit logs the ACK status and orderId

## Safety

- **SIM ONLY**: NinjaTrader AddOn rejects any non-Sim account
- **Symbol whitelist**: Only ES and MES accepted
- **Direction whitelist**: Only BUY and SELL accepted
- **Qty limit**: 1-10 contracts max
