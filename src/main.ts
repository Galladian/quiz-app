type Question = { text: string; kind: "text" | "choice"; options: string[] };
type Questions = Record<string, Question>;
type PlayerInfo = { name: string; online: boolean };
type Identity = { name: string; token: string };
type Config = { total: number; locked: number[]; questions: Questions };
type State = Config & { type: "state"; url: string; players: PlayerInfo[]; submissions: Record<string, Record<string, string>> };
type ServerMsg =
  | State
  | (Config & { type: "joined"; name: string; token: string; answers: Record<string, string> })
  | (Config & { type: "config" })
  | { type: "submitted"; puzzle: number; answer: string }
  | { type: "rejected"; message: string }
  | { type: "error"; message: string };

const EMPTY: Question = { text: "", kind: "text", options: [] };
const app = document.getElementById("app") as HTMLElement;
const net = document.getElementById("net") as HTMLElement;
const isHost = location.pathname.startsWith("/host");
const proto = location.protocol === "https:" ? "wss" : "ws";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- saved identity (survives refresh, closed tabs, phone restarts) ---------- */
const KEY = "quiz-id";
function loadIdentity(): Identity | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}
function saveIdentity(id: Identity | null) {
  try { id ? localStorage.setItem(KEY, JSON.stringify(id)) : localStorage.removeItem(KEY); } catch { /* private mode */ }
}

let me: Identity | null = isHost ? null : loadIdentity();
let view: "none" | "join" | "player" = "none";
const sent = new Map<string, string>(); // question number -> my saved answer
let total = 0;
let locked = new Set<number>();
let questions: Questions = {};
let selected = 1;
let fieldKey = "";

