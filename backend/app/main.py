"""PyDrop backend — o ponto de partida do servidor.

O que este arquivo faz:
1. Cria o app FastAPI
2. Liga as rotas (rooms, arquivos)
3. Liga o WebSocket (tempo real entre os 2 browsers)
4. Liga o CORS (deixar o frontend Vue falar com a gente)
5. Agenda a limpeza de arquivos expirados
"""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import files as files_mod
from . import rooms as rooms_mod
from .ws import router as ws_router

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "storage"


async def cleanup_loop():
    """Roda pra sempre, de tempos em tempos, apagando o que expirou."""
    while True:
        await asyncio.sleep(60)  # checa a cada 1 minuto
        removed = files_mod.cleanup_expired()
        if removed:
            print(f"[cleanup] {removed} arquivo(s) expirado(s) removidos")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Roda uma vez quando o servidor sobe e uma vez quando ele desce."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(cleanup_loop())  # inicia o "vigia" de expiração
    yield
    task.cancel()  # quando o servidor descer, para o vigia


app = FastAPI(title="PyDrop", lifespan=lifespan)

# CORS — por enquanto liberado pra qualquer origem (fácil pros testes de dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)


@app.get("/health")
def health():
    return {"message": "PyDrop ta on Lil Cria"}


@app.post("/rooms")
def create_room():
    """Cria um room novo e devolve o código pra compartilhar."""
    room = rooms_mod.create_room()
    return {"code": room["code"]}


@app.post("/rooms/{code}/files")
async def upload_file(code: str, file: UploadFile = File(...)):
    """Recebe um arquivo, salva no disco, registra no room."""
    room = rooms_mod.get_room(code)  # 404 se o room não existe
    if all(f["code"] != code for f in []):  # TODO: validação temporária
        pass
    file_id = await files_mod.save_upload(file)
    rooms_mod.add_file_to_room(code, file_id)
    return {
        "id": file_id,
        "size": files_mod.files[file_id]["size"],
        "expires_in": files_mod.LIFETIME_SECONDS,
    }


@app.get("/rooms/{code}")
def get_room(code: str):
    """Devolve os metadados do room (código + lista de arquivos)."""
    room = rooms_mod.get_room(code)
    file_list = []
    for fid in room["files"]:
        meta = files_mod.files.get(fid)
        if meta:
            file_list.append(
                {
                    "id": meta["id"],
                    "name": meta["original_name"],
                    "size": meta["size"],
                    "expires_in": round(meta["expires_at"] - __import__("time").time()),
                }
            )
    return {"code": room["code"], "files": file_list}


@app.get("/files/{file_id}")
def download_file(file_id: str):
    """Baixa um arquivo pelo ID. Devolve o arquivo pro navegador."""
    meta = files_mod.get_file(file_id)
    return FileResponse(
        path=meta["path"],
        filename=meta["original_name"],
        media_type="application/octet-stream",
    )
