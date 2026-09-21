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

export interface TransferFile {
  name: string
  size: number
  type: string
}

export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024

export function validateTransferFile(file: Pick<TransferFile, 'name' | 'size' | 'type'>): string | null {
  if (!file.name.trim() || file.name.length > 255) return 'The file name must contain between 1 and 255 characters.'
  if (!Number.isSafeInteger(file.size) || file.size < 0) return 'The file size is invalid.'
  if (file.size > MAX_FILE_SIZE_BYTES) return 'Files must be 500 MB or smaller.'
  if (file.type.length > 255) return 'The file type is invalid.'
  return null
}

export interface CreateRoomResult {
  code: string
  url: string
}

export interface TransferStats {
  completed_transfers: number
}

const apiBaseUrl = (import.meta.env.VITE_API_URL ?? 'https://pydrop.onrender.com').replace(/\/$/, '')
const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const turnUrl = import.meta.env.VITE_TURN_URL?.trim()
const turnUsername = import.meta.env.VITE_TURN_USERNAME?.trim()
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL?.trim()
if (turnUrl && turnUsername && turnCredential) {
  iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential })
}
const backendReadyCacheMs = 30_000
let backendReadyAt = 0
let backendReadyRequest: Promise<void> | null = null

export type BackendPreparationState = 'checking' | 'waking_up' | 'ready' | 'failed'

export async function ensureBackendReady(
  onState?: (state: BackendPreparationState, elapsedSeconds: number) => void,
): Promise<void> {
  if (Date.now() - backendReadyAt < backendReadyCacheMs) {
    onState?.('ready', 0)
    return
  }
  if (backendReadyRequest) return backendReadyRequest

  const startedAt = Date.now()
  const update = (state: BackendPreparationState) => {
    onState?.(state, Math.floor((Date.now() - startedAt) / 1000))
  }

  backendReadyRequest = (async () => {
    update('checking')
    const maxAttempts = 10
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 8_000)
      try {
        const response = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal })
        if (response.ok) {
          const body = await response.json() as { status?: string }
          if (body.status === 'ok') {
            backendReadyAt = Date.now()
            update('ready')
            return
          }
        }
      } catch {
        // Render may be waking up or the request may have timed out.
      } finally {
        window.clearTimeout(timeout)
      }

      update('waking_up')
      if (attempt < maxAttempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 3_000))
      }
    }
    update('failed')
    throw new Error('The server did not become available')
  })().finally(() => {
    backendReadyRequest = null
  })

  return backendReadyRequest
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
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

export async function getTransferStats(): Promise<TransferStats> {
  return request<TransferStats>('/stats')
}

/**
 * Connects to the signaling channel. The backend forwards these messages,
 * but never receives file bytes.
 */
export function connectRoomSocket(
  code: string,
  handlers: {
    onUserJoined?: (sessions: number) => void
    onRoomState?: (sessions: number, initiator: boolean) => void
    onSignal?: (message: SignalMessage) => void
    onDisconnect?: () => void
    onClose?: (code: number, reason: string) => void
    onTransferCount?: (count: number) => void
  },
): { send: (message: SignalingMessage) => void; disconnect: () => void } {
  const signalingUrl = apiBaseUrl
    ? apiBaseUrl.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
  const socket = new WebSocket(`${signalingUrl}/rooms/${encodeURIComponent(code)}/ws`)
  const pending: SignalingMessage[] = []

  const send = (message: SignalingMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    else pending.push(message)
  }

  socket.addEventListener('open', () => {
    pending.splice(0).forEach((message) => socket.send(JSON.stringify(message)))
  })

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
      case 'room_state':
        handlers.onRoomState?.(message.sessions as number, message.initiator as boolean)
        break
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handlers.onSignal?.(message as unknown as SignalMessage)
        break
      case 'transfer-count':
        if (typeof message.count === 'number') handlers.onTransferCount?.(message.count)
        break
      default:
        break
    }
  })

  socket.addEventListener('close', (event) => {
    handlers.onClose?.(event.code, event.reason)
    handlers.onDisconnect?.()
  })

  return { send, disconnect: () => socket.close() }
}

export type SignalMessage =
  | { type: 'offer'; description: RTCSessionDescriptionInit }
  | { type: 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }

export type SignalingMessage = SignalMessage | { type: 'transfer-completed'; transfer_id: string }

export class DirectTransfer {
  private readonly peer: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private received: ArrayBuffer[] = []
  private receivedBytes = 0
  private incoming: TransferFile | null = null
  private incomingTransferId = ''

