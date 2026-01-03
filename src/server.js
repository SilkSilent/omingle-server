import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";

const PORT = process.env.PORT || 8787;
const PATH = process.env.WS_PATH || "/ws";

// Very simple matchmaking queues by plan (elite > plus > free)
const queues = {
  elite: [],
  plus: [],
  free: []
};

const peers = new Map(); // id -> ws
const peerState = new Map(); // id -> { peerId, plan }

function makeId(){
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

function popNext(){
  // priority: elite, plus, free
  for (const plan of ["elite","plus","free"]) {
    if (queues[plan].length) return queues[plan].shift();
  }
  return null;
}

function enqueue(id, plan){
  const p = (plan === "elite" || plan === "plus") ? plan : "free";
  // Avoid duplicates
  for (const k of Object.keys(queues)) queues[k] = queues[k].filter(x => x !== id);
  queues[p].push(id);
}

function removeFromQueues(id){
  for (const k of Object.keys(queues)) queues[k] = queues[k].filter(x => x !== id);
}

function send(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch(e){}
}

function match(){
  // Take two users, with slight preference to keep higher plan priority
  const a = popNext();
  const b = popNext();
  if (!a || !b) {
    if (a) enqueue(a, peerState.get(a)?.plan || "free");
    return;
  }
  const wsA = peers.get(a);
  const wsB = peers.get(b);
  if (!wsA || !wsB) return;

  peerState.set(a, { ...(peerState.get(a)||{}), peerId: b });
  peerState.set(b, { ...(peerState.get(b)||{}), peerId: a });

  // Decide initiator randomly
  const initiatorA = Math.random() > 0.5;

  send(wsA, { type:"match", peerId: b, initiator: initiatorA });
  send(wsB, { type:"match", peerId: a, initiator: !initiatorA });
}

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok:true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: PATH });

wss.on("connection", (ws) => {
  const id = makeId();
  peers.set(id, ws);
  peerState.set(id, { peerId: null, plan: "free" });
  send(ws, { type:"hello", id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === "queue") {
      const plan = msg.plan || "free";
      peerState.set(id, { ...peerState.get(id), plan, peerId: null });
      enqueue(id, plan);
      // Try match whenever someone queues
      match();
      match();
    }

    if (msg.type === "leave") {
      const st = peerState.get(id);
      const peerId = st?.peerId;
      if (peerId) {
        const peerWs = peers.get(peerId);
        if (peerWs) send(peerWs, { type:"peer-left" });
        peerState.set(peerId, { ...peerState.get(peerId), peerId: null });
      }
      peerState.set(id, { ...peerState.get(id), peerId: null });
      removeFromQueues(id);
    }

    if (msg.type === "signal") {
      const to = msg.to;
      const peerWs = peers.get(to);
      if (peerWs) send(peerWs, { type:"signal", from:id, data: msg.data });
    }

    if (msg.type === "chat") {
      const to = msg.to;
      const peerWs = peers.get(to);
      if (peerWs) send(peerWs, { type:"chat", from:id, text: String(msg.text||"") });
    }
  });

  ws.on("close", () => {
    const st = peerState.get(id);
    const peerId = st?.peerId;
    if (peerId) {
      const peerWs = peers.get(peerId);
      if (peerWs) send(peerWs, { type:"peer-left" });
      peerState.set(peerId, { ...peerState.get(peerId), peerId: null });
    }
    removeFromQueues(id);
    peers.delete(id);
    peerState.delete(id);
  });
});

server.listen(PORT, () => {
  console.log(`OMINGLE signaling server listening on http://0.0.0.0:${PORT}${PATH}`);
});
