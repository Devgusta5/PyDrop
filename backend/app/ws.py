"""WebSocket: a conexão em tempo real entre os dois navegadores. 📡

HTTP normal: você pergunta → o servidor responde → a ligação ACABA. 🤝
WebSocket: os dois continuam conectados e o servidor EMPURRA mudanças. 📲

Este arquivo decide 1 coisa só: o que acontece quando alguém
se conecta num room via WebSocket (tempo real).

2 jobs:
1. Ao entrar, avisa quem já tava: "chegou mais um" → atualiza contador
2. Quando um arquivo chega (upload de outra pessoa), avisa o browser
   do outro lado: "tem arquivo novo" → ele mostra instantaneamente
"""
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import rooms as rooms_mod

router = APIRouter()

# code -> set de conexões websocket ativas ("quem está ouvindo esse room")
room_connections: dict[str, set[WebSocket]] = {}


def _subscribe(code: str, ws: WebSocket) -> None:
    """Adiciona uma conexão à lista de quem escuta o room."""
    room_connections.setdefault(code, set()).add(ws)


def _unsubscribe(code: str, ws: WebSocket) -> None:
    """Remove uma conexão da lista (quando a aba é fechada)."""
    room_connections.get(code, set()).discard(ws)


async def _broadcast(code: str, message: dict) -> None:
    """Envia uma mensagem pra TODOS conectados. Conexão morta? remove da lista."""
    dead = []
    connections = room_connections.get(code, set()).copy()
    for ws in connections:
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
    _subscribe(code, ws)

    # Avisa quem já estava: "chegou mais um" → seu contador atualiza
    await _broadcast(code, {"type": "user_joined", "sessions": _sessions_count(code)})

    # Manda pro recém-chegado: os arquivos que JÁ ESTAVAM no room
    room = rooms_mod.get_room(code)
    await ws.send_json(
        {"type": "initial_files", "file_ids": list(room["files"])}
    )

    # Fica ouvindo a conexão até o cliente fechar a aba / cair a internet
    try:
        while True:
            await ws.receive_text()  # só pra detectar que continua vivo (ping)
    except WebSocketDisconnect:
        pass
    finally:
        _unsubscribe(code, ws)
        await _broadcast(code, {"type": "user_left", "sessions": _sessions_count(code)})


async def notify_file_added(code: str, file_id: str) -> None:
    """Diz pra todo mundo do room: 'chegou um arquivo novo, aqui está o ID'."""
    await _broadcast(code, {"type": "file_added", "file_id": file_id})
