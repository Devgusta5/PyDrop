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

export interface CreateRoomResult {
  code: string
  url: string
}

const apiBaseUrl = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

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
  },
): { send: (message: SignalMessage) => void; disconnect: () => void } {
  const signalingUrl = apiBaseUrl
    ? apiBaseUrl.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
  const socket = new WebSocket(`${signalingUrl}/rooms/${encodeURIComponent(code)}/ws`)
  const pending: SignalMessage[] = []

  const send = (message: SignalMessage) => {
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
      default:
        break
    }
  })

  socket.addEventListener('close', () => handlers.onDisconnect?.())

  return { send, disconnect: () => socket.close() }
}

export type SignalMessage =
  | { type: 'offer'; description: RTCSessionDescriptionInit }
  | { type: 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }

export class DirectTransfer {
  private readonly peer: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private received: ArrayBuffer[] = []
  private receivedBytes = 0
  private incoming: TransferFile | null = null

  constructor(
    private readonly sendSignal: (message: SignalMessage) => void,
    private readonly onReady: () => void,
    private readonly onIncomingFile: (file: TransferFile, blob: Blob) => void,
    private readonly onProgress: (progress: number) => void,
  ) {
    this.peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    this.peer.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ type: 'ice-candidate', candidate: candidate.toJSON() })
    }
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
    const chunkSize = 64 * 1024
    this.channel.send(JSON.stringify({ kind: 'file', name: file.name, size: file.size, type: file.type }))
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
    channel.onmessage = (event) => this.handleData(event.data)
  }

  private handleData(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as { kind: string; name?: string; size?: number; type?: string }
      if (message.kind === 'file') {
        this.incoming = { name: message.name!, size: message.size!, type: message.type || 'application/octet-stream' }
        this.received = []
        this.receivedBytes = 0
      } else if (message.kind === 'file-end' && this.incoming) {
        this.onIncomingFile(this.incoming, new Blob(this.received, { type: this.incoming.type }))
        this.incoming = null
      }
      return
    }
    if (!this.incoming) return
    this.received.push(data)
    this.receivedBytes += data.byteLength
    this.onProgress(this.receivedBytes / this.incoming.size)
  }

  private async flushCandidates() {
    for (const candidate of this.pendingCandidates.splice(0)) await this.peer.addIceCandidate(candidate)
  }
}
