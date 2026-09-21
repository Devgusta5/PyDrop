"""Rooms em memória: criar, buscar pelo código e adicionar arquivos.

Conceito-chave: um `room` é só um "grupo" que junta arquivos sob um código.
Aqui usamos um dict global (rooms) como "banco de dados em memória".
Vai embora quando o servidor reinicia — perfeito para arquivos que expiram.
"""
import secrets
import string

from fastapi import HTTPException

ROOM_CODE_LENGTH = 5
ALPHABET = string.ascii_uppercase + string.digits

# rooms["ABC12"] = {"code": "ABC12", "files": []}
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
    rooms[code] = {"code": code, "files": []}
    return rooms[code]


def get_room(code: str) -> dict:
    """Busca um room pelo código. Levanta 404 se não existir."""
    room = rooms.get(code.upper())
    if room is None:
        raise HTTPException(status_code=404, detail="Room não encontrado ou expirado")
    return room


def add_file_to_room(code: str, file_id: str) -> None:
    """Registra o id de um arquivo dentro do room (só o metadado)."""
    room = get_room(code)
    room["files"].append(file_id)
