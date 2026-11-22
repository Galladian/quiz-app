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
  var total = 0;
  var locked = /* @__PURE__ */ new Set();
  var selected = 1;
  var texts = {};
  var savedTexts = {};
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
        applyConfig(msg.total, msg.locked, msg.texts);
        if (view !== "player") renderPlayer();
        break;
      case "config":
        applyConfig(msg.total, msg.locked, msg.texts);
        break;
      case "submitted":
        sent.set(String(msg.puzzle), msg.answer);
        renderChips();
        setStatus(`Saved your answer for question ${msg.puzzle}.`);
        break;
      case "rejected":
        setStatus(msg.message, true);
        break;
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
    selected = 1;
    app.innerHTML = `
    <h1>Hi, ${esc(me.name)}</h1>
    <p>Work it out on paper, then pick a question and send your answer.</p>
    <div id="chips" class="qchips"></div>
    <div id="qtext" class="qtext" hidden></div>
    <form id="answer">
      <label><span id="qlabel"></span><input id="text" autocomplete="off" required></label>
      <button id="send">Send answer</button>
      <div id="status" role="status"></div>
    </form>
    <p><button id="leave" class="quiet" type="button">Not you? Switch player</button></p>`;
    $("chips").onclick = (e) => {
      const b = e.target.closest("button[data-n]");
      if (b) select(Number(b.dataset.n));
    };
    $("answer").onsubmit = (e) => {
      e.preventDefault();
      send({ type: "submit", puzzle: selected, answer: $("text").value });
    };
    $("leave").onclick = () => {
      if (!confirm("Leave the quiz as this player?")) return;
      send({ type: "leave" });
      me = null;
      saveIdentity(null);
      sent.clear();
      renderJoin();
    };
    select(1);
  }
  function select(n) {
    selected = n;
    $("text").value = sent.get(String(n)) ?? "";
    renderChips();
    updateForm();
    if (!locked.has(n)) $("text").focus();
  }
  function applyConfig(t, l, tx) {
    total = t;
    locked = new Set(l);
    texts = tx;
    if (view !== "player") return;
    if (selected > total) return select(total);
    renderChips();
    updateForm();
  }
  function renderChips() {
    let html = "";
    for (let n = 1; n <= total; n++) {
      const isLocked = locked.has(n);
      const cls = ["q", n === selected ? "sel" : "", sent.has(String(n)) ? "done" : "", isLocked ? "lock" : ""].join(" ");
      const state = isLocked ? "locked" : sent.has(String(n)) ? "answered" : "open";
      html += `<button type="button" class="${cls}" data-n="${n}" aria-pressed="${n === selected}" aria-label="Question ${n}, ${state}">${n}${isLocked ? " \u{1F512}" : sent.has(String(n)) ? " \u2713" : ""}</button>`;
    }
    $("chips").innerHTML = html;
  }
  var LOCK_NOTE = "This question is locked by the host.";
  function updateForm() {
    const isLocked = locked.has(selected);
    $("qlabel").textContent = `Question ${selected}`;
    const qt = $("qtext");
    qt.textContent = texts[String(selected)] ?? "";
    qt.hidden = !qt.textContent;
    $("text").disabled = isLocked;
    $("send").disabled = isLocked;
    if (isLocked) setStatus(LOCK_NOTE, true);
    else if ($("status").textContent === LOCK_NOTE) setStatus("");
  }
  function setStatus(text, isError = false) {
    const el = $("status");
    el.textContent = text;
    el.className = isError ? "err" : "ok";
  }
  function renderHost(s) {
    const drafts = /* @__PURE__ */ new Map();
    app.querySelectorAll("textarea[data-q]").forEach((t) => {
      if (t.value !== (savedTexts[t.dataset.q] ?? "")) drafts.set(t.dataset.q, t.value);
    });
    const active = document.activeElement;
    const focusQ = active?.dataset?.q;
    const selStart = active?.selectionStart ?? 0;
    const selEnd = active?.selectionEnd ?? 0;
    savedTexts = s.texts;
    const online = s.players.filter((p) => p.online).length;
    const lockedSet = new Set(s.locked);
    let questions = "";
    for (let n = 1; n <= s.total; n++) {
      const answers = Object.entries(s.submissions[String(n)] ?? {});
      questions += `<div class="puzzle">
      <div class="qhead"><strong>Question ${n}${lockedSet.has(n) ? " \u{1F512}" : ""} <span class="muted">(${answers.length} answer${answers.length === 1 ? "" : "s"})</span></strong>
        <button class="quiet" data-lock="${n}" data-to="${!lockedSet.has(n)}">${lockedSet.has(n) ? "Unlock" : "Lock"}</button></div>
      <textarea data-q="${n}" rows="2" aria-label="Text for question ${n}" placeholder="Question text players will see (optional)">${esc(s.texts[String(n)] ?? "")}</textarea>
      <button class="quiet" data-save="${n}">Save text</button>
      <ul>${answers.map(([name, a]) => `<li>${esc(name)}: ${esc(a)}</li>`).join("")}</ul></div>`;
    }
    app.innerHTML = `
    <h1>Host</h1>
    <img class="qr" src="/qr.svg" alt="QR code to join the quiz">
    <p class="url">${esc(s.url)}</p>
    <h2>Players (${online} online of ${s.players.length})</h2>
    <ul class="chips">${s.players.map((p) => `<li class="${p.online ? "" : "off"}">${esc(p.name)}${p.online ? "" : " (offline)"}</li>`).join("") || "<li class='muted'>Waiting for players\u2026</li>"}</ul>
    <h2>Questions</h2>
    <div class="stepper">
      <button class="quiet" id="dec" aria-label="Fewer questions" ${s.total <= 1 ? "disabled" : ""}>\u2212</button>
      <strong>${s.total} questions</strong>
      <button class="quiet" id="inc" aria-label="More questions" ${s.total >= 50 ? "disabled" : ""}>+</button>
      <button class="quiet" id="lockall">Lock all</button>
      <button class="quiet" id="unlockall">Unlock all</button>
    </div>
    ${questions}
    <p><button id="clear" class="quiet">Clear all answers</button></p>`;
    $("dec").onclick = () => send({ type: "set_total", total: s.total - 1 });
    $("inc").onclick = () => send({ type: "set_total", total: s.total + 1 });
    $("lockall").onclick = () => send({ type: "lock_all", locked: true });
    $("unlockall").onclick = () => send({ type: "lock_all", locked: false });
    app.querySelectorAll("button[data-lock]").forEach((b) => {
      b.onclick = () => send({ type: "set_lock", puzzle: Number(b.dataset.lock), locked: b.dataset.to === "true" });
    });
    app.querySelectorAll("button[data-save]").forEach((b) => {
      b.onclick = () => {
        const q = b.dataset.save;
        const t = app.querySelector(`textarea[data-q="${q}"]`);
        send({ type: "set_text", puzzle: Number(q), text: t.value });
      };
    });
    $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
    drafts.forEach((v, q) => app.querySelector(`textarea[data-q="${q}"]`).value = v);
    if (focusQ) {
      const t = app.querySelector(`textarea[data-q="${focusQ}"]`);
      t?.focus();
      t?.setSelectionRange(selStart, selEnd);
    }
  }
  if (!isHost) me ? app.innerHTML = "<p>Reconnecting\u2026</p>" : renderJoin();
  connect();
})();
