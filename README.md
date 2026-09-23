<div align="center">
  <img src="frontend/public/pydrop-logo-final-symbol.png" width="96" alt="PyDrop logo" />

  # PyDrop

  **Transferência direta de arquivos entre dispositivos.**
  Sem conta. Sem armazenamento permanente. Arquivos de até 500 MB.

  [![Frontend: Vue 3](https://img.shields.io/badge/frontend-Vue%203-42b883)](frontend)
  [![Backend: FastAPI](https://img.shields.io/badge/backend-FastAPI-009688)](backend)
  [![WebRTC](https://img.shields.io/badge/transfer-WebRTC%20P2P-blueviolet)](#como-o-backend-funciona)
  [![PWA](https://img.shields.io/badge/PWA-instal%C3%A1vel-orange)](#instalar-como-app-pwa)

  🔗 **[pydrop.vercel.app](https://pydrop.vercel.app)**
</div>

<br />

<table align="center">
<tr>
<td align="center" width="220">
  <img src="frontend/public/pydrop-qr.png" width="180" alt="QR code para abrir o PyDrop" />
  <br />
  <sub>Aponte a câmera para abrir o PyDrop<br/>e instalar como app (PWA)</sub>
</td>
</tr>
</table>

---

## O que é

PyDrop cria uma **sala temporária** com um código de 8 caracteres. Duas pessoas entram na mesma sala — uma pelo código, outra escaneando o QR — e os arquivos vão **direto de um navegador para o outro**, via WebRTC. O servidor nunca vê os bytes do arquivo: ele só ajuda os dois dispositivos a se encontrarem.

- 🔗 **Peer-to-peer real** — os dados trafegam direto entre os dispositivos (WebRTC DataChannel), não passam pelo backend.
- ⏳ **Sem persistência** — nada fica salvo em disco ou banco de dados; a sala expira em 1 hora.
- 📱 **PWA instalável** — funciona como app nativo em Android, iOS e desktop.
- 🌐 **Sem conta** — nenhum cadastro, nenhum login.
- 🔁 **Reconexão automática** — perdeu o Wi-Fi ou trocou de app no celular? A transferência tenta retomar sozinha.
- 🌍 **PT-BR / EN** — interface bilíngue nativa.

---

## Como funciona (visão geral)

```
┌──────────────┐        1. cria sala (POST /rooms)           ┌──────────────┐
│  Dispositivo │ ────────────────────────────────────────▶  │   Backend    │ 
│      A       │        2. troca de sinalização WebRTC       │              │
│  (navegador) │◀──────────────(WebSocket)────────────────▶ │  (FastAPI)   │
└──────┬───────┘                                             └──────────────┘
       │                                                            ▲
       │         3. conexão P2P direta estabelecida (WebRTC)        │
       │         ── os bytes do arquivo NUNCA passam por aqui ──    │
       ▼                                                            │
┌──────────────┐        2. troca de sinalização WebRTC              │
│  Dispositivo │◀───────────────(WebSocket)─────────────────────────┘
│      B       │
│  (navegador) │
└──────────────┘
```

1. O dispositivo A cria uma sala → o backend gera um código único e guarda em memória (com TTL de 1h).
2. Os dois dispositivos entram na mesma sala via **WebSocket** — é por esse canal que trocam as mensagens de sinalização do WebRTC (`offer`, `answer`, `ice-candidate`). O backend só **retransmite** essas mensagens; nunca as interpreta.
3. Assim que a negociação WebRTC termina, os navegadores abrem um **DataChannel direto** entre si. Daí em diante, o arquivo viaja em chunks de 64 KB direto de um dispositivo para o outro — o servidor fica de fora.
4. Quando a sala fica vazia ou expira, ela é limpa automaticamente da memória.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | Vue 3 (`<script setup>`, Composition API) + TypeScript + Vite |
| Sinalização / API | FastAPI (Python) + WebSocket |
| Transferência de arquivo | WebRTC DataChannel (P2P, direto entre navegadores) |
| Estado das salas | Em memória (dicionário Python, expira sozinho) |
| Métricas (opcional) | Upstash Redis — com fallback automático para contador local se não configurado |
| PWA | Service Worker + Web App Manifest |
| QR code (sala e instalação) | Canvas desenhado à mão (`qrcode` no frontend, sem lib de terceiros no runtime da UI) |

---

## Pré-requisitos

- **Node.js** `^22.18.0` ou `>=24.12.0`
- **Python** `3.11+`
- **npm** (vem com o Node)

---

## Rodando o projeto localmente

O projeto tem duas partes que rodam **separadamente**: o backend (FastAPI) e o frontend (Vite). Abra dois terminais.

### 1. Backend

```bash
cd backend

# cria e ativa o ambiente virtual
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Linux / macOS

# instala as dependências
pip install -r requirements.txt

# roda o servidor de desenvolvimento (porta 8000)
uvicorn app.main:app --reload --port 8000
```

O backend sobe em `http://127.0.0.1:8000`. Teste com:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

**Variáveis de ambiente (opcionais)** — crie `backend/.env` se precisar customizar:

```bash
# Origens extras liberadas no CORS, além de localhost e do domínio de produção
FRONTEND_ORIGIN=https://seu-dominio.com

# Contador de transferências compartilhado via Redis (Upstash).
# Se não configurar, o contador funciona localmente em memória.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

### 2. Frontend

```bash
cd frontend

# instala as dependências
npm install

# roda o servidor de desenvolvimento (porta 5173)
npm run dev
```

O frontend sobe em `http://localhost:5173` e já vem configurado (`vite.config.ts`) para fazer proxy de `/rooms` e `/health` para o backend local em `127.0.0.1:8000` — não precisa configurar nada a mais para desenvolver localmente.

Abra `http://localhost:5173` em duas abas (ou dois dispositivos na mesma rede) para testar uma transferência completa.

**Variáveis de ambiente** — copie o exemplo:

```bash
cp .env.example .env.local
```

```bash
# frontend/.env.local
VITE_API_URL=https://pydrop.onrender.com        # backend a ser usado (local: deixe vazio, o proxy do Vite cuida disso)
VITE_PUBLIC_APP_URL=https://pydrop.vercel.app    # URL usada para montar o link/QR de convite da sala

# TURN opcional, para redes muito restritivas onde o STUN público não basta
# VITE_TURN_URL=turn:seu-provedor.example:3478
# VITE_TURN_USERNAME=usuario-temporario
# VITE_TURN_CREDENTIAL=credencial-temporaria
```

### Outros comandos úteis (frontend)

```bash
npm run build         # build de produção (roda type-check + build)
npm run preview        # serve o build de produção localmente
npm run type-check     # apenas checagem de tipos (vue-tsc)
npm run format          # formata src/ com oxfmt
```

### Testes (backend)

```bash
cd backend
pytest tests/ -v
```

---

## Como o backend funciona

O backend é propositalmente pequeno: **ele nunca vê o conteúdo dos arquivos**, só existe para que dois navegadores se encontrem e negociem uma conexão direta.

### Rotas HTTP

| Rota | Método | O que faz |
|---|---|---|
| `/health` | `GET` | Health check simples, usado pelo frontend para "acordar" o servidor (planos free como o Render hibernam) |
| `/stats` | `GET` | Contador global de transferências concluídas (badge no rodapé do app) |
| `/rooms` | `POST` | Cria uma sala nova: gera um código de 8 caracteres (`A–Z`, `0–9`, sem ambiguidade) e devolve `{ "code": "ABC12XYZ" }`. Tem rate limit por IP (10 salas/minuto). |

### WebSocket — `/rooms/{code}/ws`

É aqui que a mágica acontece. Cada dispositivo que entra na sala abre uma conexão WebSocket com esse endpoint. O servidor:

1. Confere se a sala existe e não expirou (senão, fecha a conexão).
2. Limita cada sala a **no máximo 2 conexões simultâneas** (o terceiro dispositivo é recusado).
3. Avisa quem é o `initiator` (quem chegou primeiro) — é ele quem inicia a oferta WebRTC.
4. Retransmite (broadcast) as mensagens de sinalização entre os dois peers:
   - `offer` / `answer` — a negociação SDP do WebRTC
   - `ice-candidate` — os candidatos de rede para achar o melhor caminho P2P
   - `transfer-completed` — avisa que um arquivo terminou de chegar (usado só para as métricas, com deduplicação por `transfer_id` para não contar a mesma transferência duas vezes)
5. Valida e limita a taxa de mensagens (proteção contra flood: no máximo 150 mensagens de sinalização a cada 10s, mensagens até 64 KB).
6. Quando um dos dois sai, avisa o outro (`user_left`) e libera a vaga.

**O que o backend explicitamente *não* faz:** não guarda, não processa e não encaminha o conteúdo dos arquivos. Depois que a conexão WebRTC é estabelecida, o navegador de origem manda os bytes em chunks de 64 KB diretamente para o navegador de destino pelo `RTCDataChannel` — o backend fica de fora dessa parte inteira.

### Estado das salas

As salas vivem em um dicionário Python em memória (`backend/app/rooms.py`), sem banco de dados:

```python
rooms["ABC12XYZ"] = {"code": "ABC12XYZ", "expires_at": 1234567890.0}
```

Uma tarefa em background (`cleanup_rooms_loop`) varre e remove salas expiradas a cada 60 segundos. Isso significa que **reiniciar o servidor limpa todas as salas** — comportamento esperado, já que elas são pensadas para durar no máximo 1 hora mesmo.

### Métricas

O contador de "transferências concluídas" (mostrado no rodapé do app) usa **Upstash Redis** quando configurado, para ser compartilhado entre todas as instâncias/usuários. Sem essa configuração, cai automaticamente para um contador local em memória — o app funciona normalmente de qualquer jeito, só perde a persistência do contador entre reinícios.

---

## Instalar como app (PWA)

O PyDrop é um Progressive Web App completo — dá para instalar e usar como um app nativo, sem passar pela loja de aplicativos.

1. Abra **[pydrop.vercel.app](https://pydrop.vercel.app)** no celular (ou escaneie o QR code no topo deste README).
2. **Android/Chrome:** toque no menu (⋮) → "Instalar aplicativo" (ou use o botão "Instalar app" que aparece no rodapé do PyDrop).
3. **iOS/Safari:** toque no ícone de compartilhar → "Adicionar à Tela de Início".
4. **Desktop (Chrome/Edge):** ícone de instalação na barra de endereço.

O Service Worker (`frontend/public/sw.js`) cacheia apenas o *app shell* (HTML/CSS/JS da interface) — nunca os arquivos transferidos, que nem chegam a passar pelo cache.

---

## Estrutura do projeto

```
PyDrop/
├── backend/
│   ├── app/
│   │   ├── main.py       # app FastAPI, rotas /health, /stats, /rooms, CORS
│   │   ├── rooms.py       # criação/expiração de salas (em memória)
│   │   ├── ws.py           # WebSocket de sinalização WebRTC
│   │   └── metrics.py     # contador de transferências (Redis ou local)
│   ├── tests/               # testes automatizados (pytest)
│   └── requirements.txt
│
└── frontend/
    ├── src/
    │   ├── App.vue                     # estado da aplicação e orquestração das telas
    │   ├── api.ts                        # comunicação com o backend + lógica WebRTC (DirectTransfer)
    │   ├── copy.ts                       # todos os textos da interface (PT/EN)
    │   └── components/
    │       ├── ConnectionField.vue       # animação da conexão entre os dois dispositivos
    │       ├── TransferDock.vue          # área de envio/recebimento de arquivos
    │       └── RoomQr.vue                # QR code da sala, desenhado com a marca no centro
    ├── public/                           # ícones, manifest, service worker
    └── package.json
```

---

## Deploy

O projeto está publicado em:

- **Frontend:** [Vercel](https://vercel.com) → `https://pydrop.vercel.app`
- **Backend:** [Render](https://render.com) → `https://pydrop.onrender.com`

> Planos gratuitos do Render hibernam após inatividade — por isso o app mostra a tela de "acordando o servidor" no primeiro acesso depois de um tempo parado.

---

<div align="center">
  <sub>Feito por <a href="https://github.com/Devgusta5">Devgusta5</a></sub>
</div>
