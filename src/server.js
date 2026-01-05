let ws = null;
let pc = null;
let localStream = null;
let role = null;

let running = false;
let connected = false;
let pendingIce = [];
let pingTimer = null;

let matchStartedAt = 0;
let fallbackTimer = null;

const $ = (id) => document.getElementById(id);

const localVideo   = $("localVideo");
const remoteVideo  = $("remoteVideo");
const btnStart     = $("btnStart");
const btnSkip      = $("btnSkip");
const btnMute      = $("btnMute");
const btnReport    = $("btnReport");

const chatLog      = $("chatLog");
const chatInput    = $("chatInput");
const btnSend      = $("btnSend");

const statusText   = $("statusText");
const miniStatus   = $("miniStatus");
const statusDot    = $("statusDot");
const countdownEl  = $("countdown");
const remoteLabel  = $("remoteLabel");

const prefGender   = $("prefGender");
const prefCountry  = $("prefCountry");
const premiumHint  = $("premiumHint");

const btnDebugToggle = $("btnDebugToggle");
const debugPanel     = $("debugPanel");
const debugOut       = $("debugOut");
const btnDebugCopy   = $("btnDebugCopy");

/* ===== Premium from WP ===== */
const U = window.OMINGLE_USER || { logged:false, memberId:"", plan:"", status:"" };
const isPremiumActive =
  U.logged && (U.plan === "plus" || U.plan === "elite") && U.status === "active";

/* ===== UI ===== */
function log(msg){
  if (!chatLog) return;
  chatLog.textContent = (chatLog.textContent ? chatLog.textContent : "") + "\n" + msg;
  chatLog.scrollTop = chatLog.scrollHeight;
}
function clearLog(){
  if (chatLog) chatLog.textContent = "";
}
function setStatus(t){
  if (statusText) statusText.textContent = t;
  if (miniStatus) miniStatus.textContent = t;
}
function setDot(mode){
  if (!statusDot) return;
  if (mode === "ready") statusDot.style.background = "#6fdc8c";
  if (mode === "search") statusDot.style.background = "#f4c430";
  if (mode === "connected") statusDot.style.background = "#2d7dff";
  if (mode === "off") statusDot.style.background = "#b7c6d6";
}
function showLabel(t){
  if (!remoteLabel) return;
  remoteLabel.textContent = t;
  remoteLabel.style.display = "block";
}
function hideLabel(){
  if (!remoteLabel) return;
  remoteLabel.style.display = "none";
}
function setButtonMode(){
  if (!btnStart) return;
  btnStart.textContent = running ? "Stop" : "Avvia";
}

/* ===== Premium UI ===== */
function initPremiumUI(){
  if (!prefGender || !prefCountry || !premiumHint) return;

  if (!isPremiumActive) {
    prefGender.disabled = true;
    prefCountry.disabled = true;

    if (!U.logged) {
      premiumHint.textContent = "🔒 Loggati per usare i filtri Premium";
    } else {
      premiumHint.textContent = "🔒 Premium non attivo (" + (U.status || "—") + ")";
    }
  } else {
    premiumHint.textContent = "💎 Premium attivo (" + U.plan + " • " + (U.memberId || "ID") + ")";
  }
}
function getPrefs(){
  if (!isPremiumActive) return null;
  const gender = (prefGender?.value || "").trim();
  const country = (prefCountry?.value || "").trim();
  const prefs = {};
  if (gender) prefs.gender = gender;
  if (country) prefs.country = country;
  return Object.keys(prefs).length ? prefs : null;
}

/* ===== Debug ===== */
function dbgLine(k, v){
  return `${k}: ${v}\n`;
}
function wsStateName(){
  if (!ws) return "null";
  const s = ws.readyState;
  return s === 0 ? "CONNECTING" : s === 1 ? "OPEN" : s === 2 ? "CLOSING" : "CLOSED";
}
function updateDebug(){
  if (!debugOut) return;

  const wsState = wsStateName();
  const pcState = pc?.connectionState || "null";
  const iceState = pc?.iceConnectionState || "null";
  const sigState = pc?.signalingState || "null";
  const remoteHasStream = !!remoteVideo?.srcObject;

  const sinceMatch = matchStartedAt ? `${Math.floor((Date.now() - matchStartedAt)/1000)}s` : "-";

  let out = "";
  out += dbgLine("running", running);
  out += dbgLine("connected", connected);
  out += dbgLine("role", role || "-");
  out += dbgLine("WS", wsState);
  out += dbgLine("PC.connectionState", pcState);
  out += dbgLine("PC.iceConnectionState", iceState);
  out += dbgLine("PC.signalingState", sigState);
  out += dbgLine("remoteStream", remoteHasStream ? "yes" : "no");
  out += dbgLine("pendingIce", pendingIce.length);
  out += dbgLine("sinceMatch", sinceMatch);
  out += dbgLine("premiumActive", isPremiumActive);
  out += dbgLine("prefs", JSON.stringify(getPrefs()));
  debugOut.textContent = out;
}

