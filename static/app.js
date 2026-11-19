(() => {
  // src/main.ts
  var app = document.getElementById("app");
  var isHost = location.pathname.startsWith("/host");
  var proto = location.protocol === "https:" ? "wss" : "ws";
  var ws;
  var myName = sessionStorage.getItem("quiz-name") ?? "";
  var joined = false;
  var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  var $ = (id) => document.getElementById(id);
  function connect() {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      if (isHost) send({ type: "host" });
      else if (myName) send({ type: "join", name: myName });
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => setTimeout(connect, 1500);
  }
  function handle(msg) {
    if (isHost && msg.type === "state") return renderHost(msg);
    if (isHost) return;
    switch (msg.type) {
      case "joined":
        myName = msg.name;
        sessionStorage.setItem("quiz-name", myName);
        joined = true;
        renderPlayer();
        break;
      case "submitted":
        sent.set(msg.puzzle, msg.answer);
        renderPlayer(`Sent answer for puzzle ${msg.puzzle}.`);
        break;
      case "error":
        sessionStorage.removeItem("quiz-name");
        myName = "";
        joined = false;
        renderJoin(msg.message);
        break;
    }
  }
  var sent = /* @__PURE__ */ new Map();
  function renderJoin(error = "") {
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
  function renderPlayer(status = "") {
    const lastPuzzle = [...sent.keys()].pop();
    const next = lastPuzzle ? String(Number(lastPuzzle) + 1 || "") : "1";
    app.innerHTML = `
    <h1>Hi, ${esc(myName)}</h1>
    <p>Work it out on paper, then send your answer here.</p>
    <form id="answer">
      <label>Puzzle number <input id="puzzle" inputmode="numeric" value="${esc(next)}" required></label>
      <label>Your answer <input id="text" autocomplete="off" required></label>
      <button>Send answer</button>
      <div class="ok" role="status">${esc(status)}</div>
    </form>
    ${sent.size ? `<h2>Sent so far</h2><ul>${[...sent].map(([p, a]) => `<li>Puzzle ${esc(p)}: ${esc(a)}</li>`).join("")}</ul>` : ""}`;
    $("answer").onsubmit = (e) => {
      e.preventDefault();
      send({ type: "submit", puzzle: $("puzzle").value, answer: $("text").value });
    };
    $("text").focus();
  }
  function renderHost(s) {
    const puzzles = Object.keys(s.submissions).sort((a, b) => Number(a) - Number(b));
    app.innerHTML = `
    <h1>Host</h1>
    <img class="qr" src="/qr.svg" alt="QR code to join the quiz">
    <p class="url">${esc(s.url)}</p>
    <h2>Players (${s.players.length})</h2>
    <ul class="chips">${s.players.map((p) => `<li>${esc(p)}</li>`).join("") || "<li class='muted'>Waiting for players\u2026</li>"}</ul>
    <h2>Answers</h2>
    ${puzzles.map((p) => `<div class="puzzle"><strong>Puzzle ${esc(p)}</strong><ul>${Object.entries(s.submissions[p]).map(([n, a]) => `<li>${esc(n)}: ${esc(a)}</li>`).join("")}</ul></div>`).join("") || "<p>No answers yet.</p>"}
    <p><button id="clear" class="quiet">Clear all answers</button></p>`;
    $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
  }
  if (!isHost) myName ? (joined = false, app.innerHTML = "<p>Connecting\u2026</p>") : renderJoin();
  connect();
})();
