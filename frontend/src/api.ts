/**
 * api.ts — "o telefone para o servidor" ☎️
 *
 * Regra de ouro (por trás de tudo aqui):
 *   o frontend NAO sabe onde o backend mora.
 *   Ele fala caminhos RELATIVOS: /rooms, /files/xyz...
 *   Quem resolve "pra onde isso vai?" é a camada de fora:
 *     - em dev: o proxy do Vite (vite.config.ts) → 127.0.0.1:8000
 *     - em produção: a config da Vercel (vercel.json) → sua API
 *
 * Por que fazer assim? Porque o mesmo código de `fetch`
 * funciona IGUAL nos dois mundos. Se eu hardcoda-se
 * "http://127.0.0.1:8000" aqui, quebraria no deploy.
 */

export interface RoomInfo {
  code: string
  files: FileEntry[]
}

export interface FileEntry {
  id: string
  name: string
  size: number
  expires_in: number
}

export interface CreateRoomResult {
  code: string
  url: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      // resposta não era JSON — mantém o HTTP status
    }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

/** Cria uma sala nova e devolve o código. (POST /rooms) */
export async function createRoom(): Promise<CreateRoomResult> {
  return request<CreateRoomResult>('/rooms', { method: 'POST' })
}

/** Busca as infos de uma sala (e a lista de arquivos). (GET /rooms/{code}) */
export async function getRoom(code: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/rooms/${encodeURIComponent(code)}`)
}

/** Envia um arquivo para a sala. (POST /rooms/{code}/files, multipart) */
export async function uploadFile(
  code: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<FileEntry> {
  const form = new FormData()
  form.append('file', file)

  const response = await fetch(`/rooms/${encodeURIComponent(code)}/files`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      // ignora
    }
    throw new Error(detail)
  }

  if (onProgress && ('body' in response) && response.body) {
    // Progresso real de upload via fetch streaming (browsers modernos).
    const reader = response.body.getReader()
    const total = Number(response.headers.get('content-length')) || 0
    let received = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (total > 0) onProgress(Math.min(1, received / total))
    }
  }

  return response.json() as Promise<FileEntry>
}

/** Monta a URL de download — o frontend só precisa abrir isso. */
export function downloadUrl(fileId: string): string {
  return `/files/${encodeURIComponent(fileId)}`
}

/**
 * Conecta no WebSocket de uma sala e repassa eventos de tempo real.
 * Devolve uma função de "desligar" — quem conecta decide quando parar.
 */
export function connectRoomSocket(
  code: string,
  handlers: {
    onUserJoined?: (sessions: number) => void
    onUserLeft?: (sessions: number) => void
    onFileAdded?: (fileId: string) => void
    onDisconnect?: () => void
  },
): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${protocol}://${window.location.host}/rooms/${encodeURIComponent(code)}/ws`)

  socket.addEventListener('message', (event: MessageEvent) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    switch (message.type) {
      case 'user_joined':
        handlers.onUserJoined?.(message.sessions as number)
        break
      case 'user_left':
        handlers.onUserLeft?.(message.sessions as number)
        break
      case 'file_added':
        handlers.onFileAdded?.(message.file_id as string)
        break
      default:
        break
    }
  })

  socket.addEventListener('close', () => handlers.onDisconnect?.())

  return () => socket.close()
}
