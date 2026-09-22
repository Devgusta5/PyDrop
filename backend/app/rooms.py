"""Rooms em memória: criar e buscar pelo código.

Conceito-chave: um `room` é só um "grupo" temporário que une dois dispositivos
sob um código. Nenhum arquivo passa por aqui — os bytes vão direto de browser
para browser pelo WebRTC DataChannel.
Aqui usamos um dict global (rooms) como "banco de dados em memória".
Vai embora quando o servidor reinicia — perfeito para arquivos que expiram.
"""
import secrets
import string
import time

from fastapi import HTTPException

ROOM_CODE_LENGTH = 8
ALPHABET = string.ascii_uppercase + string.digits
ROOM_LIFETIME_SECONDS = 60 * 60

# rooms["ABC12"] = {"code": "ABC12", "expires_at": 1234.5}
rooms: dict[str, dict] = {}


def generate_code() -> str:
    """Gera um código tipo 'ABC12'. Letras + números, sem caracteres confusos."""
    return "".join(secrets.choice(ALPHABET) for _ in range(ROOM_CODE_LENGTH))


def create_room() -> dict:
    """Cria um room e devolve o dict. Garante que o código seja único."""
    while True:
        code = generate_code()
        if code not in rooms:
            break
    rooms[code] = {
        "code": code,
        "expires_at": time.time() + ROOM_LIFETIME_SECONDS,
    }
    return rooms[code]


def get_room(code: str) -> dict:
    """Busca um room pelo código. Levanta 404 se não existir."""
    room = rooms.get(code.upper())
    if room is None or room["expires_at"] <= time.time():
        rooms.pop(code.upper(), None)
        raise HTTPException(status_code=404, detail="Room não encontrado ou expirado")
    return room


def cleanup_expired() -> int:
    """Remove salas expiradas e devolve quantas foram removidas."""
    now = time.time()
    expired_codes = [code for code, room in rooms.items() if room["expires_at"] <= now]
    for code in expired_codes:
        rooms.pop(code, None)
    return len(expired_codes)

