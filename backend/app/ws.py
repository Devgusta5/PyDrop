"""WebSocket used as the WebRTC signaling channel.

HTTP normal: você pergunta → o servidor responde → a ligação ACABA. 🤝
WebSocket: os dois continuam conectados e o servidor EMPURRA mudanças. 📲

Este arquivo decide 1 coisa só: o que acontece quando alguém
se conecta num room via WebSocket (tempo real).

The backend forwards only signaling messages (offer, answer and ICE
candidates). File bytes travel through the browser-to-browser data channel.
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import rooms as rooms_mod

router = APIRouter()
MAX_ROOM_CONNECTIONS = 2

# code -> set de conexões websocket ativas ("quem está ouvindo esse room")
room_connections: dict[str, set[WebSocket]] = {}


def _subscribe(code: str, ws: WebSocket) -> None:
    """Adiciona uma conexão à lista de quem escuta o room."""
    room_connections.setdefault(code, set()).add(ws)


def _unsubscribe(code: str, ws: WebSocket) -> None:
    """Remove uma conexão da lista (quando a aba é fechada)."""
    room_connections.get(code, set()).discard(ws)


async def _broadcast(code: str, message: dict, excluded: WebSocket | None = None) -> None:
    """Envia uma mensagem pra TODOS conectados. Conexão morta? remove da lista."""
    dead = []
    connections = room_connections.get(code, set()).copy()
    for ws in connections:
        if ws is excluded:
            continue
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _unsubscribe(code, ws)


def _sessions_count(code: str) -> int:
    """Quantas pessoas estão online nesse room agora."""
    return len(room_connections.get(code, set()))


@router.websocket("/rooms/{code}/ws")
async def handle_room_ws(ws: WebSocket, code: str) -> None:
    """Loop principal: fica ouvindo a conexão até alguém fechar. 🫀"""
    code = code.upper()
    rooms_mod.get_room(code)  # 404 se o room não existe ou expirou

    await ws.accept()
    if _sessions_count(code) >= MAX_ROOM_CONNECTIONS:
        await ws.close(code=1008, reason="Room already has two connected devices")
        return

    _subscribe(code, ws)
    sessions = _sessions_count(code)

    # O primeiro peer cria a oferta; later peers answer it.
    await ws.send_json({"type": "room_state", "sessions": sessions, "initiator": sessions == 1})
    if sessions > 1:
        await _broadcast(code, {"type": "user_joined", "sessions": sessions}, excluded=ws)

    # Manda pro recém-chegado: os arquivos que JÁ ESTAVAM no room
    room = rooms_mod.get_room(code)
    await ws.send_json(
        {"type": "initial_files", "file_ids": list(room["files"])}
    )

    # Fica ouvindo sinalizacao ate o cliente fechar a aba / cair a internet
    try:
        while True:
            message = await ws.receive_json()
            if message.get("type") in {"offer", "answer", "ice-candidate"}:
                await _broadcast(code, message, excluded=ws)
    except WebSocketDisconnect:
        pass
    finally:
        _unsubscribe(code, ws)
        await _broadcast(code, {"type": "user_left", "sessions": _sessions_count(code)})


