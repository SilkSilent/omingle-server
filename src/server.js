import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const WS_PATH = process.env.WS_PATH || "/ws";

const app = express();
app.get("/", (_req, res) => res.status(200).send("OMINGLE match server OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: WS_PATH });

/**
 * Simple Omegle-like pairing:
 * - waiting: holds one socket waiting for a partner
 * - peerMap: maps socket -> partner socket
 */
let waiting = null;
const peerMap = new Map();

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function setPair(a, b) {
  peerMap.set(a, b);
  peerMap.set(b, a);

  // optional event (client can show "matched")
  safeSend(a, { type: "matched" });
  safeSend(b, { type: "matched" });
}

function getPeer(ws) {
  return peerMap.get(ws) || null;
}

function clearPair(ws, reason = "partner_left") {
  const peer = getPeer(ws);
  if (peer) {
    peerMap.delete(peer);
    safeSend(peer, { type: "reset", reason });
  }
  peerMap.delete(ws);
}

function tryPutInWaiting(ws) {
  // if someone is waiting, pair immediately
  if (waiting && waiting !== ws && waiting.readyState === waiting.OPEN) {
    const other = waiting;
    waiting = null;
    setPair(ws, other);
    return true;
  }
  // else set as waiting
  waiting = ws;
  safeSend(ws, { type: "waiting" });
  return false;
}

wss.on("connection", (ws) => {
  // When a client connects, put them in waiting pool
  tryPutInWaiting(ws);

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    const peer = getPeer(ws);

    // If not paired yet, we only accept "offer" and use it to pair if needed.
    // But we STILL need to forward it once paired.
    if (!peer) {
      if (msg.type === "offer") {
        // If the sender is still waiting, try to pair now (race condition safe)
        // If pairing happens, forward offer to peer.
        const pairedNow = tryPutInWaiting(ws);
        const newPeer = getPeer(ws);

        if (pairedNow && newPeer) {
          safeSend(newPeer, { type: "offer", offer: msg.offer });
        }
      }
      return;
    }

    // If paired, relay signaling messages ONLY to partner
    if (msg.type === "offer") {
      safeSend(peer, { type: "offer", offer: msg.offer });
      return;
    }
    if (msg.type === "answer") {
      safeSend(peer, { type: "answer", answer: msg.answer });
      return;
    }
    if (msg.type === "ice") {
      safeSend(peer, { type: "ice", candidate: msg.candidate });
      return;
    }
    if (msg.type === "skip") {
      // both reset; re-queue both
      safeSend(peer, { type: "reset", reason: "skip" });
      clearPair(ws, "skip");
      if (waiting === ws) waiting = null;
      if (waiting === peer) waiting = null;
      tryPutInWaiting(ws);
      tryPutInWaiting(peer);
      return;
    }
  });

  ws.on("close", () => {
    // If this ws was waiting, clear waiting slot
    if (waiting === ws) waiting = null;

    // Break pair and notify partner
    clearPair(ws, "disconnect");
  });

  ws.on("error", () => {
    // treat like close
    if (waiting === ws) waiting = null;
    clearPair(ws, "error");
  });
});

server.listen(PORT, () => {
  console.log(`OMINGLE match server listening on :${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
});
