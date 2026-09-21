"""PyDrop backend — room creation and WebRTC signaling.

O que este arquivo faz:
1. Cria o app FastAPI
2. Liga a rota de rooms
3. Liga o WebSocket (sinalizacao WebRTC entre os 2 browsers)
4. Liga o CORS (deixar o frontend Vue falar com a gente)
"""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import rooms as rooms_mod
from .ws import router as ws_router

async def cleanup_rooms_loop():
    while True:
        await asyncio.sleep(60)
        rooms_mod.cleanup_expired()


@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup_task = asyncio.create_task(cleanup_rooms_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()


app = FastAPI(title="PyDrop", lifespan=lifespan)

default_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://pydrop.vercel.app",
]
configured_origins = os.getenv("FRONTEND_ORIGIN", "")
allowed_origins = default_origins + [
    origin.strip()
    for origin in configured_origins.split(",")
    if origin.strip() and origin.strip() not in default_origins
]

# CORS is restricted to known frontend origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/rooms")
def create_room():
    """Cria um room novo e devolve o código pra compartilhar."""
    room = rooms_mod.create_room()
    return {"code": room["code"]}


