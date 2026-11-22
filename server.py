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
submissions: dict[str, dict[str, str]] = {}  # puzzle -> {name: answer}
hosts: set[WebSocket] = set()
config = {"total": 10, "locked": set(), "texts": {}}  # host-controlled: count, locks, question text


def texts() -> dict:
    return {str(k): v for k, v in config["texts"].items()}


def snapshot() -> dict:
    return {
        "type": "state",
        "url": JOIN_URL,
        "players": sorted(
            ({"name": p["name"], "online": p["ws"] is not None} for p in players.values()),
            key=lambda p: p["name"].lower(),
        ),
        "submissions": submissions,
        "total": config["total"],
        "locked": sorted(config["locked"]),
        "texts": texts(),
    }


def config_msg() -> dict:
    return {
        "type": "config",
        "total": config["total"],
        "locked": sorted(config["locked"]),
        "texts": texts(),
    }


async def push_config() -> None:
    """Tell the host screen and every connected player about a config change."""
    await push_to_hosts()
    for p in list(players.values()):
        if p["ws"] is not None:
            try:
                await p["ws"].send_json(config_msg())
            except Exception:
                pass


async def push_to_hosts() -> None:
    for h in list(hosts):
        try:
            await h.send_json(snapshot())
        except Exception:
            hosts.discard(h)


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
                mine = {pz: by[name] for pz, by in submissions.items() if name in by}
                await ws.send_json(
                    {
                        "type": "joined",
                        "name": name,
                        "token": token,
                        "answers": mine,
                        "total": config["total"],
                        "locked": sorted(config["locked"]),
                        "texts": texts(),
                    }
                )
                await push_to_hosts()

            elif kind == "submit" and token in players:
                name = players[token]["name"]
                try:
                    puzzle = int(msg.get("puzzle"))
                except (TypeError, ValueError):
                    puzzle = 0
                answer = str(msg.get("answer", "")).strip()[:200]
                if not 1 <= puzzle <= config["total"]:
                    await ws.send_json({"type": "rejected", "message": "That question doesn't exist."})
                elif puzzle in config["locked"]:
                    await ws.send_json(
                        {"type": "rejected", "message": f"Question {puzzle} is locked."}
                    )
                elif answer:
                    submissions.setdefault(str(puzzle), {})[name] = answer
                    await ws.send_json(
                        {"type": "submitted", "puzzle": puzzle, "answer": answer}
                    )
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

            elif kind == "set_text" and is_host:
                try:
                    n = int(msg.get("puzzle"))
                except (TypeError, ValueError):
                    continue
                text = str(msg.get("text", "")).strip()[:1000]
                if text:
                    config["texts"][n] = text
                else:
                    config["texts"].pop(n, None)
                await push_config()

            elif kind == "lock_all" and is_host:
                config["locked"] = (
                    set(range(1, config["total"] + 1)) if msg.get("locked") else set()
                )
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
