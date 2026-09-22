# PyDrop — contexto temporário para Claude

> **Documento temporário:** este arquivo foi criado para fornecer contexto completo a agentes de IA, especialmente Claude. Ele pode ficar desatualizado conforme o projeto evoluir e não deve ser considerado a documentação pública definitiva do PyDrop.

## 1. Visão geral

PyDrop é uma aplicação web para transferir arquivos diretamente entre dois dispositivos.

O objetivo principal é permitir que uma pessoa abra uma sala no computador, entre nessa mesma sala pelo celular usando código ou QR Code e envie arquivos sem criar conta e sem armazenar o arquivo no backend.

Arquitetura atual:

```text
Frontend Vue/Vercel
        │
        │ HTTP: saúde, criação de sala e estatísticas
        │ WebSocket: sinalização WebRTC
        ▼
Backend FastAPI/Render
        │
        │ somente offer, answer, ICE e eventos pequenos
        ▼
Browser A ═══════ WebRTC DataChannel ═══════ Browser B
                         │
                         └── bytes do arquivo
```

O backend **não recebe, salva ou retransmite os bytes dos arquivos**. O arquivo viaja diretamente entre os navegadores pelo WebRTC DataChannel.

## 2. Estado atual importante

- Frontend: Vue 3 + TypeScript + Vite.
- Backend: FastAPI + Uvicorn.
- Sinalização: WebSocket.
- Transferência: WebRTC `RTCDataChannel`.
- QR Code de geração: pacote `qrcode`.
- QR Code de leitura pela câmera: pacote `qr-scanner`.
- Animação/ambiente visual: Three.js.
- Contador global de transferências: Upstash Redis opcional.
- Salas: dicionário em memória.
- Persistência de arquivos: não existe.
- Banco de dados: não existe.
- Limite por sala: dois WebSockets/dispositivos.
- Expiração de sala: 3.600 segundos, ou uma hora.
- Limite de arquivo: 500 MiB por arquivo.
- Idioma inicial: português (`pt`); inglês também está disponível.

## 3. Estrutura do projeto

```text
PyDrop/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── metrics.py
│   │   ├── rooms.py
│   │   └── ws.py
│   ├── tests/
│   │   └── test_rooms.py
│   └── requirements.txt
├── frontend/
│   ├── public/
│   │   ├── pydrop-icon-192.png
│   │   └── pydrop-logo-final-symbol.png
│   ├── src/
│   │   ├── App.vue
│   │   ├── api.ts
│   │   ├── main.ts
│   │   ├── assets/
│   │   │   ├── base.css
│   │   │   └── main.css
│   │   ├── components/
│   │   │   ├── HelloWorld.vue
│   │   │   ├── TheWelcome.vue
│   │   │   ├── WelcomeItem.vue
│   │   │   └── icons/
│   │   ├── router/
│   │   │   └── index.ts
│   │   └── views/
│   │       ├── AboutView.vue
│   │       └── HomeView.vue
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.ts
└── README_CLAUDE_TEMPORARY.md
```

Os componentes `HelloWorld.vue`, `TheWelcome.vue`, `WelcomeItem.vue`, os ícones padrão do Vue e `AboutView.vue` vieram do template inicial do Vue. A tela principal real é implementada em `App.vue`; esses arquivos ainda são referenciados pelo router/template e não devem ser removidos sem revisar o router.

## 4. Backend

### `backend/app/main.py`

Cria a aplicação FastAPI:

- cria `app = FastAPI(...)`;
- inicia e encerra o loop de limpeza de salas usando `lifespan`;
- configura CORS;
- inclui o router WebSocket;
- expõe `GET /health`;
- expõe `GET /stats`;
- expõe `POST /rooms`;
- aplica rate limit para criação de salas.

### Rotas HTTP

#### `GET /health`

Endpoint simples de disponibilidade:

```json
{"status": "ok"}
```

Não consulta Redis, banco ou qualquer serviço externo.

#### `POST /rooms`

Cria uma sala e retorna:

```json
{"code": "ABC12345"}
```

O código tem oito caracteres em letras maiúsculas e números.