/* ---------- connection with auto-reconnect ---------- */
let ws: WebSocket | undefined;
let timer: number | undefined;
const send = (obj: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

function connect() {
  clearTimeout(timer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    net.hidden = true;
    if (isHost) send({ type: "host" });
    else if (me) send({ type: "join", name: me.name, token: me.token }); // resume
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
  ws.onclose = () => {
    net.hidden = false;
    timer = window.setTimeout(connect, 1500);
  };
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && connect());
window.addEventListener("online", connect);

function handle(msg: ServerMsg) {
  if (isHost) return msg.type === "state" ? renderHost(msg) : undefined;
  switch (msg.type) {
    case "joined":
      me = { name: msg.name, token: msg.token };
      saveIdentity(me);
      sent.clear();
      Object.entries(msg.answers).forEach(([p, a]) => sent.set(p, a));
      applyConfig(msg);
      if (view !== "player") renderPlayer(); // on reconnect, leave what they're typing alone
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

/* ---------- player ---------- */
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
    send({ type: "join", name: $<HTMLInputElement>("name").value });
  };
}

function renderPlayer() {
  view = "player";
  app.innerHTML = `
    <h1>Hi, ${esc(me!.name)}</h1>
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
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-n]");
    if (b) select(Number(b.dataset.n));
  };
  $("answer").onsubmit = (e) => {
    e.preventDefault();
    const q = currentQ();
    let answer: string;
    if (q.kind === "choice") {
      const picked = document.querySelector<HTMLInputElement>('input[name="choice"]:checked');
      if (!picked) return setStatus("Pick an option first.", true);
      answer = q.options[Number(picked.value)];
    } else {
      answer = $<HTMLInputElement>("text").value;
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

const currentQ = (): Question => questions[String(selected)] ?? EMPTY;

function select(n: number) {
  selected = n;
  fieldKey = ""; // force the answer field to rebuild for this question
  renderChips();
  updateForm();
  const input = document.getElementById("text") as HTMLInputElement | null;
  if (input && !locked.has(n)) input.focus();
}

function applyConfig(c: Config) {
  total = c.total;
  locked = new Set(c.locked);
  questions = c.questions;
  if (view !== "player") return;
  if (selected > total) return select(total); // host lowered the question count
  renderChips();
  updateForm();
}

function renderChips() {
  let html = "";
  for (let n = 1; n <= total; n++) {
    const isLocked = locked.has(n);
    const cls = ["q", n === selected ? "sel" : "", sent.has(String(n)) ? "done" : "", isLocked ? "lock" : ""].join(" ");
    const state = isLocked ? "locked" : sent.has(String(n)) ? "answered" : "open";
    html += `<button type="button" class="${cls}" data-n="${n}" aria-pressed="${n === selected}" aria-label="Question ${n}, ${state}">${n}${isLocked ? " 🔒" : sent.has(String(n)) ? " ✓" : ""}</button>`;
  }
  $("chips").innerHTML = html;
}

const LOCK_NOTE = "This question is locked by the host.";
function updateForm() {
  const q = currentQ();
  const isLocked = locked.has(selected);
  $("qlabel").textContent = `Question ${selected}`;
  const qt = $("qtext");
  qt.textContent = q.text;
  qt.hidden = !q.text;

  // Rebuild the answer field only when the question or its type/options change,
  // so a text edit elsewhere never wipes what the player is typing.
  const key = `${selected}|${q.kind}|${q.options.join("\u0001")}`;
  if (key !== fieldKey) {
    fieldKey = key;
    const mine = sent.get(String(selected)) ?? "";
    $("field").innerHTML =
      q.kind === "choice"
        ? `<div class="opts-list" role="radiogroup" aria-label="Question ${selected} options">${q.options
            .map((o, i) => `<label class="opt"><input type="radio" name="choice" value="${i}" ${o === mine ? "checked" : ""}> <span>${esc(o)}</span></label>`)
            .join("")}</div>`
        : `<label class="sr">Your answer <input id="text" autocomplete="off" required value="${esc(mine)}"></label>`;
  }
  $("field").querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.disabled = isLocked));
  $<HTMLButtonElement>("send").disabled = isLocked;
  if (isLocked) setStatus(LOCK_NOTE, true);
  else if ($("status").textContent === LOCK_NOTE) setStatus("");
}

function setStatus(text: string, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "err" : "ok";
}

/* ---------- host ---------- */
let hostBuilt = false;
let hostTab: "answers" | "edit" = "answers";
let panelTab: "" | "answers" | "edit" = "";
let lastState: State | undefined;
const justSaved = new Set<number>();

function renderHost(s: State) {
  lastState = s;
  if (!hostBuilt) buildHostShell(s);
  const online = s.players.filter((p) => p.online).length;
  $("playersTitle").textContent = `Players (${online} online of ${s.players.length})`;
  $("players").innerHTML =
    s.players.map((p) => `<li class="${p.online ? "" : "off"}">${esc(p.name)}${p.online ? "" : " (offline)"}</li>`).join("") ||
    "<li class='muted'>Waiting for players…</li>";
  renderPanel(s);
}

function buildHostShell(s: State) {
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
  app.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((b) => {
    b.onclick = () => {
      hostTab = b.dataset.tab as "answers" | "edit";
      if (lastState) renderPanel(lastState);
    };
  });
}

function renderPanel(s: State) {
  app.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === hostTab)));
  if (panelTab !== hostTab) {
    panelTab = hostTab;
    if (hostTab === "edit") buildEditScaffold();
  }
  hostTab === "answers" ? renderAnswers(s) : renderEdit(s);
}

/* --- answers tab: read-only view plus live locking --- */
function renderAnswers(s: State) {
  const lockedSet = new Set(s.locked);
  let html = `<div class="stepper">
    <button class="quiet" id="lockall">Lock all</button>
    <button class="quiet" id="unlockall">Unlock all</button></div>`;
  for (let n = 1; n <= s.total; n++) {
    const q = s.questions[String(n)] ?? EMPTY;
    const answers = Object.entries(s.submissions[String(n)] ?? {});
    const tally = q.kind === "choice"
      ? `<ul class="chips">${q.options.map((o) => `<li>${esc(o)} (${answers.filter(([, a]) => a === o).length})</li>`).join("")}</ul>`
      : "";
    html += `<div class="puzzle">
      <div class="qhead"><strong>Question ${n}${lockedSet.has(n) ? " 🔒" : ""} <span class="muted">(${answers.length} answer${answers.length === 1 ? "" : "s"})</span></strong>
        <button class="quiet" data-lock="${n}" data-to="${!lockedSet.has(n)}">${lockedSet.has(n) ? "Unlock" : "Lock"}</button></div>
      ${q.text ? `<p class="qsmall">${esc(q.text)}</p>` : ""}${tally}
      <ul>${answers.map(([name, a]) => `<li>${esc(name)}: ${esc(a)}</li>`).join("")}</ul></div>`;
  }
  html += `<p><button id="clear" class="quiet">Clear all answers</button></p>`;
  $("panel").innerHTML = html;
  $("lockall").onclick = () => send({ type: "lock_all", locked: true });
  $("unlockall").onclick = () => send({ type: "lock_all", locked: false });
  $("panel").querySelectorAll<HTMLButtonElement>("button[data-lock]").forEach((b) => {
    b.onclick = () => send({ type: "set_lock", puzzle: Number(b.dataset.lock), locked: b.dataset.to === "true" });
  });
  $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
}

/* --- edit tab: each question is its own card, updated individually so
       unsaved edits in one card survive saves and updates in another --- */
const optRow = (v: string) =>
  `<div class="optrow"><input data-f="opt" maxlength="100" aria-label="Option" placeholder="Option" value="${esc(v)}"><button type="button" class="quiet" data-act="rm" aria-label="Remove option">×</button></div>`;

function cardHtml(n: number, q: Question): string {
  const rows = [...q.options];
  while (rows.length < 2) rows.push("");
  const saved = justSaved.delete(n) ? "Saved ✓" : "";
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const card = btn.closest<HTMLElement>(".card")!;
    const opts = card.querySelector<HTMLElement>("[data-opts]")!;
    if (btn.dataset.act === "add" && opts.children.length < 6) opts.insertAdjacentHTML("beforeend", optRow(""));
    else if (btn.dataset.act === "rm") btn.closest(".optrow")!.remove();
    else if (btn.dataset.act === "save") saveCard(card);
  });
  cards.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.dataset.f !== "kind") return;
    const card = sel.closest<HTMLElement>(".card")!;
    card.querySelector<HTMLElement>(".opts")!.hidden = sel.value !== "choice";
    const opts = card.querySelector<HTMLElement>("[data-opts]")!;
    while (opts.children.length < 2) opts.insertAdjacentHTML("beforeend", optRow(""));
  });
}

function saveCard(card: HTMLElement) {
  const n = Number(card.dataset.card);
  const status = card.querySelector<HTMLElement>("[data-status]")!;
  const text = card.querySelector<HTMLTextAreaElement>('[data-f="text"]')!.value;
  const kind = card.querySelector<HTMLSelectElement>('[data-f="kind"]')!.value;
  const options = Array.from(card.querySelectorAll<HTMLInputElement>('[data-f="opt"]')).map((i) => i.value.trim()).filter(Boolean);
  if (kind === "choice" && new Set(options).size < 2) {
    status.className = "err";
    status.textContent = "Add at least two different options.";
    return;
  }
  justSaved.add(n);
  status.className = "ok";
  status.textContent = "Saved ✓";
  send({ type: "set_question", puzzle: n, text, kind, options });
}

function renderEdit(s: State) {
  $("stepper").innerHTML = `
    <button class="quiet" id="dec" aria-label="Fewer questions" ${s.total <= 1 ? "disabled" : ""}>−</button>
    <strong>${s.total} questions</strong>
    <button class="quiet" id="inc" aria-label="More questions" ${s.total >= 50 ? "disabled" : ""}>+</button>`;
  $("dec").onclick = () => send({ type: "set_total", total: s.total - 1 });
  $("inc").onclick = () => send({ type: "set_total", total: s.total + 1 });

  const cards = $("cards");
  Array.from(cards.children).forEach((el) => Number((el as HTMLElement).dataset.card) > s.total && el.remove());
  for (let n = 1; n <= s.total; n++) {
    const q = s.questions[String(n)] ?? EMPTY;
    const key = JSON.stringify(q);
    let el = cards.querySelector<HTMLElement>(`[data-card="${n}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "card";
      el.dataset.card = String(n);
      cards.appendChild(el);
    }
    if (el.dataset.key !== key) { // only redraw cards whose saved data changed
      el.dataset.key = key;
      el.innerHTML = cardHtml(n, q);
    }
  }
}

/* ---------- start ---------- */
if (!isHost) me ? (app.innerHTML = "<p>Reconnecting…</p>") : renderJoin();
connect();
