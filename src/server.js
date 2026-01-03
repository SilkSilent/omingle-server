import http from "http";
import url from "url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const WS_PATH = "/ws";

let waiting = null;
const peer = new Map(); // ws -> ws

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function alive(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function setPair(a, b) {
  peer.set(a, b);
  peer.set(b, a);
  safeSend(a, { type: "matched" });
  safeSend(b, { type: "matched" });
}

function clearPair(ws, reason = "reset") {
  const p = peer.get(ws);
  if (p) {
    peer.delete(p);
    safeSend(p, { type: "reset", reason });
  }
  peer.delete(ws);
}

function enqueue(ws) {
  // if already paired, ignore
  if (peer.get(ws)) return;

  if (waiting && waiting !== ws && alive(waiting)) {
    const other = waiting;
    waiting = null;
    setPair(ws, other);
  } else {
    waiting = ws;
    safeSend(ws, { type: "waiting" });
  }
}

function relay(ws, msg) {
  const p = peer.get(ws);
  if (!p || !alive(p)) return;
  safeSend(p, msg);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/" || parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, wsPath: WS_PATH }));
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

    // commands
    if (msg.type === "find") {
      enqueue(ws);
      return;
    }
    if (msg.type === "skip") {
      const p = peer.get(ws);
      clearPair(ws, "skip");
      if (alive(ws)) enqueue(ws);
      if (alive(p)) enqueue(p);
      return;
    }

    // relay signaling
    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      relay(ws, msg);
    }
  });

  ws.on("close", () => {
    if (waiting === ws) waiting = null;
    const p = peer.get(ws);
    clearPair(ws, "disconnect");
    if (alive(p)) enqueue(p);
  });

  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`WS path ${WS_PATH}`);
});
