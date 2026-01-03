import http from "http";
import url from "url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const WS_PATH = process.env.WS_PATH || "/ws";

// Queue + sessions
const queue = [];
const sessionOf = new Map(); // ws -> sessionId
const peers = new Map();     // ws -> peer ws
const ready = new Map();     // ws -> boolean (ready ack)
let nextSessionId = 1;

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}
function alive(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function removeFromQueue(ws) {
  const i = queue.indexOf(ws);
  if (i !== -1) queue.splice(i, 1);
}

function clearPair(ws, reason = "reset") {
  const p = peers.get(ws);

  if (p) {
    peers.delete(p);
    sessionOf.delete(p);
    ready.delete(p);
    safeSend(p, { type: "reset", reason });
  }

  peers.delete(ws);
  sessionOf.delete(ws);
  ready.delete(ws);
  safeSend(ws, { type: "reset", reason });
}

function enqueue(ws) {
  if (!alive(ws)) return;

  // If paired, do nothing
  if (peers.get(ws)) return;

  // Remove duplicates
  removeFromQueue(ws);

  queue.push(ws);
  safeSend(ws, { type: "searching" });
  tryMatch();
}

function tryMatch() {
  // drop dead
  while (queue.length && !alive(queue[0])) queue.shift();
  if (queue.length < 2) return;

  const a = queue.shift();
  const b = queue.shift();

  if (!alive(a) || !alive(b)) {
    if (alive(a)) enqueue(a);
    if (alive(b)) enqueue(b);
    return;
  }

  const sessionId = String(nextSessionId++);
  peers.set(a, b);
  peers.set(b, a);
  sessionOf.set(a, sessionId);
  sessionOf.set(b, sessionId);

  // reset readiness
  ready.set(a, false);
  ready.set(b, false);

  // deterministic roles
  safeSend(a, { type: "matched", sessionId });
  safeSend(b, { type: "matched", sessionId });
  safeSend(a, { type: "role", role: "caller", sessionId });
  safeSend(b, { type: "role", role: "callee", sessionId });

  // require both to ack ready; prevents "offer sent into void"
  safeSend(a, { type: "need_ready", sessionId });
  safeSend(b, { type: "need_ready", sessionId });
}

function getPeer(ws) {
  const p = peers.get(ws);
  return alive(p) ? p : null;
}

function bothReady(ws) {
  const p = getPeer(ws);
  if (!p) return false;
  return ready.get(ws) === true && ready.get(p) === true;
}

function relay(ws, msg) {
  const p = getPeer(ws);
  if (!p) return;

  // Only relay signaling after both have ACKed ready
  if (!bothReady(ws)) return;

  safeSend(p, msg);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/" || parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        wsPath: WS_PATH,
        waiting: queue.length,
        paired: peers.size / 2,
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
  if (parsed.pathname !== WS_PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  safeSend(ws, { type: "hello" });

  enqueue(ws);

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Always allow find/enqueue
    if (msg.type === "find") {
      // user wants to be matched (or rematched)
      if (!peers.get(ws)) enqueue(ws);
      return;
    }

    // READY ACK: both must send this after receiving matched/role
    if (msg.type === "ready") {
      const sid = sessionOf.get(ws);
      if (!sid) return; // not in a session
      ready.set(ws, true);

      const p = getPeer(ws);
      if (p && ready.get(p) === true) {
        // both ready -> tell both to start negotiation
        safeSend(ws, { type: "go", sessionId: sid });
        safeSend(p, { type: "go", sessionId: sid });
      }
      return;
    }

    // Skip/stop
    if (msg.type === "skip") {
      const p = getPeer(ws);
      clearPair(ws, "skip");
      if (alive(ws)) enqueue(ws);
      if (alive(p)) enqueue(p);
      return;
    }

    if (msg.type === "stop") {
      clearPair(ws, "stop");
      if (alive(ws)) enqueue(ws);
      return;
    }

    // Relay signaling
    if (msg.type === "desc" || msg.type === "ice" || msg.type === "chat") {
      relay(ws, msg);
      return;
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    const p = peers.get(ws);

    if (p) {
      peers.delete(p);
      sessionOf.delete(p);
      ready.delete(p);
      safeSend(p, { type: "reset", reason: "disconnect" });
      peers.delete(ws);
      sessionOf.delete(ws);
      ready.delete(ws);

      if (alive(p)) enqueue(p);
    } else {
      peers.delete(ws);
      sessionOf.delete(ws);
      ready.delete(ws);
    }
  });

  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OMINGLE match server listening on :${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
});
