/**
 * OMINGLE Match + Signaling Server (MVP)
 * - WebSocket path: /ws
 * - Deterministic roles: caller/callee (only caller creates offer)
 * - Relays: offer/answer/ice/chat
 * - Skip / Stop (reset) handling
 * - Robust cleanup on disconnect
 */

const http = require("http");
const url = require("url");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const WS_PATH = process.env.WS_PATH || "/ws";

// --- Simple state ---
/**
 * waitingQueue holds sockets waiting for a match
 * we keep it FIFO
 */
const waitingQueue = [];

/**
 * peerMap maps ws -> peer ws
 */
const peerMap = new Map();

/**
 * roleMap maps ws -> "caller" | "callee"
 */
const roleMap = new Map();

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
  // pop dead sockets
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

  // Deterministic roles: first becomes caller
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

  // Health endpoint
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

const wss = new WebSocket.Server({ noServer: true });

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

  // Put in queue immediately
  enqueue(ws);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    // Client actions
    switch (data.type) {
      case "offer":
      case "answer":
      case "ice":
      case "chat":
        // Only relay if matched
        relay(ws, data);
        break;

      case "skip":
        // Skip current peer & immediately requeue skipper
        unlinkPeers(ws, "reset");
        enqueue(ws);
        break;

      case "stop":
        // Stop ends the session; user goes back to queue (or you can keep idle)
        unlinkPeers(ws, "reset");
        enqueue(ws);
        break;

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      default:
        // ignore unknown
        break;
    }
  });

  ws.on("close", () => {
    // If in queue, remove
    removeFromQueue(ws);

    // If paired, notify peer and requeue peer
    const peer = peerMap.get(ws);
    if (peer) {
      peerMap.delete(peer);
      roleMap.delete(peer);
      safeSend(peer, { type: "reset" });

      peerMap.delete(ws);
      roleMap.delete(ws);

      // put peer back in queue
      if (isAlive(peer)) enqueue(peer);
    } else {
      peerMap.delete(ws);
      roleMap.delete(ws);
    }
  });

  ws.on("error", () => {
    // handled by close cleanup
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OMINGLE match server listening on :${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
});
