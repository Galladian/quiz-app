import io
import json
import secrets
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

PORT = 8000
STATIC = Path(__file__).parent / "static"


def lan_ip() -> str:
    """Find this machine's address on the local network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets are actually sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


JOIN_URL = f"http://{lan_ip()}:{PORT}/"

# --- game state (in memory; restarting the server resets everything) ---
# token -> {"name": str, "ws": live socket or None while the player is offline}
players: dict[str, dict] = {}
submissions: dict[str, dict[str, str]] = {}  # question -> {name: answer}
hosts: set[WebSocket] = set()
# Host-controlled. questions: n -> {"text": str, "kind": "text" | "choice", "options": [str]}
config: dict = {"total": 10, "locked": set(), "questions": {}}


def config_msg() -> dict:
    return {
        "type": "config",
        "total": config["total"],
        "locked": sorted(config["locked"]),
        "questions": {str(k): v for k, v in config["questions"].items()},
    }


def snapshot() -> dict:
    return {
        **config_msg(),
        "type": "state",
        "url": JOIN_URL,
        "players": sorted(
            ({"name": p["name"], "online": p["ws"] is not None} for p in players.values()),
            key=lambda p: p["name"].lower(),
        ),
        "submissions": submissions,
    }


async def push_to_hosts() -> None:
    for h in list(hosts):
        try:
            await h.send_json(snapshot())
        except Exception:
            hosts.discard(h)


async def push_config() -> None:
    """Tell the host screen and every connected player about a config change."""
    await push_to_hosts()
    for p in list(players.values()):
        if p["ws"] is not None:
            try:
                await p["ws"].send_json(config_msg())
            except Exception:
                pass


def clean_question(msg: dict) -> dict | None:
    """Validate a host-edited question. Returns None to mean 'empty, remove it'."""
    text = str(msg.get("text", "")).strip()[:1000]
    raw = msg.get("options") if isinstance(msg.get("options"), list) else []
    options: list[str] = []
    for o in raw:
        o = str(o).strip()[:100]
        if o and o not in options:
            options.append(o)
    options = options[:6]
    kind = "choice" if msg.get("kind") == "choice" and len(options) >= 2 else "text"
    if kind == "text" and not text:
        return None
    return {"text": text, "kind": kind, "options": options if kind == "choice" else []}


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"\nPlayers join at: {JOIN_URL}")
    print(f"Host screen:     {JOIN_URL}host\n")
    qr = qrcode.QRCode(border=1)
    qr.add_data(JOIN_URL)
    qr.print_ascii(invert=True)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def player_page():
    return FileResponse(STATIC / "index.html")


@app.get("/host")
async def host_page():
    return FileResponse(STATIC / "index.html")


@app.get("/qr.svg")
async def qr_svg():
    img = qrcode.make(JOIN_URL, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    token: str | None = None
    is_host = False
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")

            if kind == "host":
                is_host = True
                hosts.add(ws)
                await ws.send_json(snapshot())

            elif kind == "join":
                given = msg.get("token")
                given = given if isinstance(given, str) else None
                wanted = str(msg.get("name", "")).strip()[:20]

                if given not in players:  # new player (or server was restarted)
                    if not wanted:
                        await ws.send_json({"type": "error", "message": "Enter a name."})
                        continue
                    if any(p["name"].lower() == wanted.lower() for p in players.values()):
                        await ws.send_json(
                            {"type": "error", "message": f'"{wanted}" is already taken.'}
                        )
                        continue
                    given = secrets.token_urlsafe(12)
                    players[given] = {"name": wanted, "ws": None}

                token = given
                players[token]["ws"] = ws  # (re)attach this connection
                name = players[token]["name"]
                mine = {q: by[name] for q, by in submissions.items() if name in by}
                await ws.send_json(
                    {**config_msg(), "type": "joined", "name": name, "token": token, "answers": mine}
                )
                await push_to_hosts()

            elif kind == "submit" and token in players:
                name = players[token]["name"]
                try:
                    q = int(msg.get("puzzle"))
                except (TypeError, ValueError):
                    q = 0
                answer = str(msg.get("answer", "")).strip()[:200]
                question = config["questions"].get(q)
                if not 1 <= q <= config["total"]:
                    await ws.send_json({"type": "rejected", "message": "That question doesn't exist."})
                elif q in config["locked"]:
                    await ws.send_json({"type": "rejected", "message": f"Question {q} is locked."})
                elif question and question["kind"] == "choice" and answer not in question["options"]:
                    await ws.send_json({"type": "rejected", "message": "Pick one of the options."})
                elif answer:
                    submissions.setdefault(str(q), {})[name] = answer
                    await ws.send_json({"type": "submitted", "puzzle": q, "answer": answer})
                    await push_to_hosts()

            elif kind == "leave" and token in players:
                del players[token]
                token = None
                await push_to_hosts()

            elif kind == "set_total" and is_host:
                try:
                    config["total"] = max(1, min(50, int(msg.get("total"))))
                    await push_config()
                except (TypeError, ValueError):
                    pass

            elif kind == "set_lock" and is_host:
                try:
                    n = int(msg.get("puzzle"))
                except (TypeError, ValueError):
                    continue
                if msg.get("locked"):
                    config["locked"].add(n)
                else:
                    config["locked"].discard(n)
                await push_config()

            elif kind == "lock_all" and is_host:
                config["locked"] = (
                    set(range(1, config["total"] + 1)) if msg.get("locked") else set()
                )
                await push_config()

            elif kind == "set_question" and is_host:
                try:
                    n = int(msg.get("puzzle"))
                except (TypeError, ValueError):
                    continue
                cleaned = clean_question(msg)
                if cleaned:
                    config["questions"][n] = cleaned
                else:
                    config["questions"].pop(n, None)
                await push_config()

            elif kind == "clear" and is_host:
                submissions.clear()
                await push_to_hosts()
    except WebSocketDisconnect:
        pass
    finally:
        hosts.discard(ws)
        # Mark offline but keep the player, so they can reconnect and resume.
        if token in players and players[token]["ws"] is ws:
            players[token]["ws"] = None
            await push_to_hosts()


app.mount("/static", StaticFiles(directory=STATIC), name="static")
