type Submissions = Record<string, Record<string, string>>;
type PlayerInfo = { name: string; online: boolean };
type Identity = { name: string; token: string };
type ServerMsg =
  | { type: "state"; url: string; players: PlayerInfo[]; submissions: Submissions; total: number; locked: number[] }
  | { type: "joined"; name: string; token: string; answers: Record<string, string>; total: number; locked: number[] }
  | { type: "config"; total: number; locked: number[] }
  | { type: "submitted"; puzzle: number; answer: string }
  | { type: "rejected"; message: string }
  | { type: "error"; message: string };

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
let selected = 1;

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
      applyConfig(msg.total, msg.locked);
      if (view !== "player") renderPlayer(); // on reconnect, leave what they're typing alone
      break;
    case "config":
      applyConfig(msg.total, msg.locked);
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
  selected = 1;
  app.innerHTML = `
    <h1>Hi, ${esc(me!.name)}</h1>
    <p>Work it out on paper, then pick a question and send your answer.</p>
    <div id="chips" class="qchips"></div>
    <form id="answer">
      <label><span id="qlabel"></span><input id="text" autocomplete="off" required></label>
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
    send({ type: "submit", puzzle: selected, answer: $<HTMLInputElement>("text").value });
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

function select(n: number) {
  selected = n;
  $<HTMLInputElement>("text").value = sent.get(String(n)) ?? "";
  renderChips();
  updateForm();
  if (!locked.has(n)) $<HTMLInputElement>("text").focus();
}

function applyConfig(t: number, l: number[]) {
  total = t;
  locked = new Set(l);
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
  const isLocked = locked.has(selected);
  $("qlabel").textContent = `Question ${selected}`;
  $<HTMLInputElement>("text").disabled = isLocked;
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
function renderHost(s: Extract<ServerMsg, { type: "state" }>) {
  const online = s.players.filter((p) => p.online).length;
  const lockedSet = new Set(s.locked);
  let questions = "";
  for (let n = 1; n <= s.total; n++) {
    const answers = Object.entries(s.submissions[String(n)] ?? {});
    questions += `<div class="puzzle">
      <div class="qhead"><strong>Question ${n}${lockedSet.has(n) ? " 🔒" : ""} <span class="muted">(${answers.length} answer${answers.length === 1 ? "" : "s"})</span></strong>
        <button class="quiet" data-lock="${n}" data-to="${!lockedSet.has(n)}">${lockedSet.has(n) ? "Unlock" : "Lock"}</button></div>
      <ul>${answers.map(([name, a]) => `<li>${esc(name)}: ${esc(a)}</li>`).join("")}</ul></div>`;
  }
  app.innerHTML = `
    <h1>Host</h1>
    <img class="qr" src="/qr.svg" alt="QR code to join the quiz">
    <p class="url">${esc(s.url)}</p>
    <h2>Players (${online} online of ${s.players.length})</h2>
    <ul class="chips">${s.players.map((p) => `<li class="${p.online ? "" : "off"}">${esc(p.name)}${p.online ? "" : " (offline)"}</li>`).join("") || "<li class='muted'>Waiting for players…</li>"}</ul>
    <h2>Questions</h2>
    <div class="stepper">
      <button class="quiet" id="dec" aria-label="Fewer questions" ${s.total <= 1 ? "disabled" : ""}>−</button>
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
  app.querySelectorAll<HTMLButtonElement>("button[data-lock]").forEach((b) => {
    b.onclick = () => send({ type: "set_lock", puzzle: Number(b.dataset.lock), locked: b.dataset.to === "true" });
  });
  $("clear").onclick = () => confirm("Clear all answers?") && send({ type: "clear" });
}

/* ---------- start ---------- */
if (!isHost) me ? (app.innerHTML = "<p>Reconnecting…</p>") : renderJoin();
connect();