O endpoint limita tentativas de criação por endereço IP:

- máximo de 10 tentativas;
- janela de 60 segundos;
- resposta `429` quando excedido.

#### `GET /stats`

Retorna a quantidade global de transferências concluídas:

```json
{"completed_transfers": 0}
```

Se Redis estiver configurado, lê do Redis. Sem Redis, usa um contador em memória apenas para desenvolvimento.

### `backend/app/rooms.py`

Mantém as salas no dicionário global `rooms`.

Estrutura aproximada:

```python
rooms[code] = {
    "code": code,
    "files": [],
    "expires_at": timestamp,
}
```

Apesar do nome `files`, atualmente nenhum arquivo é salvo. A lista é legado do desenho inicial e contém apenas IDs/metadados antigos, não bytes.

Responsabilidades:

- gerar código seguro com `secrets`;
- criar sala;
- buscar sala;
- rejeitar sala inexistente ou expirada;
- remover salas expiradas;
- expirar depois de `ROOM_LIFETIME_SECONDS = 60 * 60`.

Se o processo Render reiniciar, as salas em memória desaparecem.

### `backend/app/ws.py`

Implementa o endpoint:

```text
WS /rooms/{code}/ws
```

Fluxo:

1. valida se a sala existe;
2. aceita o WebSocket;
3. rejeita o terceiro dispositivo com close code `1008`;
4. registra a conexão no conjunto `room_connections`;
5. envia `room_state`;
6. envia `initial_files`;
7. encaminha mensagens válidas para os outros peers;
8. remove a conexão quando ela fecha;
9. envia `user_left` aos peers restantes.

Mensagens permitidas:

- `offer` com `description`;
- `answer` com `description`;
- `ice-candidate` com `candidate`;
- `transfer-completed` com `transfer_id`.

Proteções:

- mensagem máxima: 64 KiB;
- máximo de 30 mensagens por 10 segundos por conexão;
- JSON inválido é rejeitado;
- tipos desconhecidos são rejeitados;
- payloads malformados são rejeitados.

O backend nunca deve aceitar uma mensagem contendo bytes de arquivo. Ele apenas encaminha sinalização e eventos pequenos.

### `backend/app/metrics.py`

Gerencia o contador de transferências concluídas.

Quando estas variáveis existem, usa Upstash Redis:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

A chave Redis é:

```text
pydrop:transfers:completed
```

`record_transfer()` usa `INCR`, portanto o contador é atômico entre instâncias. Sem Redis, o fallback é `_local_transfer_count`, que zera ao reiniciar o processo.

### `backend/tests/test_rooms.py`

Testes unitários atuais para:

- código de sala com oito caracteres;
- expiração de sala;
- limpeza de salas expiradas;
- aceitação de payloads de sinalização válidos;
- rejeição de payloads inválidos.

## 5. Frontend

### `frontend/src/main.ts`

Ponto de entrada Vue:

1. importa o CSS global;
2. cria a aplicação;
3. registra o Vue Router;
4. monta em `#app`.

### `frontend/src/App.vue`

É a tela principal e concentra a experiência do PyDrop.

Responsabilidades:

- tela inicial;
- criação de sala;
- entrada por código;
- geração de QR Code;
- scanner de QR Code no celular;
- preparação automática do backend;
- estados de conexão;
- conexão WebSocket;
- integração com `DirectTransfer`;
- seleção e envio de arquivos;
- exibição de progresso;
- exibição do contador de transferências;
- mudança entre português e inglês;
- cena/ambiente visual Three.js;
- tratamento de desconexão;
- layout responsivo.

Estados principais:

- `initial`;
- `creating-room`;
- `waiting`;
- `connected`;
- `entering-room`;
- `inside-room`;
- `selecting-file`;
- `file-ready`;
- `transferring`;
- `completed`;
- `error`.

O idioma inicial deve continuar sendo `pt`.

### Fluxo de criação de sala

1. usuário clica em criar sala;
2. `ensureBackendReady()` verifica `GET /health`;
3. `createRoom()` envia `POST /rooms`;
4. app mostra o código;
5. app gera QR Code com URL no formato:

