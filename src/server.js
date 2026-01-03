import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

let waiting = null;

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2);
  ws.partner = null;
  ws.role = null;

  if (waiting) {
    // Match found
    ws.partner = waiting;
    waiting.partner = ws;

    ws.role = "caller";
    waiting.role = "callee";

    ws.send(JSON.stringify({ type: "matched", role: "caller" }));
    waiting.send(JSON.stringify({ type: "matched", role: "callee" }));

    waiting = null;
  } else {
    waiting = ws;
    ws.send(JSON.stringify({ type: "waiting" }));
  }

  ws.on("message", (msg) => {
    if (!ws.partner) return;
    ws.partner.send(msg.toString());
  });

  ws.on("close", () => {
    if (waiting === ws) waiting = null;
    if (ws.partner) {
      ws.partner.send(JSON.stringify({ type: "reset" }));
      ws.partner.partner = null;
    }
  });
});

server.listen(PORT, () => {
  console.log("OMINGLE match server listening on :" + PORT);
});
