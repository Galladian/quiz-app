(() => {
  // src/main.ts
  var EMPTY = { text: "", kind: "text", options: [] };
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
  var questions = {};
  var selected = 1;
  var fieldKey = "";
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
        applyConfig(msg);
        if (view !== "player") renderPlayer();
        break;
      case "config":
        applyConfig(msg);
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
    app.innerHTML = `
    <h1>Hi, ${esc(me.name)}</h1>
    <p>Work it out on paper, then pick a question and send your answer.</p>
    <div id="chips" class="qchips"></div>
    <div id="qtext" class="qtext" hidden></div>
    <form id="answer">
      <div id="qlabel" class="qlabel"></div>
      <div id="field"></div>
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
      const q = currentQ();
      let answer;
      if (q.kind === "choice") {
        const picked = document.querySelector('input[name="choice"]:checked');
        if (!picked) return setStatus("Pick an option first.", true);
        answer = q.options[Number(picked.value)];
      } else {
        answer = $("text").value;
      }
      send({ type: "submit", puzzle: selected, answer });
    };
    $("leave").onclick = () => {
      if (!confirm("Leave the quiz as this player?")) return;
      send({ type: "leave" });
      me = null;
      saveIdentity(null);
      sent.clear();
      renderJoin();
    };
    selected = 1;
    select(1);
  }
  var currentQ = () => questions[String(selected)] ?? EMPTY;
  function select(n) {
    selected = n;
    fieldKey = "";
    renderChips();
    updateForm();
    const input = document.getElementById("text");
    if (input && !locked.has(n)) input.focus();
  }
  function applyConfig(c) {
    total = c.total;
    locked = new Set(c.locked);
    questions = c.questions;
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
    const q = currentQ();
    const isLocked = locked.has(selected);
    $("qlabel").textContent = `Question ${selected}`;
    const qt = $("qtext");
    qt.textContent = q.text;
    qt.hidden = !q.text;
    const key = `${selected}|${q.kind}|${q.options.join("")}`;
    if (key !== fieldKey) {
      fieldKey = key;
      const mine = sent.get(String(selected)) ?? "";
      $("field").innerHTML = q.kind === "choice" ? `<div class="opts-list" role="radiogroup" aria-label="Question ${selected} options">${q.options.map((o, i) => `<label class="opt"><input type="radio" name="choice" value="${i}" ${o === mine ? "checked" : ""}> <span>${esc(o)}</span></label>`).join("")}</div>` : `<label class="sr">Your answer <input id="text" autocomplete="off" required value="${esc(mine)}"></label>`;
    }
    $("field").querySelectorAll("input").forEach((i) => i.disabled = isLocked);
    $("send").disabled = isLocked;
    if (isLocked) setStatus(LOCK_NOTE, true);
    else if ($("status").textContent === LOCK_NOTE) setStatus("");
  }
  function setStatus(text, isError = false) {
    const el = $("status");
    el.textContent = text;
    el.className = isError ? "err" : "ok";
  }
  var hostBuilt = false;
  var hostTab = "answers";
  var panelTab = "";
  var lastState;
  var justSaved = /* @__PURE__ */ new Set();
  function renderHost(s) {
    lastState = s;
    if (!hostBuilt) buildHostShell(s);
    const online = s.players.filter((p) => p.online).length;
    $("playersTitle").textContent = `Players (${online} online of ${s.players.length})`;
    $("players").innerHTML = s.players.map((p) => `<li class="${p.online ? "" : "off"}">${esc(p.name)}${p.online ? "" : " (offline)"}</li>`).join("") || "<li class='muted'>Waiting for players\u2026</li>";
    renderPanel(s);
  }
  function buildHostShell(s) {
    hostBuilt = true;
    app.innerHTML = `
    <h1>Host</h1>
    <img class="qr" src="/qr.svg" alt="QR code to join the quiz">
    <p class="url">${esc(s.url)}</p>
    <h2 id="playersTitle"></h2>
    <ul class="chips" id="players"></ul>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="answers">Answers</button>
      <button role="tab" data-tab="edit">Edit questions</button>
    </div>
    <div id="panel" role="tabpanel"></div>`;
    app.querySelectorAll("button[data-tab]").forEach((b) => {
      b.onclick = () => {
        hostTab = b.dataset.tab;
        if (lastState) renderPanel(lastState);
      };
    });
  }
  function renderPanel(s) {
    app.querySelectorAll("button[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === hostTab)));
    if (panelTab !== hostTab) {
      panelTab = hostTab;
      if (hostTab === "edit") buildEditScaffold();
    }
    hostTab === "answers" ? renderAnswers(s) : renderEdit(s);
  }
  function renderAnswers(s) {
    const lockedSet = new Set(s.locked);
    let html = `<div class="stepper">
    <button class="quiet" id="lockall">Lock all</button>
    <button class="quiet" id="unlockall">Unlock all</button></div>`;
    for (let n = 1; n <= s.total; n++) {
      const q = s.questions[String(n)] ?? EMPTY;
      const answers = Object.entries(s.submissions[String(n)] ?? {});
      const tally = q.kind === "choice" ? `<ul class="chips">${q.options.map((o) => `<li>${esc(o)} (${answers.filter(([, a]) => a === o).length})</li>`).join("")}</ul>` : "";
      html += `<div class="puzzle">
      <div class="qhead"><strong>Question ${n}${lockedSet.has(n) ? " \u{1F512}" : ""} <span class="muted">(${answers.length} answer${answers.length === 1 ? "" : "s"})</span></strong>
        <button class="quiet" data-lock="${n}" data-to="${!lockedSet.has(n)}">${lockedSet.has(n) ? "Unlock" : "Lock"}</button></div>
      ${q.text ? `<p class="qsmall">${esc(q.text)}</p>` : ""}${tally}
      <ul>${answers.map(([name, a]) => `<li>${esc(name)}: ${esc(a)}</li>`).join("")}</ul></div>`;
    }
    html += `<p><button id="clear" class="quiet">Clear all answers</button></p>`;
    $("panel").innerHTML = html;
    $("lockall").onclick = () => send({ type: "lock_all", locked: true });
    $("unlockall").onclick = () => send({ type: "lock_all", locked: false });
    $("panel").querySelectorAll("button[data-lock]").forEach((b) => {
      b.onclick = () => send({ type: "set_lock", puzzle: Number(b.dataset.lock), locked: b.dataset.to === "true" });
    });
    $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
  }
  var optRow = (v) => `<div class="optrow"><input data-f="opt" maxlength="100" aria-label="Option" placeholder="Option" value="${esc(v)}"><button type="button" class="quiet" data-act="rm" aria-label="Remove option">\xD7</button></div>`;
  function cardHtml(n, q) {
    const rows = [...q.options];
    while (rows.length < 2) rows.push("");
    const saved = justSaved.delete(n) ? "Saved \u2713" : "";
    return `<strong>Question ${n}</strong>
    <textarea data-f="text" rows="2" aria-label="Text for question ${n}" placeholder="Question text players will see (optional)">${esc(q.text)}</textarea>
    <label>Answer type
      <select data-f="kind">
        <option value="text" ${q.kind === "text" ? "selected" : ""}>Short answer</option>
        <option value="choice" ${q.kind === "choice" ? "selected" : ""}>Multiple choice</option>
      </select></label>
    <div class="opts" ${q.kind === "choice" ? "" : "hidden"}>
      <div data-opts>${rows.map(optRow).join("")}</div>
      <button type="button" class="quiet" data-act="add">Add option</button>
    </div>
    <div><button type="button" data-act="save">Save</button> <span class="ok" data-status>${saved}</span></div>`;
  }
  function buildEditScaffold() {
    $("panel").innerHTML = `<div class="stepper" id="stepper"></div><div id="cards"></div>`;
    const cards = $("cards");
    cards.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const card = btn.closest(".card");
      const opts = card.querySelector("[data-opts]");
      if (btn.dataset.act === "add" && opts.children.length < 6) opts.insertAdjacentHTML("beforeend", optRow(""));
      else if (btn.dataset.act === "rm") btn.closest(".optrow").remove();
      else if (btn.dataset.act === "save") saveCard(card);
    });
    cards.addEventListener("change", (e) => {
      const sel = e.target;
      if (sel.dataset.f !== "kind") return;
      const card = sel.closest(".card");
      card.querySelector(".opts").hidden = sel.value !== "choice";
      const opts = card.querySelector("[data-opts]");
      while (opts.children.length < 2) opts.insertAdjacentHTML("beforeend", optRow(""));
    });
  }
  function saveCard(card) {
    const n = Number(card.dataset.card);
    const status = card.querySelector("[data-status]");
    const text = card.querySelector('[data-f="text"]').value;
    const kind = card.querySelector('[data-f="kind"]').value;
    const options = Array.from(card.querySelectorAll('[data-f="opt"]')).map((i) => i.value.trim()).filter(Boolean);
    if (kind === "choice" && new Set(options).size < 2) {
      status.className = "err";
      status.textContent = "Add at least two different options.";
      return;
    }
    justSaved.add(n);
    status.className = "ok";
    status.textContent = "Saved \u2713";
    send({ type: "set_question", puzzle: n, text, kind, options });
  }
  function renderEdit(s) {
    $("stepper").innerHTML = `
    <button class="quiet" id="dec" aria-label="Fewer questions" ${s.total <= 1 ? "disabled" : ""}>\u2212</button>
    <strong>${s.total} questions</strong>
    <button class="quiet" id="inc" aria-label="More questions" ${s.total >= 50 ? "disabled" : ""}>+</button>`;
    $("dec").onclick = () => send({ type: "set_total", total: s.total - 1 });
    $("inc").onclick = () => send({ type: "set_total", total: s.total + 1 });
    const cards = $("cards");
    Array.from(cards.children).forEach((el) => Number(el.dataset.card) > s.total && el.remove());
    for (let n = 1; n <= s.total; n++) {
      const q = s.questions[String(n)] ?? EMPTY;
      const key = JSON.stringify(q);
      let el = cards.querySelector(`[data-card="${n}"]`);
      if (!el) {
        el = document.createElement("div");
        el.className = "card";
        el.dataset.card = String(n);
        cards.appendChild(el);
      }
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.innerHTML = cardHtml(n, q);
      }
    }
  }
  if (!isHost) me ? app.innerHTML = "<p>Reconnecting\u2026</p>" : renderJoin();
  connect();
})();
