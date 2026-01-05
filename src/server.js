import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

/** ====== State ====== */
const clients = new Map(); // ws -> {id, ip, roomId, lastSeen, prefs, profile, chatWindow}
const waitingFree = [];
const waitingPref = []; // {ws, prefs, ts}
const rooms = new Map(); // roomId -> {a, b}
const bans = new Map();      // ip -> {until, reason}
const strikes = new Map();   // ip -> {count, last}

/** ====== Tunables ====== */
const BAN_MS = 1000 * 60 * 60 * 6;           // 6h
const STRIKE_DECAY_MS = 1000 * 60 * 60 * 24; // 24h
const STRIKE_THRESHOLD = 3;                  // 3 reports -> ban

const CHAT_LIMIT = 8;        // 8 messages
const CHAT_WINDOW_MS = 5000; // per 5s

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const now = () => Date.now();

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

/** ====== Ban / strikes ====== */
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
  if (s.last && (now() - s.last) > STRIKE_DECAY_MS) s.count = 0;
  s.count += 1;
  s.last = now();
  strikes.set(ip, s);
  return s.count;
}

/** ====== Chat limit ====== */
function tooManyChat(ws) {
  const c = getClient(ws);
  if (!c) return true;
  const t = now();
  if (!c.chatWindow) c.chatWindow = { start: t, count: 0 };
  if (t - c.chatWindow.start > CHAT_WINDOW_MS) {
    c.chatWindow.start = t;
    c.chatWindow.count = 0;
  }
  c.chatWindow.count += 1;
  return c.chatWindow.count > CHAT_LIMIT;
}

/** ====== STRICT matching: prefs vs profile (both ways) ====== */
function normalizeProfile(p) {
  if (!p || typeof p !== "object") return {};
  const out = {};
  if (p.gender) out.gender = String(p.gender).toLowerCase();
  if (p.country) out.country = String(p.country).toUpperCase();
  return out;
}
function normalizePrefs(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  if (p.gender) out.gender = String(p.gender).toLowerCase();
  if (p.country) out.country = String(p.country).toUpperCase();
  return Object.keys(out).length ? out : null;
}
function strictCheck(prefsWant, otherProfile) {
  if (!prefsWant) return true;
  if (prefsWant.gender) {
    if (!otherProfile.gender) return false;
    if (prefsWant.gender !== otherProfile.gender) return false;
  }
  if (prefsWant.country) {
    if (!otherProfile.country) return false;
    if (prefsWant.country !== otherProfile.country) return false;
  }
  return true;
}
function isCompatible(wsA, prefsA, wsB, prefsB) {
  const a = getClient(wsA);
  const b = getClient(wsB);
  if (!a || !b) return false;

  const profA = normalizeProfile(a.profile);
  const profB = normalizeProfile(b.profile);

  const pA = normalizePrefs(prefsA);
  const pB = normalizePrefs(prefsB);

  return strictCheck(pA, profB) && strictCheck(pB, profA);
}

/** ====== Matchmaking ====== */
function pickMatchFor(ws, prefs) {
  // Prefer queue first
  for (let i = 0; i < waitingPref.length; i++) {
    const cand = waitingPref[i];
    if (!cand?.ws || cand.ws === ws) continue;
    if (!clients.has(cand.ws)) continue;

    if (isCompatible(ws, prefs, cand.ws, cand.prefs)) {
      waitingPref.splice(i, 1);
      return cand.ws;
    }
  }

  // Free queue fallback (still strict if requester has prefs)
  while (waitingFree.length > 0) {
    const cand = waitingFree.shift();
    if (!cand || !clients.has(cand) || cand === ws) continue;

    if (isCompatible(ws, prefs, cand, null)) {
      return cand;
    }
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

  safeSend(a, { type: "matched", role: "caller" });
  safeSend(b, { type: "matched", role: "callee" });
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

  clients.set(ws, {
    id: uid(),
    ip,
    roomId: null,
    lastSeen: now(),
    prefs: null,
    profile: null,
    chatWindow: null,
  });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    const c = getClient(ws);
    if (!c) return;
    c.lastSeen = now();

    const t = data?.type;

    if (t === "ping") { safeSend(ws, { type: "pong" }); return; }

    if (t === "hello_profile") {
      c.profile = normalizeProfile(data?.profile);
      return;
    }

    if (t === "find") {
      const ban2 = isBanned(c.ip);
      if (ban2) {
        safeSend(ws, { type: "banned", until: ban2.until, reason: ban2.reason });
        try { ws.close(); } catch {}
        return;
      }

      if (c.roomId) endRoom(c.roomId, "reset");

      removeFromQueue(waitingFree, ws);
      removeFromQueue(waitingPref, ws);

      const prefs = normalizePrefs(data?.prefs) || null;
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

      const prefs = normalizePrefs(data?.prefs) || c.prefs || null;
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

    if (["offer", "answer", "ice"].includes(t)) {
      const roomId = c.roomId;
      if (!roomId) return;
      const other = otherInRoom(roomId, ws);
      if (!other) return;
      safeSend(other, data);
      return;
    }

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
