import io
import json
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
players: dict[str, WebSocket] = {}  # name -> live socket
submissions: dict[str, dict[str, str]] = {}  # puzzle -> {name: answer}
hosts: set[WebSocket] = set()


def snapshot() -> dict:
    return {
        "type": "state",
        "url": JOIN_URL,
        "players": sorted(players),
        "submissions": submissions,
    }


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
    name: str | None = None
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
                wanted = str(msg.get("name", "")).strip()[:20]
                if not wanted:
                    await ws.send_json({"type": "error", "message": "Enter a name."})
                elif wanted in players and players[wanted] is not ws:
                    await ws.send_json(
                        {"type": "error", "message": f'"{wanted}" is already taken.'}
                    )
                else:
                    name = wanted
                    players[name] = ws
                    await ws.send_json({"type": "joined", "name": name})
                    await push_to_hosts()

            elif kind == "submit" and name:
                puzzle = str(msg.get("puzzle", "")).strip()[:10]
                answer = str(msg.get("answer", "")).strip()[:200]
                if puzzle and answer:
                    submissions.setdefault(puzzle, {})[name] = answer
                    await ws.send_json(
                        {"type": "submitted", "puzzle": puzzle, "answer": answer}
                    )
                    await push_to_hosts()

            elif kind == "clear" and is_host:
                submissions.clear()
                await push_to_hosts()
    except WebSocketDisconnect:
        pass
    finally:
        hosts.discard(ws)
        if name and players.get(name) is ws:
            del players[name]
            await push_to_hosts()


app.mount("/static", StaticFiles(directory=STATIC), name="static")