```text
https://pydrop.vercel.app/?room=ROOM_CODE
```

6. app abre o WebSocket;
7. segundo dispositivo entra pelo código ou QR;
8. inicia negociação WebRTC.

### Fluxo de QR Code

Existem dois caminhos:

1. O computador mostra o QR gerado pelo pacote `qrcode`.
2. O celular usa `qr-scanner` para abrir a câmera e ler o QR dentro da própria aplicação.

O QR deve conter uma URL do PyDrop com o parâmetro `room`. Ao abrir essa URL, `App.vue` extrai e valida o código e inicia o fluxo de entrada automaticamente.

Camera e QR exigem HTTPS em produção. Vercel fornece HTTPS.

### `frontend/src/api.ts`

É a camada de comunicação e WebRTC.

Responsabilidades:

- configurar a URL base da API;
- fazer requests HTTP;
- fazer health check com retry;
- criar sala;
- obter estatísticas;
- abrir WebSocket;
- validar arquivo;
- configurar STUN/TURN;
- criar `RTCPeerConnection`;
- negociar offer/answer/ICE;
- enviar e receber arquivos pelo DataChannel;
- informar conclusão de transferência;
- tratar desconexão e reconexão.

URL base padrão:

```text
https://pydrop.onrender.com
```

Pode ser substituída por `VITE_API_URL`.

### `ensureBackendReady()`

O health check:

- chama `/health`;
- usa timeout por tentativa;
- aguarda entre tentativas;
- mostra estado de servidor acordando;
- reaproveita request em andamento;
- mantém cache de backend pronto por um período curto;
- retorna erro controlado depois de várias falhas.

O health check é separado do WebSocket. O WebSocket só deve ser aberto depois do backend responder `200`.

### `DirectTransfer`

Classe responsável pela transferência P2P.

Propriedades importantes:

- `RTCPeerConnection`;
- `RTCDataChannel`;
- callbacks de estado;
- buffers de recebimento;
- tamanho esperado;
- metadata do arquivo;
- ID de transferência.

Protocolo simplificado:

```text
sender → {"kind":"meta", ...}
sender → chunks binários
receiver → valida tamanho e metadata
receiver → envia transferência concluída via WebSocket
backend → incrementa métrica e transmite transfer-count
```

Limite atual:

```text
500 MiB por arquivo
```

O receptor mantém os chunks em memória antes de criar o download. Isso é suficiente para o limite atual, mas não é ideal para arquivos muito grandes.

### `frontend/src/assets/base.css`

Define:

- variáveis de cor;
- fontes;
- reset básico;
- estilos globais;
- fundo escuro;
- tipografia e tokens visuais.

### `frontend/src/assets/main.css`

Importa `base.css` e define pequenos estilos globais para:

- `#app`;
- fontes de inputs e botões;
- cursor;
- foco visível.

### `frontend/src/router/index.ts`

Configura Vue Router:

- `/` usa `HomeView`;
- `/about` usa `AboutView`.

A maior parte da aplicação real ainda é `App.vue`. Qualquer remoção do router/template deve ser feita conscientemente.

### `frontend/src/views/HomeView.vue`

View padrão que renderiza `TheWelcome`. Atualmente é parte do template original e não é a tela principal customizada de transferência.

### `frontend/src/views/AboutView.vue`

Página padrão “about” do template Vue. Não contém lógica do PyDrop.

### Componentes padrão Vue

Os arquivos abaixo são boilerplate gerado pelo create-vue:

- `components/HelloWorld.vue`;
- `components/TheWelcome.vue`;
- `components/WelcomeItem.vue`;
- `components/icons/IconCommunity.vue`;
- `components/icons/IconDocumentation.vue`;
- `components/icons/IconEcosystem.vue`;
- `components/icons/IconSupport.vue`;
- `components/icons/IconTooling.vue`.

Eles ainda são usados por `HomeView`/`TheWelcome`. Podem ser removidos somente se a rota/view padrão também for removida ou substituída.

## 6. Assets e identidade visual

Assets ativos:

