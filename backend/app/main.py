"""PyDrop backend — room creation and WebRTC signaling.

O que este arquivo faz:
1. Cria o app FastAPI
2. Liga a rota de rooms
3. Liga o WebSocket (sinalizacao WebRTC entre os 2 browsers)
4. Liga o CORS (deixar o frontend Vue falar com a gente)
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import rooms as rooms_mod
from .ws import router as ws_router

app = FastAPI(title="PyDrop")

frontend_origin = os.getenv("FRONTEND_ORIGIN", "*")
allowed_origins = [origin.strip() for origin in frontend_origin.split(",") if origin.strip()]

# CORS — por enquanto liberado pra qualquer origem (fácil pros testes de dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)


@app.get("/health")
def health():
    return {"message": "PyDrop ta on Lil Bro"}


@app.post("/rooms")
def create_room():
    """Cria um room novo e devolve o código pra compartilhar."""
    room = rooms_mod.create_room()
    return {"code": room["code"]}


