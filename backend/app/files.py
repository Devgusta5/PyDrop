"""Gerenciamento de arquivos: salvar no disco, baixar, expirar em 1h.

Conceitos novos:
- UploadFile: arquivo que o usuario mandou no FormData
- shutil.copyfileobj: copia em pedacos (buffer de 1MB)
- uuid.uuid4().hex: gera ID unico de 32 chars
- pathlib.Path: caminhos viram objetos (melhor que string)
"""
import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "storage"
LIFETIME_SECONDS = 3600  # 1 hora

# files["<id>"] = {id, original_name, path, size, expires_at}
files: dict[str, dict] = {}


async def save_upload(upload: UploadFile) -> str:
    """Salva o arquivo no disco e devolve o ID unico."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4().hex  # exemplo: "9f6c8a..." — 32 chars, praticamente unico
    dest = UPLOAD_DIR / file_id  # salva SEM extensao; a original fica no metadado

    with dest.open("wb") as out:
        shutil.copyfileobj(upload.file, out, length=1024 * 1024)

    size = dest.stat().st_size
    files[file_id] = {
        "id": file_id,
        "original_name": upload.filename or "arquivo",
        "path": dest,
        "size": size,
        "expires_at": time.time() + LIFETIME_SECONDS,
    }
    return file_id


def get_file(file_id: str) -> dict:
    """Busca metadados de um arquivo. 404 se nao existe ou expirou."""
    meta = files.get(file_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Arquivo nao encontrado ou expirado")
    if meta["expires_at"] < time.time():
        delete_file(file_id)
        raise HTTPException(status_code=404, detail="Arquivo expirado")
    return meta


def delete_file(file_id: str) -> None:
    """Apaga metadado + arquivo fisico do disco."""
    meta = files.pop(file_id, {})
    path = meta.get("path")
    if path:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass  # se nao der, segue o jogo


def cleanup_expired() -> int:
    """Apaga tudo que expirou. Devolve quantos apagou."""
    now = time.time()
    expired = [fid for fid, m in files.items() if m["expires_at"] < now]
    for fid in expired:
        delete_file(fid)
    return len(expired)