import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * waitingQueue = [{ ws, prefs }]
 * prefs = { gender, country } | null
 */
let waitingQueue = [];
const clients = new Set();

function send(ws, obj) {
  try {
    ws.readyState === 1 && ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  clients.forEach(ws => {
    try { ws.readyState === 1 && ws.send(msg); } catch {}
  });
}

function compatible(a, b) {
  if (!a || !b) return true;

  if (a.gender && b.gender && a.gender !== b.gender) return false;
  if (a.country && b.country && a.country !== b.country) return false;

  return true;
}

function tryMatch() {
  for (let i = 0; i < waitingQueue.length; i++) {
    for (let j = i + 1; j < waitingQueue.length; j++) {
      const A = waitingQueue[i];
      const B = waitingQueue[j];

      if (compatible(A.prefs, B.prefs) && compatible(B.prefs, A.prefs)) {
        waitingQueue.splice(j, 1);
        waitingQueue.splice(i, 1);

        A.ws.partner = B.ws;
        B.ws.partner = A.ws;

        A.ws.role = "caller";
        B.ws.role = "callee";

        send(A.ws, { type: "matched", role: "caller" });
        send(B.ws, { type: "matched", role: "callee" });
        return;
      }
    }
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  broadcast({ type: "online", count: clients.size });

  ws.partner = null;
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "find") {
      waitingQueue.push({ ws, prefs: msg.prefs || null });
      tryMatch();
      return;
    }

    if (msg.type === "skip" || msg.type === "stop") {
      if (ws.partner) {
        send(ws.partner, { type: "reset" });
        ws.partner.partner = null;
      }
      ws.partner = null;
      waitingQueue.push({ ws, prefs: msg.prefs || null });
      tryMatch();
      return;
    }

    if (msg.type === "report") {
      if (ws.partner) {
        send(ws.partner, { type: "reset", reason: "reported" });
        ws.partner.close();
      }
      ws.partner = null;
      waitingQueue.push({ ws, prefs: msg.prefs || null });
      tryMatch();
      return;
    }

    // Relay everything else (offer/answer/ice/chat)
    if (ws.partner) {
      send(ws.partner, msg);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcast({ type: "online", count: clients.size });

    waitingQueue = waitingQueue.filter(e => e.ws !== ws);

    if (ws.partner) {
      send(ws.partner, { type: "reset" });
      ws.partner.partner = null;
      waitingQueue.push({ ws: ws.partner, prefs: null });
      tryMatch();
    }
  });
});

server.listen(PORT, () => {
  console.log("OMINGLE server running on port", PORT);
});
