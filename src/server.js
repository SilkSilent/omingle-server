import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

/** ====== State ====== */
const clients = new Map(); // ws -> {id, ip, roomId, lastSeen, prefs, chatWindow, reportCount}
const waitingFree = [];
const waitingPref = []; // {ws, prefs, ts}
const rooms = new Map(); // roomId -> {a, b}

// Bans: ip -> {until, reason}
const bans = new Map();

// Report strikes by ip (soft reputation)
const strikes = new Map(); // ip -> {count, last}

/** ====== Tunables ====== */
const BAN_MS = 1000 * 60 * 60 * 6;          // 6h ban
const STRIKE_DECAY_MS = 1000 * 60 * 60 * 24; // decay after 24h
const STRIKE_THRESHOLD = 3;                  // 3 reports -> ban
const CHAT_LIMIT = 8;                        // 8 msg per window
const CHAT_WINDOW_MS = 5000;                 // 5 sec window

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function now() { return Date.now(); }

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function getClient(ws) { return clients.get(ws); }

function removeFromQueue(queue, ws) {
  const i = queue.findIndex((x) => (x?.ws ? x.ws === ws : x === ws));
  if (i >= 0) queue.splice(i, 1);
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

  for (const w of [r.a, r.b]) {
    const c = getClient(w);
    if (c) c.roomId = null;
    safeSend(w, { type: reason });
  }
}

function isBanned(ip) {
  const b = bans.get(ip);
  if (!b) return null;
  if (b.until <= now()) {
    bans.delete(ip);
    return null;
  }
  return b;
}

function banIp(ip, reason = "reports") {
  bans.set(ip, { until: now() + BAN_MS, reason });
}

function addStrike(ip) {
  const s = strikes.get(ip) || { count: 0, last: 0 };
  // decay if old
  if (s.last && (now() - s.last) > STRIKE_DECAY_MS) {
    s.count = 0;
  }
  s.count += 1;
  s.last = now();
  strikes.set(ip, s);
  return s.count;
}

function matchPrefsCompatible(p1, p2) {
  if (!p1 || !p2) return true;
  const keys = ["gender", "country"];
  for (const k of keys) {
    if (p1?.[k] && p2?.[k] && p1[k] !== p2[k]) return false;
  }
  return true;
}

function pickMatchFor(ws, prefs) {
  // Try pref queue first
  for (let i = 0; i < waitingPref.length; i++) {
    const cand = waitingPref[i];
    if (!cand?.ws || cand.ws === ws) continue;
    if (!clients.has(cand.ws)) continue;

    if (matchPrefsCompatible(prefs, cand.prefs)) {
      waitingPref.splice(i, 1);
      return cand.ws;
    }
  }

  // fallback free
  while (waitingFree.length > 0) {
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

  // deterministic roles
  safeSend(a, { type: "matched", role: "caller" });
  safeSend(b, { type: "matched", role: "callee" });
}

function tooManyChat(ws) {
  const c = getClient(ws);
  if (!c) return true;

  const t = now();
  if (!c.chatWindow) c.chatWindow = { start: t, count: 0 };

  // reset window
  if (t - c.chatWindow.start > CHAT_WINDOW_MS) {
    c.chatWindow.start = t;
    c.chatWindow.count = 0;
  }

  c.chatWindow.count += 1;
  return c.chatWindow.count > CHAT_LIMIT;
}

/** ====== Server ====== */
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .toString()
    .split(",")[0]
    .trim();

  const ban = isBanned(ip);
  if (ban) {
    safeSend(ws, { type: "banned", until: ban.until, reason: ban.reason });
    try { ws.close(); } catch {}
    return;
  }

  const id = uid();
  clients.set(ws, {
    id,
    ip,
    roomId: null,
    lastSeen: now(),
    prefs: null,
    chatWindow: null,
  });

  safeSend(ws, { type: "hello", id });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    const c = getClient(ws);
    if (!c) return;
    c.lastSeen = now();

    const t = data?.type;

    if (t === "ping") {
      safeSend(ws, { type: "pong" });
      return;
    }

    if (t === "find") {
      // banned mid-session?
      const ban2 = isBanned(c.ip);
      if (ban2) {
        safeSend(ws, { type: "banned", until: ban2.until, reason: ban2.reason });
        try { ws.close(); } catch {}
        return;
      }

      if (c.roomId) endRoom(c.roomId, "reset");

      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);

      const prefs = data?.prefs || null;
      c.prefs = prefs;

      const mate = pickMatchFor(ws, prefs);

      if (mate) {
        createRoom(ws, mate);
      } else {
        if (prefs) waitingPref.push({ ws, prefs, ts: now() });
        else waitingFree.push(ws);
        safeSend(ws, { type: "waiting" });
      }
      return;
    }

    if (t === "stop") {
      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);
      if (c.roomId) endRoom(c.roomId, "reset");
      safeSend(ws, { type: "stopped" });
      return;
    }

    if (t === "skip") {
      if (c.roomId) endRoom(c.roomId, "reset");

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

    // relay signaling
    if (["offer", "answer", "ice"].includes(t)) {
      const roomId = c.roomId;
      if (!roomId) return;
      const other = otherInRoom(roomId, ws);
      if (!other) return;
      safeSend(other, data);
      return;
    }

    // chat relay (rate limited)
    if (t === "chat") {
      const roomId = c.roomId;
      if (!roomId) return;

      if (tooManyChat(ws)) {
        safeSend(ws, { type: "chat_limit" });
        return;
      }

      const other = otherInRoom(roomId, ws);
      if (!other) return;

      const text = (data?.text || "").toString().slice(0, 800);
      if (!text.trim()) return;

      safeSend(other, { type: "chat", text });
      return;
    }

    // report: strike other user ip; ban if threshold
    if (t === "report") {
      const roomId = c.roomId;
      if (!roomId) return;

      const other = otherInRoom(roomId, ws);
      if (!other) return;

      const oc = getClient(other);
      const otherIp = oc?.ip;

      if (otherIp) {
        const count = addStrike(otherIp);
        if (count >= STRIKE_THRESHOLD) {
          banIp(otherIp, "reports");
          safeSend(other, { type: "banned", until: now() + BAN_MS, reason: "reports" });
          try { other.close(); } catch {}
        }
      }

      safeSend(ws, { type: "reported_ok" });

      // end match for both
      endRoom(roomId, "reset");
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

// cleanup inactive
setInterval(() => {
  const cutoff = now() - 1000 * 60 * 2;
  for (const [ws, c] of clients.entries()) {
    if (c.lastSeen < cutoff) {
      try { ws.close(); } catch {}
      clients.delete(ws);
    }
  }
}, 30000);

server.listen(PORT, () => console.log("OMINGLE server listening on", PORT));