- `frontend/public/pydrop-icon-192.png`: logo mostrada no header;
- `frontend/public/pydrop-logo-final-symbol.png`: favicon usado em `index.html`;
- `frontend/pydrop-*.png`: imagens de referência/mockups da identidade visual, não importadas pelo runtime.

Não adicionar uma segunda logo sem confirmar qual asset deve ser a fonte oficial.

## 7. Configuração de ambiente

### Frontend: `frontend/.env.example`

```text
VITE_API_URL=https://pydrop.onrender.com
VITE_PUBLIC_APP_URL=https://pydrop.vercel.app
```

TURN opcional:

```text
VITE_TURN_URL=turn:provider.example:3478
VITE_TURN_USERNAME=temporary-username
VITE_TURN_CREDENTIAL=temporary-credential
```

TURN só deve ser configurado quando as três variáveis estiverem presentes. Credenciais de TURN devem ser temporárias quando possível.

### Backend/Render

```text
FRONTEND_ORIGIN=https://pydrop.vercel.app
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
```

Segredos nunca devem ir para o frontend/Vercel, Git ou este documento.

## 8. Como executar localmente

### Backend

Na raiz do repositório:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Endpoints locais:

```text
http://127.0.0.1:8000/health
http://127.0.0.1:8000/stats
```

### Frontend

Em outro terminal:

```powershell
cd frontend
npm install
npm run dev
```

O Vite normalmente usa `http://localhost:5173`. O proxy local em `vite.config.ts` encaminha `/rooms` e `/health` para `127.0.0.1:8000`, embora a API também tenha fallback para o Render.

## 9. Deploy

### Render

Configuração típica:

```text
Root Directory: backend
Build Command: pip install -r requirements.txt
Start Command: uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

O Render pode dormir no plano gratuito. O frontend faz health check e retry automaticamente.

### Vercel

Build:

```text
npm run build
```

Variável:

```text
VITE_API_URL=https://pydrop.onrender.com
```

Após alterar variáveis `VITE_*`, é necessário fazer novo deploy, pois o Vite embute essas variáveis no build.

## 10. Segurança e limitações conhecidas

Implementado:

- HTTPS/WSS em produção;
- CORS restrito;
- códigos de sala com oito caracteres;
- máximo de dois dispositivos por sala;
- expiração de uma hora;
- rate limit de criação de sala;
- rate limit de sinalização;
- limite de tamanho de mensagem WebSocket;
- validação dos tipos de sinalização;
- limite de arquivo de 500 MiB;
- validação de metadata;
- verificação de bytes recebidos;
- transferência sem armazenamento no backend.

Limitações:

- sala e conexões ficam em memória;
- restart do Render perde salas ativas;
- TURN real ainda precisa ser contratado/configurado;
- receiver mantém arquivo inteiro em memória;
- não há contas ou autenticação de usuário;
- qualquer pessoa com o código pode tentar entrar até a sala ficar cheia/expirar;
- o contador sem Redis zera no restart;
- múltiplas instâncias do backend exigiriam estado compartilhado para salas/conexões.

## 11. Regras para futuras alterações

1. Não adicionar upload, download de arquivo pelo backend ou storage.
2. Não colocar token Redis, TURN ou qualquer segredo no código.
3. Não trocar WebRTC por polling.
4. Manter `/health` sem dependências externas.
5. Abrir WebSocket somente depois de `ensureBackendReady()`.
6. Validar mensagens recebidas antes de encaminhá-las.
7. Contar transferência somente depois de o receiver confirmar todos os bytes.
8. Manter português como idioma inicial.
9. Preferir alterações pequenas e testáveis.
10. Depois de alterar frontend, executar:

```powershell
npm run build
```

11. Depois de alterar backend, executar compilação/testes com o ambiente de `backend/.venv`.
12. Não remover componentes/assets sem verificar referências no router, HTML, templates e imports.

## 12. Estado de validação conhecido

Validações usadas no projeto:

```powershell
cd frontend
npm run build
```

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

O build do frontend pode mostrar um aviso de chunk grande por causa principalmente do Three.js; isso é um warning, não uma falha.
