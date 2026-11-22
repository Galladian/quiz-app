(() => {
  // src/main.ts
  var app = document.getElementById("app");
  var net = document.getElementById("net");
  var isHost = location.pathname.startsWith("/host");
  var proto = location.protocol === "https:" ? "wss" : "ws";
  var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var $ = (id) => document.getElementById(id);
  var KEY = "quiz-id";
  function loadIdentity() {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "null");
    } catch {
      return null;
    }
  }
  function saveIdentity(id) {
    try {
      id ? localStorage.setItem(KEY, JSON.stringify(id)) : localStorage.removeItem(KEY);
    } catch {
    }
  }
  var me = isHost ? null : loadIdentity();
  var view = "none";
  var sent = /* @__PURE__ */ new Map();
  var ws;
  var timer;
  var send = (obj) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  function connect() {
    clearTimeout(timer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      net.hidden = true;
      if (isHost) send({ type: "host" });
      else if (me) send({ type: "join", name: me.name, token: me.token });
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      net.hidden = false;
      timer = window.setTimeout(connect, 1500);
    };
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && connect());
  window.addEventListener("online", connect);
  function handle(msg) {
    if (isHost) return msg.type === "state" ? renderHost(msg) : void 0;
    switch (msg.type) {
      case "joined":
        me = { name: msg.name, token: msg.token };
        saveIdentity(me);
        sent.clear();
        Object.entries(msg.answers).forEach(([p, a]) => sent.set(p, a));
        if (view === "player") renderSent();
        else renderPlayer();
        break;
      case "submitted": {
        sent.set(msg.puzzle, msg.answer);
        renderSent();
        const n = Number(msg.puzzle);
        $("puzzle").value = Number.isNaN(n) ? msg.puzzle : String(n + 1);
        const text = $("text");
        text.value = "";
        text.focus();
        $("status").textContent = `Sent answer for puzzle ${msg.puzzle}.`;
        break;
      }
      case "error":
        me = null;
        saveIdentity(null);
        renderJoin(msg.message);
        break;
    }
  }
  function renderJoin(error = "") {
    view = "join";
    app.innerHTML = `
    <h1>Family Quiz</h1>
    <p>Pick a name to join.</p>
    <form id="join">
      <label>Your name <input id="name" maxlength="20" autocomplete="off" required></label>
      <button>Join</button>
      <div class="err" role="alert">${esc(error)}</div>
    </form>`;
    $("join").onsubmit = (e) => {
      e.preventDefault();
      send({ type: "join", name: $("name").value });
    };
  }
  function renderPlayer() {
    view = "player";
    const next = Math.max(0, ...[...sent.keys()].map(Number).filter((n) => !Number.isNaN(n))) + 1;
    app.innerHTML = `
    <h1>Hi, ${esc(me.name)}</h1>
    <p>Work it out on paper, then send your answer here.</p>
    <form id="answer">
      <label>Puzzle number <input id="puzzle" inputmode="numeric" value="${next}" required></label>
      <label>Your answer <input id="text" autocomplete="off" required></label>
      <button>Send answer</button>
      <div class="ok" id="status" role="status"></div>
    </form>
    <div id="sentbox"></div>
    <p><button id="leave" class="quiet" type="button">Not you? Switch player</button></p>`;
    $("answer").onsubmit = (e) => {
      e.preventDefault();
      send({ type: "submit", puzzle: $("puzzle").value, answer: $("text").value });
    };
    $("leave").onclick = () => {
      if (!confirm("Leave the quiz as this player?")) return;
      send({ type: "leave" });
      me = null;
      saveIdentity(null);
      sent.clear();
      renderJoin();
    };
    renderSent();
    $("text").focus();
  }
  function renderSent() {
    const items = [...sent].sort((a, b) => Number(a[0]) - Number(b[0]));
    $("sentbox").innerHTML = items.length ? `<h2>Sent so far</h2><ul>${items.map(([p, a]) => `<li>Puzzle ${esc(p)}: ${esc(a)}</li>`).join("")}</ul>` : "";
  }
  function renderHost(s) {
    const puzzles = Object.keys(s.submissions).sort((a, b) => Number(a) - Number(b));
    const online = s.players.filter((p) => p.online).length;
    app.innerHTML = `
    <h1>Host</h1>
    <img class="qr" src="/qr.svg" alt="QR code to join the quiz">
    <p class="url">${esc(s.url)}</p>
    <h2>Players (${online} online of ${s.players.length})</h2>
    <ul class="chips">${s.players.map((p) => `<li class="${p.online ? "" : "off"}">${esc(p.name)}${p.online ? "" : " (offline)"}</li>`).join("") || "<li class='muted'>Waiting for players\u2026</li>"}</ul>
    <h2>Answers</h2>
    ${puzzles.map((p) => `<div class="puzzle"><strong>Puzzle ${esc(p)}</strong><ul>${Object.entries(s.submissions[p]).map(([n, a]) => `<li>${esc(n)}: ${esc(a)}</li>`).join("")}</ul></div>`).join("") || "<p>No answers yet.</p>"}
    <p><button id="clear" class="quiet">Clear all answers</button></p>`;
    $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
  }
  if (!isHost) me ? app.innerHTML = "<p>Reconnecting\u2026</p>" : renderJoin();
  connect();
})();