btnDebugToggle?.addEventListener("click", () => {
  if (!debugPanel) return;
  debugPanel.style.display = (debugPanel.style.display === "none" || !debugPanel.style.display) ? "block" : "none";
  updateDebug();
});

btnDebugCopy?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(debugOut?.textContent || "");
    log("✅ Debug copiato negli appunti");
  } catch {
    log("⚠️ Impossibile copiare debug (permessi browser)");
  }
});

setInterval(updateDebug, 1000);

/* ===== Media ===== */
async function getLocalStream(){
  if (localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: true,
  });

  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.playsInline = true;
  localVideo.autoplay = true;
  await localVideo.play().catch(()=>{});
  return localStream;
}

/* ===== WebRTC ===== */
function stopFallbackTimer(){
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

function startFallbackTimer(){
  stopFallbackTimer();

  // Dopo 10s: se non arriva remote stream -> fallback chat-only + suggerimento skip
  fallbackTimer = setTimeout(() => {
    if (!running) return;
    if (connected) return;
    const hasRemote = !!remoteVideo?.srcObject;

    if (!hasRemote) {
      log("⚠️ La tua rete sembra limitare la video-connessione. Passiamo in modalità chat-only.");
      setStatus("Chat-only");
      setDot("search");
      showLabel("Rete limitata: chat-only. Prova Skip o cambia rete.");
    }
  }, 10000);
}

function closePeer(){
  stopFallbackTimer();
  pendingIce = [];
  connected = false;

  try {
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
  } catch {}
  pc = null;

  try { remoteVideo.srcObject = null; } catch {}
}

function createPeer(){
  closePeer();
  pendingIce = [];

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:"ice", candidate:e.candidate }));
    }
  };

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remoteVideo.playsInline = true;
    remoteVideo.autoplay = true;
    remoteVideo.play().catch(()=>{});
    hideLabel();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      connected = true;
      stopFallbackTimer();
      setStatus("Connesso");
      setDot("connected");
    }
    if (st === "disconnected" || st === "failed" || st === "closed") {
      connected = false;
    }
  };
}

async function startCall(){
  await getLocalStream();
  createPeer();

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  startFallbackTimer();

  if (role === "caller"){
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({ type:"offer", offer }));
  }
}

async function acceptOffer(offer){
  await getLocalStream();
  createPeer();

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(offer);

  for (const c of pendingIce) {
    try { await pc.addIceCandidate(c); } catch {}
  }
  pendingIce = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws?.send(JSON.stringify({ type:"answer", answer }));
}

async function acceptAnswer(answer){
  if (!pc) return;
  await pc.setRemoteDescription(answer);

  for (const c of pendingIce) {
    try { await pc.addIceCandidate(c); } catch {}
  }
  pendingIce = [];
}

async function acceptIce(candidate){
  if (!pc) return;

  if (!pc.remoteDescription) {
    pendingIce.push(candidate);
    return;
  }
  try { await pc.addIceCandidate(candidate); } catch {}
}

/* ===== Chat (client rate-limit soft) ===== */
let chatBurst = { start: 0, count: 0 };
function chatTooFast(){
  const t = Date.now();
  if (!chatBurst.start || (t - chatBurst.start) > 4000) {
    chatBurst = { start: t, count: 0 };
  }
  chatBurst.count += 1;
  return chatBurst.count > 6;
}

function canChat(){
  return running && ws?.readyState === WebSocket.OPEN;
}

function sendChat(){
  const text = (chatInput?.value || "").trim();
  if (!text) return;

  if (!canChat()) {
    log("ℹ️ Non sei connesso al server.");
    return;
  }

  if (chatTooFast()) {
    log("⚠️ Troppi messaggi: rallenta un attimo.");
    return;
  }

  ws.send(JSON.stringify({ type:"chat", text }));
  log("🧑 Tu: " + text);
  chatInput.value = "";
}

btnSend?.addEventListener("click", sendChat);
chatInput?.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

/* ===== Countdown ===== */
function countdown(cb){
  if (!countdownEl) return cb();

  let n = 3;
  countdownEl.textContent = n;

  const i = setInterval(()=>{
    n--;
    countdownEl.textContent = n > 0 ? n : "";
    if (n === 0){
      clearInterval(i);
      cb();
    }
  }, 1000);
}

/* ===== WS helpers ===== */
function wsSend(obj){
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function stopPing(){
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function startPing(){
  stopPing();
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) wsSend({ type:"ping" });
  }, 20000);
}

/* ===== Match flow ===== */
function findMatch(){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  setStatus("Cercando…");
  setDot("search");
  showLabel("Cerchiamo un utente…");

  wsSend({ type:"find", prefs: getPrefs() });
}

function softResetUI(){
  closePeer();
  setDot(running ? "search" : "ready");
  showLabel("In attesa di un utente…");
}

