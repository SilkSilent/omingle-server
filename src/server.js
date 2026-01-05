import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

/** ====== Basic in-memory state (MVP) ====== */
const clients = new Map(); // ws -> clientObj
const waitingFree = [];
const waitingPref = []; // premium queue {ws, prefs, ts}
const rooms = new Map(); // roomId -> {a, b}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function now() {
  return Date.now();
}

function getClient(ws) {
  return clients.get(ws);
}

function removeFromQueue(queue, ws) {
  const i = queue.findIndex((x) => (x.ws ? x.ws === ws : x === ws));
  if (i >= 0) queue.splice(i, 1);
}

function inRoom(ws) {
  const c = getClient(ws);
  return c?.roomId || null;
}

function otherInRoom(roomId, ws) {
  const r = rooms.get(roomId);
  if (!r) return null;
  return r.a === ws ? r.b : r.a;
}

function endRoom(roomId, reason = "reset") {
  const r = rooms.get(roomId);
  if (!r) return;
  rooms.delete(roomId);

  [r.a, r.b].forEach((w) => {
    const c = getClient(w);
    if (c) c.roomId = null;
    safeSend(w, { type: reason });
  });
}

function matchPrefsCompatible(p1, p2) {
  // Prefs example: {gender:"female", country:"IT"}
  if (!p1 || !p2) return true;

  // Simple compatibility rule:
  // If both specify same key, it must match. If one specifies and other doesn't, allow.
  const keys = ["gender", "country"];
  for (const k of keys) {
    if (p1?.[k] && p2?.[k] && p1[k] !== p2[k]) return false;
  }
  return true;
}

function pickMatchFor(ws, prefs) {
  // 1) Try pref queue first for best compatibility
  for (let i = 0; i < waitingPref.length; i++) {
    const cand = waitingPref[i];
    if (!cand?.ws || cand.ws === ws) continue;
    if (!clients.has(cand.ws)) continue;

    if (matchPrefsCompatible(prefs, cand.prefs)) {
      waitingPref.splice(i, 1);
      return cand.ws;
    }
  }

  // 2) Otherwise use free queue
  if (waitingFree.length > 0) {
    const cand = waitingFree.shift();
    if (cand && clients.has(cand) && cand !== ws) return cand;
  }

  return null;
}

function createRoom(a, b) {
  const roomId = "room_" + uid();

  rooms.set(roomId, { a, b });

  const ca = getClient(a);
  const cb = getClient(b);
  if (ca) ca.roomId = roomId;
  if (cb) cb.roomId = roomId;

  // deterministic roles: first is caller
  safeSend(a, { type: "matched", role: "caller" });
  safeSend(b, { type: "matched", role: "callee" });
}

/** ====== Server ====== */
const server = http.createServer((req, res) => {
  // health
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const id = uid();

  clients.set(ws, {
    id,
    roomId: null,
    lastSeen: now(),
    prefs: null,
    muted: false,
  });

  safeSend(ws, { type: "hello", id });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const c = getClient(ws);
    if (!c) return;
    c.lastSeen = now();

    const t = data?.type;

    // keepalive
    if (t === "ping") {
      safeSend(ws, { type: "pong" });
      return;
    }

    // find a match
    if (t === "find") {
      // if already in room, reset first
      if (c.roomId) endRoom(c.roomId, "reset");

      // clear any queue presence
      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);

      const prefs = data?.prefs || null;
      c.prefs = prefs;

      const mate = pickMatchFor(ws, prefs);
      if (mate) {
        createRoom(ws, mate);
      } else {
        // enqueue
        if (prefs) waitingPref.push({ ws, prefs, ts: now() });
        else waitingFree.push(ws);
        safeSend(ws, { type: "waiting" });
      }
      return;
    }

    // stop: end current room + remove from queue
    if (t === "stop") {
      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);
      if (c.roomId) endRoom(c.roomId, "reset");
      safeSend(ws, { type: "stopped" });
      return;
    }

    // skip: end room then find again automatically (server-side)
    if (t === "skip") {
      if (c.roomId) endRoom(c.roomId, "reset");
      // act like find with same prefs (if any)
      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);

      const prefs = data?.prefs || c.prefs || null;
      c.prefs = prefs;

      const mate = pickMatchFor(ws, prefs);
      if (mate) createRoom(ws, mate);
      else {
        if (prefs) waitingPref.push({ ws, prefs, ts: now() });
        else waitingFree.push(ws);
        safeSend(ws, { type: "waiting" });
      }
      return;
    }

    // relay signaling only to the other user in the same room
    if (["offer", "answer", "ice"].includes(t)) {
      const roomId = c.roomId;
      if (!roomId) return;

      const other = otherInRoom(roomId, ws);
      if (!other) return;

      safeSend(other, data);
      return;
    }

    // chat relay
    if (t === "chat") {
      const roomId = c.roomId;
      if (!roomId) return;

      const other = otherInRoom(roomId, ws);
      if (!other) return;

      const text = (data?.text || "").toString().slice(0, 800);
      if (!text.trim()) return;

      safeSend(other, { type: "chat", text });
      return;
    }

    // report (MVP): end match and put reporter back in queue
    if (t === "report") {
      const roomId = c.roomId;
      if (roomId) endRoom(roomId, "reset");
      safeSend(ws, { type: "reported" });
      return;
    }
  });

  ws.on("close", () => {
    const c = getClient(ws);
    if (!c) return;

    removeFromQueue(waitingFree, ws);
    removeFromQueue(waitingPref, ws);

    if (c.roomId) endRoom(c.roomId, "reset");

    clients.delete(ws);
  });
});

/** Cleanup dead clients (optional) */
setInterval(() => {
  const cutoff = now() - 1000 * 60 * 2; // 2 min
  for (const [ws, c] of clients.entries()) {
    if (c.lastSeen < cutoff) {
      try { ws.close(); } catch {}
      clients.delete(ws);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log("OMINGLE server listening on", PORT);
});