  constructor(
    private readonly sendSignal: (message: SignalingMessage) => void,
    private readonly onReady: () => void,
    private readonly onIncomingFile: (file: TransferFile, blob: Blob) => void,
    private readonly onProgress: (progress: number) => void,
    private readonly onTransferError?: (message: string) => void,
    private readonly onConnectionLost?: () => void,
  ) {
    this.peer = new RTCPeerConnection({
      iceServers,
    })
    this.peer.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ type: 'ice-candidate', candidate: candidate.toJSON() })
    }
    this.peer.addEventListener('connectionstatechange', () => {
      if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'disconnected' || this.peer.connectionState === 'closed') {
        this.onConnectionLost?.()
      }
    })
    this.peer.ondatachannel = ({ channel }) => this.attachChannel(channel)
  }

  async start(initiator: boolean) {
    if (!initiator) return
    this.attachChannel(this.peer.createDataChannel('files'))
    await this.peer.setLocalDescription(await this.peer.createOffer())
    this.sendSignal({ type: 'offer', description: this.peer.localDescription! })
  }

  async handleSignal(message: SignalMessage) {
    if (message.type === 'offer') {
      await this.peer.setRemoteDescription(message.description)
      await this.flushCandidates()
      await this.peer.setLocalDescription(await this.peer.createAnswer())
      this.sendSignal({ type: 'answer', description: this.peer.localDescription! })
    } else if (message.type === 'answer') {
      await this.peer.setRemoteDescription(message.description)
      await this.flushCandidates()
    } else {
      if (this.peer.remoteDescription) await this.peer.addIceCandidate(message.candidate)
      else this.pendingCandidates.push(message.candidate)
    }
  }

  async sendFile(file: File) {
    if (!this.channel || this.channel.readyState !== 'open') throw new Error('The devices are not connected yet')
    const validationError = validateTransferFile(file)
    if (validationError) throw new Error(validationError)
    const transferId = crypto.randomUUID()
    const chunkSize = 64 * 1024
    this.channel.send(JSON.stringify({ kind: 'file', transferId, name: file.name, size: file.size, type: file.type }))
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      while (this.channel.bufferedAmount > chunkSize * 8) await new Promise((resolve) => setTimeout(resolve, 20))
      this.channel.send(await file.slice(offset, offset + chunkSize).arrayBuffer())
      this.onProgress(Math.min(1, (offset + chunkSize) / file.size))
    }
    this.channel.send(JSON.stringify({ kind: 'file-end' }))
  }

  close() {
    this.channel?.close()
    this.peer.close()
  }

  private attachChannel(channel: RTCDataChannel) {
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => this.onReady()
    channel.onclose = () => this.onConnectionLost?.()
    channel.onerror = () => this.onConnectionLost?.()
    channel.onmessage = (event) => this.handleData(event.data)
  }

  private handleData(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      let message: { kind: string; transferId?: string; name?: string; size?: number; type?: string }
      try {
        message = JSON.parse(data)
      } catch {
        this.failIncoming('The received transfer metadata is invalid.')
        return
      }
      if (message.kind === 'file') {
        const incoming = {
          name: message.name || '',
          size: message.size ?? -1,
          type: message.type || 'application/octet-stream',
        }
        const validationError = validateTransferFile(incoming)
        if (validationError) {
          this.failIncoming('The received file was rejected.')
          return
        }
        this.incoming = incoming
        this.incomingTransferId = message.transferId || ''
        this.received = []
        this.receivedBytes = 0
      } else if (message.kind === 'file-end' && this.incoming) {
        if (this.receivedBytes !== this.incoming.size) {
          this.failIncoming('The file transfer was incomplete.')
          return
        }
        this.onIncomingFile(this.incoming, new Blob(this.received, { type: this.incoming.type }))
        this.sendSignal({ type: 'transfer-completed', transfer_id: this.incomingTransferId })
        this.resetIncoming()
      }
      return
    }
    if (!this.incoming) return
    if (this.receivedBytes + data.byteLength > this.incoming.size) {
      this.failIncoming('The received file was larger than expected.')
      return
    }
    this.received.push(data)
    this.receivedBytes += data.byteLength
    this.onProgress(this.receivedBytes / this.incoming.size)
  }

  private async flushCandidates() {
    for (const candidate of this.pendingCandidates.splice(0)) await this.peer.addIceCandidate(candidate)
  }

  private failIncoming(message: string) {
    this.resetIncoming()
    this.onTransferError?.(message)
  }

  private resetIncoming() {
    this.received = []
    this.receivedBytes = 0
    this.incoming = null
    this.incomingTransferId = ''
  }
}
