"""
Sovereign Skill Hub — Local Python Bridge
==========================================
Receives trade signals from Replit (via ngrok), forwards to NinjaTrader 8
AddOn via TCP on port 7777, waits for ACK, and returns the result.

Run:  pip install flask && python bridge.py
ngrok: ngrok http 5000 --url jeanie-makable-deon.ngrok-free.dev
"""

import json
import socket
import uuid
import logging
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify

app = Flask(__name__)

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bridge")

NT_HOST = "127.0.0.1"
NT_PORT = 7777
NT_TIMEOUT = 3.0
ALLOWED_SYMBOLS = {"ES", "MES"}
ALLOWED_DIRECTIONS = {"BUY", "SELL"}
SIM_ACCOUNT = "Sim101"


def send_to_ninjatrader(order: dict) -> dict:
    signal_id = order.get("signalId", "unknown")
    log.info(f"[{signal_id}] Connecting to NinjaTrader at {NT_HOST}:{NT_PORT}")

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(NT_TIMEOUT)
        sock.connect((NT_HOST, NT_PORT))

        nt_payload = {**order, "accountName": SIM_ACCOUNT, "tif": "GTC"}
        line = json.dumps(nt_payload) + "\n"
        log.debug(f"[{signal_id}] Sending to NT: {line.strip()}")
        sock.sendall(line.encode("utf-8"))

        response_data = b""
        while True:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response_data += chunk
                if b"\n" in response_data:
                    break
            except socket.timeout:
                break

        sock.close()

        if not response_data.strip():
            log.warning(f"[{signal_id}] No ACK received from NinjaTrader (timeout)")
            return {
                "status": "rejected",
                "signalId": signal_id,
                "reason": "No ACK from NinjaTrader (timeout)",
            }

        ack_line = response_data.decode("utf-8").strip().split("\n")[0]
        log.info(f"[{signal_id}] NT ACK raw: {ack_line}")
        ack = json.loads(ack_line)
        return ack

    except ConnectionRefusedError:
        log.error(f"[{signal_id}] NinjaTrader not listening on port {NT_PORT}")
        return {
            "status": "rejected",
            "signalId": signal_id,
            "reason": f"NinjaTrader not listening on port {NT_PORT}",
        }
    except socket.timeout:
        log.error(f"[{signal_id}] NinjaTrader connection timed out")
        return {
            "status": "rejected",
            "signalId": signal_id,
            "reason": "No ACK from NinjaTrader (timeout)",
        }
    except Exception as e:
        log.error(f"[{signal_id}] NinjaTrader error: {e}")
        return {
            "status": "rejected",
            "signalId": signal_id,
            "reason": str(e),
        }


@app.route("/api/trade-signal", methods=["POST"])
def receive_signal():
    log.info("=" * 60)
    log.info("Incoming signal from Replit")
    log.debug(f"Headers: {dict(request.headers)}")

    raw = request.get_data(as_text=True)
    log.debug(f"Raw body: {raw}")

    try:
        data = request.get_json(force=True)
    except Exception as e:
        log.error(f"JSON parse error: {e}")
        return jsonify({"status": "rejected", "signalId": "unknown", "reason": "Invalid JSON"}), 400

    signal_id = data.get("signalId") or f"bridge-{uuid.uuid4().hex[:8]}"
    data["signalId"] = signal_id

    log.info(f"[{signal_id}] Parsed signal: {json.dumps(data, indent=2)}")

    symbol = data.get("symbol", "").upper()
    direction = data.get("direction", "").upper()

    if symbol not in ALLOWED_SYMBOLS:
        reason = f"Symbol '{symbol}' not allowed (must be ES or MES)"
        log.warning(f"[{signal_id}] REJECTED: {reason}")
        return jsonify({"status": "rejected", "signalId": signal_id, "reason": reason}), 400

    if direction not in ALLOWED_DIRECTIONS:
        reason = f"Direction '{direction}' not allowed (must be BUY or SELL)"
        log.warning(f"[{signal_id}] REJECTED: {reason}")
        return jsonify({"status": "rejected", "signalId": signal_id, "reason": reason}), 400

    for field in ["entryPrice", "stopLoss", "takeProfit"]:
        if field not in data or data[field] is None:
            reason = f"Missing required field: {field}"
            log.warning(f"[{signal_id}] REJECTED: {reason}")
            return jsonify({"status": "rejected", "signalId": signal_id, "reason": reason}), 400

    if "qty" not in data or not data["qty"]:
        data["qty"] = 1

    log.info(f"[{signal_id}] Validation passed — forwarding to NinjaTrader")
    ack = send_to_ninjatrader(data)

    log.info(f"[{signal_id}] Final ACK: {json.dumps(ack)}")
    status_code = 200 if ack.get("status") == "accepted" else 422
    return jsonify(ack), status_code


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "sovereign-skill-bridge"})


if __name__ == "__main__":
    log.info("=" * 60)
    log.info("Sovereign Skill Hub — Local Python Bridge")
    log.info(f"Listening on http://0.0.0.0:5000/api/trade-signal")
    log.info(f"NinjaTrader TCP target: {NT_HOST}:{NT_PORT}")
    log.info(f"Allowed symbols: {ALLOWED_SYMBOLS}")
    log.info(f"SIM account: {SIM_ACCOUNT}")
    log.info("=" * 60)
    app.run(host="0.0.0.0", port=5000, debug=True)
