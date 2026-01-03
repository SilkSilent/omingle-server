/**
 * OMINGLE Match + Signaling Server (MVP) - ESM
 * WebSocket path: /ws
 * Deterministic roles: caller/callee (only caller creates offer)
 * Relays: offer/answer/ice/chat
 * Skip / Stop (reset) handling
 * Robust cleanup on disconnect
 */

import http from "http";
import url from "url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const WS_PATH = process.env.WS_PATH || "/ws";

// --- Simple state ---
const waitingQueue = [];          // FIFO sockets waiting for match
const peerMap = new Map();        // ws -> peer ws
const roleMap = new Map();        // ws -> "caller" | "callee"

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (_) {}
}

function isAlive(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function removeFromQueue(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function unlinkPeers(ws, reason = "reset") {
  const peer = peerMap.get(ws);

  if (peer) {
    peerMap.delete(peer);
    roleMap.delete(peer);
    safeSend(peer, { type: reason });
  }

  peerMap.delete(ws);
  roleMap.delete(ws);
  safeSend(ws, { type: reason });
}

function enqueue(ws) {
  // avoid duplicates
  removeFromQueue(ws);
  waitingQueue.push(ws);
  safeSend(ws, { type: "searching" });
  tryMatch();
}

function tryMatch() {
  // drop dead sockets from head
  while (waitingQueue.length && !isAlive(waitingQueue[0])) waitingQueue.shift();
  if (waitingQueue.length < 2) return;

  const a = waitingQueue.shift();
  const b = waitingQueue.shift();

  if (!isAlive(a) || !isAlive(b)) {
    if (isAlive(a)) enqueue(a);
    if (isAlive(b)) enqueue(b);
    return;
  }

  // Pair them
  peerMap.set(a, b);
  peerMap.set(b, a);

  // Deterministic roles: first is caller
  roleMap.set(a, "caller");
  roleMap.set(b, "callee");

  safeSend(a, { type: "matched" });
  safeSend(b, { type: "matched" });

  safeSend(a, { type: "role", role: "caller" });
  safeSend(b, { type: "role", role: "callee" });
}

function relay(ws, payload) {
  const peer = peerMap.get(ws);
  if (!peer || !isAlive(peer)) return;
  safeSend(peer, payload);
}

// --- HTTP server (health + WS upgrade) ---
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === "/" || parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        wsPath: WS_PATH,
        waiting: waitingQueue.length,
        uptime: process.uptime(),
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  safeSend(ws, { type: "hello", msg: "OMINGLE match server ready" });

  enqueue(ws);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    switch (data.type) {
      case "offer":
      case "answer":
      case "ice":
      case "chat":
        relay(ws, data);
        break;

      case "skip":
        unlinkPeers(ws, "reset");
        enqueue(ws);
        break;

      case "stop":
        unlinkPeers(ws, "reset");
        enqueue(ws);
        break;

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);

    const peer = peerMap.get(ws);
    if (peer) {
      peerMap.delete(peer);
      roleMap.delete(peer);
      safeSend(peer, { type: "reset" });

      peerMap.delete(ws);
      roleMap.delete(ws);

      if (isAlive(peer)) enqueue(peer);
    } else {
      peerMap.delete(ws);
      roleMap.delete(ws);
    }
  });

  ws.on("error", () => {
    // cleanup happens in close
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OMINGLE match server listening on :${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
});
