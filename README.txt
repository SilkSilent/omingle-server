OMINGLE Server Pack (MVP)
========================

This is the minimal signaling + matchmaking server for OMINGLE (Omegle-style).

What it does
------------
- WebSocket signaling for WebRTC (offer/answer/ICE candidates relay)
- Matchmaking queue with plan priority: elite > plus > free
- Text chat relay (optional)

Run locally
-----------
1) Install Node.js 18+
2) In this folder:
   npm install
   npm start

Default:
- Health: http://localhost:8787/health
- WS: ws://localhost:8787/ws

Deploy
------
Put this on a VPS (Ubuntu) and run behind Nginx with SSL (wss://).
Then in WordPress, set the WS URL for the OMINGLE Core plugin.

WP config
---------
Add this in your theme's functions.php or a small plugin:

add_filter('omingle_core_ws_url', function() {
  return 'wss://YOUR-SIGNALING-DOMAIN/ws';
});

TURN/STUN
---------
For best reliability (especially mobile Safari), add a TURN server later.
This MVP ships with a public STUN in the client; you will upgrade iceServers for production.