/* ===== Connect / Disconnect ===== */
function connectWS(){
  return new Promise((resolve, reject) => {
    const url = window.OMINGLE_WS_URL;
    if (!url) return reject(new Error("OMINGLE_WS_URL missing"));

    ws = new WebSocket(url);

    ws.onopen = () => {
      startPing();
      resolve();
    };

    ws.onerror = (e) => {
      stopPing();
      reject(e);
    };

    ws.onclose = () => {
      stopPing();
      if (running) {
        log("🔌 Server disconnesso");
        setStatus("Offline");
        setDot("off");
        showLabel("Server offline. Riprova.");
      }
    };

    ws.onmessage = async (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }

      if (data.type === "banned") {
        const until = data.until ? new Date(data.until) : null;
        log("⛔ Sei stato bannato" + (until ? (" fino a " + until.toLocaleString()) : ""));
        setStatus("Bannato");
        setDot("off");
        showLabel("Bannato. Torna più tardi.");
        stopSession(false);
        return;
      }

      if (data.type === "waiting") {
        log("⌛ In attesa…");
        setStatus("In attesa…");
        setDot("search");
        showLabel("In attesa di un utente…");
        return;
      }

      if (data.type === "matched") {
        role = data.role;
        matchStartedAt = Date.now();
        log("✅ Utente trovato");
        setStatus("Connessione…");
        setDot("search");
        hideLabel();

        countdown(() => startCall());
        return;
      }

      if (data.type === "offer") {
        log("📩 Offer");
        await acceptOffer(data.offer);
        return;
      }

      if (data.type === "answer") {
        log("📩 Answer");
        await acceptAnswer(data.answer);
        return;
      }

      if (data.type === "ice" && data.candidate) {
        await acceptIce(data.candidate);
        return;
      }

      if (data.type === "chat") {
        log("👤 Stranger: " + (data.text || ""));
        return;
      }

      if (data.type === "chat_limit") {
        log("⚠️ Limite chat: rallenta un attimo.");
        return;
      }

      if (data.type === "reported_ok") {
        log("✅ Segnalazione registrata.");
        return;
      }

      if (data.type === "reset") {
        log("🔄 Match terminato");
        softResetUI();
        if (running) findMatch();
        return;
      }

      if (data.type === "pong") return;
    };
  });
}

/* ===== Start/Stop session ===== */
async function startSession(){
  try {
    running = true;
    setButtonMode();
    clearLog();

    setStatus("Avvio…");
    setDot("search");
    showLabel("Cerchiamo un utente…");

    if (isPremiumActive) {
      log("💎 Premium attivo (" + U.plan + ") — " + (U.memberId || "ID"));
    } else if (U.logged && U.status && U.status !== "active") {
      log("ℹ️ Premium: " + U.status + " (filtri disattivati finché non è active)");
    } else {
      log("🙂 Free mode");
    }

    await getLocalStream();

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      await connectWS();
    }

    findMatch();
  } catch (e) {
    log("❌ Errore avvio: " + (e?.message || e));
    running = false;
    setButtonMode();
    setStatus("Pronto");
    setDot("ready");
    showLabel("In attesa di un utente…");
  }
}

function stopSession(closeWs = true){
  running = false;
  setButtonMode();

  closePeer();
  connected = false;
  matchStartedAt = 0;

  if (closeWs) {
    try { wsSend({ type:"stop" }); } catch {}
    try { ws?.close(); } catch {}
    ws = null;
  }

  setStatus("Pronto");
  setDot("ready");
  showLabel("In attesa di un utente…");
}

/* ===== Buttons ===== */
btnStart?.addEventListener("click", () => {
  if (running) stopSession(true);
  else startSession();
});

btnSkip?.addEventListener("click", () => {
  if (!running) return;
  log("⏭️ Skip…");
  closePeer();
  connected = false;
  setStatus("Cercando…");
  setDot("search");
  showLabel("Cerchiamo un utente…");
  wsSend({ type:"skip", prefs: getPrefs() });
});

btnMute?.addEventListener("click", async () => {
  const s = await getLocalStream();
  const a = s.getAudioTracks()?.[0];
  if (!a) return;
  a.enabled = !a.enabled;
  log(a.enabled ? "🎤 Unmuted" : "🔇 Muted");
});

btnReport?.addEventListener("click", () => {
  if (!running) return;
  log("🚨 Segnalazione inviata. Cerchiamo un altro utente…");
  closePeer();
  connected = false;
  setStatus("Cercando…");
  setDot("search");
  showLabel("Cerchiamo un utente…");
  wsSend({ type:"report" });
  setTimeout(() => { if (running) findMatch(); }, 250);
});

/* ===== Init ===== */
initPremiumUI();
setStatus("Pronto");
setDot("ready");
showLabel("In attesa di un utente…");
setButtonMode();
updateDebug();
