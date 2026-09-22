<script setup lang="ts">
import * as THREE from 'three'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from './api'

type View = 'start' | 'room' | 'connected'
type AppState =
  | 'initial'
  | 'creating-room'
  | 'waiting'
  | 'connected'
  | 'entering-room'
  | 'inside-room'
  | 'selecting-file'
  | 'file-ready'
  | 'transferring'
  | 'completed'
  | 'error'
type Language = 'en' | 'pt'
type RenderQuality = 'high' | 'balanced' | 'reduced'
type EntryMode = 'create' | 'join' | null

const view = ref<View>('start')
const appState = ref<AppState>('initial')
const language = ref<Language>('pt')
const direction = ref<'send' | 'receive'>('send')
const selectedFile = ref<File | null>(null)
// Frozen at the moment a transfer starts, so a later file-input change can't corrupt the progress label.
const activeTransferName = ref('')
const isTransferring = ref(false)
const transferComplete = ref(false)
const transferPercent = ref(0)
const immersiveMode = ref(false)
const reduceMotion = ref(false)
const renderQuality = ref<RenderQuality>('balanced')
const roomCode = ref('')
const joinCode = ref('')
const entryMode = ref<EntryMode>(null)
const isJoinExpanded = ref(false)
const isDragOver = ref(false)
const copyFeedback = ref('')
const roomFiles = ref<api.TransferFile[]>([])
const threeMount = ref<HTMLElement | null>(null)
const spaceMount = ref<HTMLElement | null>(null)
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrVideo = ref<HTMLVideoElement | null>(null)
const isScanningQr = ref(false)
const hasWebGL = ref(true)
let qrScanner: QrScanner | null = null
const serverStatus = ref<'idle' | 'checking' | 'waking_up' | 'ready' | 'connecting_ws' | 'connected' | 'failed'>('idle')
const serverElapsedSeconds = ref(0)
const roomFull = ref(false)
const deviceConnectionStatus = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
let roomConnection: ReturnType<typeof api.connectRoomSocket> | null = null
let directTransfer: api.DirectTransfer | null = null
let reconnectTimer = 0
let reconnectAttempts = 0
let roomEntryTimer = 0
let pendingDownloadUrl = 0
// Bumped every time we (re)connect on purpose, so a stale onDisconnect from a superseded
// socket can never trigger a reconnect loop for a connection we already tore down ourselves.
let connectionGeneration = 0

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let animationFrame = 0
let resizeObserver: ResizeObserver | null = null
let roomPortal: THREE.Group | null = null
let transferObject: THREE.Mesh | null = null
let cameraEntry = 0
let sceneTransferProgress = -1

let spaceRenderer: THREE.WebGLRenderer | null = null
let spaceScene: THREE.Scene | null = null
let spaceCamera: THREE.PerspectiveCamera | null = null
let spaceAnimationFrame = 0
let spaceResizeObserver: ResizeObserver | null = null
let spaceCore: THREE.Group | null = null
let spaceRemote: THREE.Mesh | null = null
let spaceStars: THREE.Points | null = null
let spaceParticles: THREE.Points | null = null
let spaceMouse = { x: 0, y: 0 }
let spaceTargetMouse = { x: 0, y: 0 }
let spaceStartedAt = 0
let spaceRaycaster = new THREE.Raycaster()
let spacePointer = new THREE.Vector2()
let coreHovered = false

const copy = computed(() => {
  const en = {
    create: 'Create a room',
    join: 'Join with a code',
    headline: 'Transfer files\nbetween your devices.',
    intro: 'Direct connection. No account. No permanent storage.',
    footer: 'No account · Direct transfer · Rooms expire after 1 hour',
    codeLabel: 'Room code',
    joinRoom: 'Join room',
    roomReady: 'Your room is ready',
    waiting: 'Waiting for another device',
    copyCode: 'Copy room code',
    copied: 'Room code copied',
    connectedTitle: 'Another device joined',
    connectedBody: 'Connected and ready',
    choose: 'Choose a file',
    chooseOrDrag: 'Choose a file or drag it here',
    send: 'Send file',
    sendAnother: 'Send another file',
    complete: 'Transfer complete',
    arrived: 'Your file arrived safely.',
    enterImmersive: 'Enter immersive mode',
    exitImmersive: 'Exit immersive',
    exitRoom: 'Exit room',
    cancel: 'Cancel',
    retry: 'Try again',
    retryConnection: 'Try to reconnect',
    scanQr: 'Scan QR code',
    scanQrDialog: 'Point your camera at the QR code on the other device.',
    cancelScan: 'Cancel scan',
    scanToJoin: 'Scan to join this room',
    fileSelected: 'File selected',
    deviceDisconnected: 'Device disconnected',
    connectionLostTitle: 'Connection lost',
    connectionLostBody: 'The other device is no longer connected. Reconnect it to continue.',
    checkingServer: 'Checking server...',
    startingServer: 'Starting server...',
    connectingWs: 'Connecting...',
    unableToConnect: 'Unable to connect.',
    unableToConnectTitle: 'Unable to connect to the server',
    serverReady: 'Server ready',
    readyWhenYouAre: 'Ready when you are.',
    roomFull: 'This room already has two connected devices.',
    elapsedTime: 'Elapsed time:',
    creatingRoom: 'Creating your room...',
    joiningRoom: 'Joining room...',
    sending: 'Sending',
    reduceMotion: 'Reduce motion',
    motionReduced: 'Motion reduced',
    quality: 'Quality',
    qualityHigh: 'High',
    qualityBalanced: 'Balanced',
    qualityReduced: 'Reduced',
    invalidCode: 'Room codes have eight letters or numbers.',
    invalidQr: 'This QR code is not a valid PyDrop room.',
    notPyDropQr: 'This QR code is not a PyDrop room.',
    cameraRequired: 'Camera access is required to scan a room QR code.',
    confirmLeave: 'A transfer is in progress. Leave anyway?',
  }
  const pt = {
    create: 'Criar uma sala',
    join: 'Entrar com um código',
    headline: 'Transfira arquivos\nentre seus dispositivos.',
    intro: 'Conexão direta. Sem conta. Sem armazenamento permanente.',
    footer: 'Sem conta · Transferência direta · Salas expiram em 1 hora',
    codeLabel: 'Código da sala',
    joinRoom: 'Entrar na sala',
    roomReady: 'Sua sala está pronta',
    waiting: 'Aguardando outro dispositivo',
    copyCode: 'Copiar código',
    copied: 'Código copiado',
    connectedTitle: 'Outro dispositivo entrou',
    connectedBody: 'Conectado e pronto',
    choose: 'Escolher arquivo',
    chooseOrDrag: 'Escolha um arquivo ou arraste aqui',
    send: 'Enviar arquivo',
    sendAnother: 'Enviar outro arquivo',
    complete: 'Transferência concluída',
    arrived: 'Seu arquivo chegou com segurança.',
    enterImmersive: 'Entrar no modo imersivo',
    exitImmersive: 'Sair do imersivo',
    exitRoom: 'Sair da sala',
    cancel: 'Cancelar',
    retry: 'Tentar novamente',
    retryConnection: 'Tentar reconectar',
    scanQr: 'Escanear QR code',
    scanQrDialog: 'Aponte a câmera para o QR code no outro dispositivo.',
    cancelScan: 'Cancelar escaneamento',
    scanToJoin: 'Escaneie para entrar nesta sala',
    fileSelected: 'Arquivo selecionado',
    deviceDisconnected: 'Dispositivo desconectado',
    connectionLostTitle: 'Conexão perdida',
    connectionLostBody: 'O outro dispositivo não está mais conectado. Reconecte-o para continuar.',
    checkingServer: 'Verificando servidor...',
    startingServer: 'Iniciando servidor...',
    connectingWs: 'Conectando...',
    unableToConnect: 'Não foi possível conectar.',
    unableToConnectTitle: 'Não foi possível conectar ao servidor',
    serverReady: 'Servidor pronto',
    readyWhenYouAre: 'Pronto quando você estiver.',
    roomFull: 'Esta sala já tem dois dispositivos conectados.',
    elapsedTime: 'Tempo decorrido:',
    creatingRoom: 'Criando sua sala...',
    joiningRoom: 'Entrando na sala...',
    sending: 'Enviando',
    reduceMotion: 'Reduzir movimento',
    motionReduced: 'Movimento reduzido',
    quality: 'Qualidade',
    qualityHigh: 'Alta',
    qualityBalanced: 'Equilibrada',
    qualityReduced: 'Reduzida',
    invalidCode: 'Códigos de sala têm oito letras ou números.',
    invalidQr: 'Este QR code não é uma sala válida do PyDrop.',
    notPyDropQr: 'Este QR code não é uma sala do PyDrop.',
    cameraRequired: 'É necessário acesso à câmera para escanear o QR code da sala.',
    confirmLeave: 'Uma transferência está em andamento. Sair mesmo assim?',
  }
  return language.value === 'en' ? en : pt
})

const isMobileDevice = computed(() => /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent))
const isPreparingBackend = computed(() => ['checking', 'waking_up', 'connecting_ws'].includes(serverStatus.value))
const preparingLabel = computed(() => (entryMode.value === 'join' ? copy.value.joiningRoom : copy.value.creatingRoom))
const fileLabel = computed(() => selectedFile.value?.name ?? copy.value.chooseOrDrag)
const displayRoomCode = computed(() => formatRoomCode(roomCode.value))
const normalizedJoinCode = computed(() => joinCode.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())
const canTransfer = computed(() => !!selectedFile.value && !isTransferring.value && deviceConnectionStatus.value === 'connected')
const statusMessage = computed(() => {
  if (roomFull.value) return copy.value.roomFull
  if (serverStatus.value === 'checking') return copy.value.checkingServer
  if (serverStatus.value === 'waking_up') return copy.value.startingServer
  if (serverStatus.value === 'connecting_ws') return copy.value.connectingWs
  if (serverStatus.value === 'failed') return copy.value.unableToConnect
  if (deviceConnectionStatus.value === 'connected') return copy.value.connectedBody
  if (view.value === 'start') return copy.value.readyWhenYouAre
  return copy.value.waiting
})
const preparationTitle = computed(() => {
  if (serverStatus.value === 'checking') return copy.value.checkingServer
  if (serverStatus.value === 'waking_up') return copy.value.startingServer
  if (serverStatus.value === 'connecting_ws') return copy.value.connectingWs
  if (serverStatus.value === 'failed') return copy.value.unableToConnectTitle
  return copy.value.serverReady
})

function formatRoomCode(code: string) {
  return code ? code.replace(/^(.{4})(.{4})$/, '$1-$2') : '....-....'
}

function setAppState(state: AppState) {
  appState.value = state
}

function setLanguage() {
  language.value = language.value === 'en' ? 'pt' : 'en'
}

function toggleImmersiveMode() {
  immersiveMode.value = !immersiveMode.value
  if (immersiveMode.value && appState.value === 'connected') setAppState('entering-room')
  if (!immersiveMode.value && appState.value === 'entering-room') setAppState('connected')
}

function toggleReduceMotion() {
  reduceMotion.value = !reduceMotion.value
}

async function createRoom() {
  entryMode.value = 'create'
  view.value = 'room'
  setAppState('creating-room')
  copyFeedback.value = ''
  try {
    await prepareBackend()
    const result = await api.createRoom()
    roomCode.value = result.code
    setAppState('waiting')
    await nextTick()
    await renderRoomQrCode()
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
  }
}

// Reconnects to the room we already have (whichever way we got it) instead of
// silently minting a brand-new room code and stranding the other device.
async function retryConnection() {
  if (roomCode.value) {
    setAppState('creating-room')
    try {
      await prepareBackend()
      setAppState('waiting')
      connectToRoom()
    } catch {
      serverStatus.value = 'failed'
      setAppState('error')
    }
    return
  }
  await createRoom()
}

async function prepareBackend() {
  await api.ensureBackendReady((state, elapsedSeconds) => {
    serverElapsedSeconds.value = elapsedSeconds
    if (state === 'checking') serverStatus.value = 'checking'
    if (state === 'waking_up') serverStatus.value = 'waking_up'
    if (state === 'ready') serverStatus.value = 'ready'
  })
}

async function joinRoomByCode(rawCode: string) {
  const code = rawCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (!code || !/^[A-Z0-9]{8}$/.test(code)) {
    if (code) window.alert(copy.value.invalidCode)
    return
  }
  entryMode.value = 'join'
  roomCode.value = code
  view.value = 'room'
  setAppState('creating-room')
  try {
    await prepareBackend()
    setAppState('waiting')
    connectToRoom()
    await nextTick()
    await renderRoomQrCode()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
  }
}

function submitJoinCode() {
  joinRoomByCode(joinCode.value)
}

async function copyRoomCode() {
  if (!roomCode.value) return
  try {
    await navigator.clipboard.writeText(roomCode.value)
    copyFeedback.value = copy.value.copied
  } catch {
    copyFeedback.value = roomCode.value
  }
  window.setTimeout(() => { copyFeedback.value = '' }, 2200)
}

async function startQrScanner() {
  stopQrScanner()
  isScanningQr.value = true
  await nextTick()
  if (!qrVideo.value) return
  qrScanner = new QrScanner(qrVideo.value, (result) => {
    const value = typeof result === 'string' ? result : result.data
    try {
      const scannedUrl = new URL(value)
      const code = scannedUrl.searchParams.get('room')
      if (!code) throw new Error(copy.value.notPyDropQr)
      stopQrScanner()
      joinRoomByCode(code)
    } catch {
      window.alert(copy.value.invalidQr)
    }
  }, { highlightScanRegion: true, highlightCodeOutline: true })
  try {
    await qrScanner.start()
  } catch {
    stopQrScanner()
    window.alert(copy.value.cameraRequired)
  }
}

function stopQrScanner() {
  qrScanner?.stop()
  qrScanner?.destroy()
  qrScanner = null
  isScanningQr.value = false
}

async function renderRoomQrCode() {
  if (!qrCanvas.value || !roomCode.value) return
  const publicAppUrl = import.meta.env.VITE_PUBLIC_APP_URL || 'https://pydrop.vercel.app'
  const joinUrl = new URL(publicAppUrl)
  joinUrl.search = ''
  joinUrl.searchParams.set('room', roomCode.value)
  await QRCode.toCanvas(qrCanvas.value, joinUrl.toString(), {
    width: 156,
    margin: 2,
    color: { dark: '#0B0F12', light: '#F4F7F2' },
  })
}

function connectToRoom() {
  window.clearTimeout(reconnectTimer)
  serverStatus.value = 'connecting_ws'
  connectionGeneration += 1
  const myGeneration = connectionGeneration
  roomConnection?.disconnect()
  directTransfer?.close()
  directTransfer = null
  roomConnection = api.connectRoomSocket(roomCode.value, {
    onRoomState: (sessions, initiator) => {
      if (sessions > 1) handleDevicesConnected(initiator)
    },
    onUserJoined: (sessions) => {
      if (sessions > 1) handleDevicesConnected(true)
    },
    onSignal: (message) => {
      directTransfer?.handleSignal(message).catch((error) => window.alert(String(error)))
    },
    onDisconnect: () => {
      // A previous socket we've since replaced — ignore its stale disconnect event.
      if (myGeneration !== connectionGeneration) return
      deviceConnectionStatus.value = 'disconnected'
      if (roomFull.value) return
      if (reconnectAttempts >= 3) {
        serverStatus.value = 'failed'
        setAppState('error')
        return
      }
      reconnectAttempts += 1
      serverStatus.value = 'connecting_ws'
      reconnectTimer = window.setTimeout(() => connectToRoom(), reconnectAttempts * 1500)
    },
    onClose: (code) => {
      if (myGeneration !== connectionGeneration) return
      if (code === 1008) {
        roomFull.value = true
        serverStatus.value = 'failed'
        setAppState('error')
        window.clearTimeout(reconnectTimer)
      }
    },
  })
}

function handleDevicesConnected(initiator: boolean) {
  setupDirectTransfer(initiator)
  view.value = 'connected'
  deviceConnectionStatus.value = 'connecting'
  serverStatus.value = 'connected'
  reconnectAttempts = 0
  setAppState(immersiveMode.value ? 'entering-room' : 'connected')
  window.clearTimeout(roomEntryTimer)
  if (immersiveMode.value && !reduceMotion.value) {
    roomEntryTimer = window.setTimeout(() => setAppState('inside-room'), 1900)
  } else if (immersiveMode.value) {
    setAppState('inside-room')
  }
}

function setupDirectTransfer(initiator: boolean) {
  if (directTransfer || !roomConnection) return
  directTransfer = new api.DirectTransfer(
    (message) => roomConnection?.send(message),
    () => {
      deviceConnectionStatus.value = 'connected'
      if (appState.value === 'connected') setAppState(immersiveMode.value ? 'inside-room' : 'connected')
    },
    (file, blob) => {
      roomFiles.value = [...roomFiles.value, file]
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      // Give the browser a moment to hand the blob off before we revoke it —
      // revoking synchronously right after click() is flaky on some mobile browsers.
      window.clearTimeout(pendingDownloadUrl)
      pendingDownloadUrl = window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      transferComplete.value = true
      transferPercent.value = 100
      setAppState('completed')
    },
    (progress) => {
      transferPercent.value = Math.round(progress * 100)
      sceneTransferProgress = progress
    },
    (message) => window.alert(message),
    () => {
      if (view.value === 'connected') {
        isTransferring.value = false
        deviceConnectionStatus.value = 'disconnected'
      }
    },
  )
  directTransfer.start(initiator).catch((error) => window.alert(String(error)))
}

function reset(force = false) {
  if (!force && isTransferring.value) {
    if (!window.confirm(copy.value.confirmLeave)) return
  }
  stopQrScanner()
  connectionGeneration += 1
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(roomEntryTimer)
  window.clearTimeout(pendingDownloadUrl)
  roomConnection?.disconnect()
  directTransfer?.close()
  roomConnection = null
  directTransfer = null
  view.value = 'start'
  setAppState('initial')
  selectedFile.value = null
  activeTransferName.value = ''
  transferComplete.value = false
  isTransferring.value = false
  transferPercent.value = 0
  sceneTransferProgress = -1
  deviceConnectionStatus.value = 'connecting'
  serverStatus.value = 'idle'
  serverElapsedSeconds.value = 0
  roomFull.value = false
  reconnectAttempts = 0
  copyFeedback.value = ''
  roomCode.value = ''
  joinCode.value = ''
  entryMode.value = null
  isJoinExpanded.value = false
  isDragOver.value = false
  roomFiles.value = []
}

async function prepareOnStartup() {
  try {
    await prepareBackend()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
  }
}

// Shared by the file input and drag-and-drop so both paths validate identically.
function acceptFile(file: File | null) {
  if (file) {
    const validationError = api.validateTransferFile(file)
    if (validationError) {
      selectedFile.value = null
      window.alert(validationError)
      return
    }
  }
  selectedFile.value = file
  transferComplete.value = false
  transferPercent.value = 0
  setAppState(file ? 'file-ready' : 'selecting-file')
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  acceptFile(file)
  if (!selectedFile.value) input.value = ''
}

function onDropZoneDragOver(event: DragEvent) {
  if (isTransferring.value) return
  event.preventDefault()
  isDragOver.value = true
}

function onDropZoneDragLeave() {
  isDragOver.value = false
}

function onDropZoneDrop(event: DragEvent) {
  event.preventDefault()
  isDragOver.value = false
  if (isTransferring.value) return
  const file = event.dataTransfer?.files?.[0] ?? null
  if (file) acceptFile(file)
}

async function startTransfer() {
  if (!selectedFile.value || !directTransfer || deviceConnectionStatus.value !== 'connected') return
  activeTransferName.value = selectedFile.value.name
  isTransferring.value = true
  transferComplete.value = false
  transferPercent.value = 0
  sceneTransferProgress = 0
  setAppState('transferring')
  try {
    await directTransfer.sendFile(selectedFile.value)
    transferComplete.value = true
    transferPercent.value = 100
    setAppState('completed')
  } catch (error) {
    setAppState('error')
    window.alert(error instanceof Error ? error.message : String(error))
  } finally {
    isTransferring.value = false
  }
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

function material(color: number, roughness = 0.7) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 })
}

function addBox(parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color))
  mesh.position.set(...position)
  parent.add(mesh)
  return mesh
}

// Recursively frees GPU resources (geometry, material, textures) for everything in a subtree.
// Without this, recreating the scene on every quality/view change leaks VRAM indefinitely.
function disposeObject3D(root: THREE.Object3D | null) {
  if (!root) return
  root.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.Points
    const geometry = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    geometry?.dispose()
    const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    const materials = Array.isArray(mat) ? mat : mat ? [mat] : []
    materials.forEach((m) => {
      Object.values(m).forEach((value) => {
        if (value && typeof value === 'object' && 'isTexture' in value) (value as THREE.Texture).dispose()
      })
      m.dispose()
    })
  })
}

function createThreeScene() {
  if (!threeMount.value || renderer || !hasWebGL.value) return
  const width = threeMount.value.clientWidth
  const height = threeMount.value.clientHeight
  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x0b0f12, 8, 22)
  camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 50)
  camera.position.set(0, 2.4, 8.6)

  renderer = new THREE.WebGLRenderer({ antialias: renderQuality.value !== 'reduced', alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality.value === 'high' ? 2 : 1.35))
  renderer.setSize(width, height)
  renderer.shadowMap.enabled = renderQuality.value !== 'reduced'
  threeMount.value.appendChild(renderer.domElement)

  scene.add(new THREE.HemisphereLight(0xb7f34a, 0x12181c, 1.1))
  const keyLight = new THREE.DirectionalLight(0xf4f7f2, 2.2)
  keyLight.position.set(-3, 6, 5)
  scene.add(keyLight)
  const portalLight = new THREE.PointLight(0xb7f34a, 4.8, 8)
  portalLight.position.set(0, 2.1, 0.4)
  scene.add(portalLight)

  const room = new THREE.Group()
  scene.add(room)
  addBox(room, [12, 0.16, 9], [0, 0, 0], 0x1a2328)
  addBox(room, [12, 5.2, 0.16], [0, 2.6, -3.7], 0x12181c)
  addBox(room, [0.16, 5.2, 9], [-5.9, 2.6, 0], 0x151d21)
  addBox(room, [0.16, 5.2, 9], [5.9, 2.6, 0], 0x101518)

  const table = new THREE.Group()
  table.position.set(-2.7, 0, 0.55)
  addBox(table, [3.4, 0.18, 1.25], [0, 1.55, 0], 0x273238)
  ;[-1.35, 1.35].forEach((x) => addBox(table, [0.12, 1.5, 0.12], [x, 0.78, 0], 0x1a2328))
  room.add(table)

  const computer = new THREE.Group()
  computer.position.set(-2.7, 1.68, 0.48)
  addBox(computer, [1.65, 1, 0.1], [0, 0.58, 0], 0x0b0f12)
  addBox(computer, [1.38, 0.76, 0.03], [0, 0.58, 0.07], 0x203328)
  addBox(computer, [0.12, 0.52, 0.12], [0, 0.14, 0], 0x9aa6a8)
  addBox(computer, [0.72, 0.04, 0.32], [0, -0.12, 0.08], 0x9aa6a8)
  room.add(computer)

  const phone = new THREE.Group()
  phone.position.set(3.1, 0.96, 0.02)
  addBox(phone, [0.62, 1.38, 0.11], [0, 0.7, 0], 0x0b0f12)
  addBox(phone, [0.46, 1, 0.02], [0, 0.7, 0.07], 0x3a211f)
  phone.rotation.z = -0.12
  room.add(phone)

  const lamp = new THREE.Group()
  lamp.position.set(1.8, 0, -0.4)
  addBox(lamp, [0.08, 2.5, 0.08], [0, 1.2, 0], 0x273238)
  addBox(lamp, [0.9, 0.08, 0.9], [0, 2.5, 0], 0xff6b5e)
  room.add(lamp)

  roomPortal = new THREE.Group()
  roomPortal.position.set(0, 2.1, 0.08)
  const lime = new THREE.MeshBasicMaterial({ color: 0xb7f34a, transparent: true, opacity: 0.78, side: THREE.DoubleSide })
  const coral = new THREE.MeshBasicMaterial({ color: 0xff6b5e, transparent: true, opacity: 0.62, side: THREE.DoubleSide })
  const portalA = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.055, 16, 72), lime)
  const portalB = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.055, 16, 72), coral)
  portalA.position.x = -0.34
  portalB.position.x = 0.34
  portalA.rotation.y = 0.4
  portalB.rotation.y = -0.4
  roomPortal.add(portalA, portalB)
  scene.add(roomPortal)

  transferObject = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.48, 0.035),
    new THREE.MeshBasicMaterial({ color: 0xf4f7f2, transparent: true, opacity: 0.9 }),
  )
  transferObject.visible = false
  scene.add(transferObject)

  resizeObserver = new ResizeObserver(() => resizeThreeScene())
  resizeObserver.observe(threeMount.value)
  animationFrame = requestAnimationFrame(animateThreeScene)
}

function resizeThreeScene() {
  if (!renderer || !camera || !threeMount.value) return
  camera.aspect = threeMount.value.clientWidth / threeMount.value.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(threeMount.value.clientWidth, threeMount.value.clientHeight)
}

function animateThreeScene(time: number) {
  if (!renderer || !scene || !camera) return
  const seconds = time * 0.001
  if (!reduceMotion.value) {
    cameraEntry = Math.min(cameraEntry + 0.01, 1)
    const entryEase = 1 - Math.pow(1 - cameraEntry, 3)
    camera.position.z = THREE.MathUtils.lerp(8.6, appState.value === 'entering-room' ? 4.6 : 6.2, entryEase)
    camera.position.x = Math.sin(seconds * 0.22) * 0.14
    camera.position.y = 2.35 + Math.cos(seconds * 0.18) * 0.08
  }
  camera.lookAt(0, 1.65, -0.45)
  if (roomPortal) {
    roomPortal.rotation.z = seconds * 0.18
    const activeScale = appState.value === 'transferring' ? 1.14 : appState.value === 'completed' ? 1.04 : 1
    roomPortal.scale.setScalar(activeScale + (reduceMotion.value ? 0 : Math.sin(seconds * 2.2) * 0.025))
  }
  if (transferObject) {
    const active = appState.value === 'file-ready' || appState.value === 'transferring' || appState.value === 'completed'
    transferObject.visible = active
    const progress = appState.value === 'transferring' ? Math.min(Math.max(sceneTransferProgress, 0), 1) : appState.value === 'completed' ? 1 : 0
    transferObject.position.set(THREE.MathUtils.lerp(-2.7, 3.08, progress), 2.2 + Math.sin(progress * Math.PI) * 0.6, 0.2)
    transferObject.rotation.y += reduceMotion.value ? 0 : 0.025
  }
  renderer.render(scene, camera)
  animationFrame = requestAnimationFrame(animateThreeScene)
}

function disposeThreeScene() {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  disposeObject3D(scene)
  renderer?.dispose()
  renderer?.domElement.remove()
  renderer = null
  scene = null
  camera = null
  roomPortal = null
  transferObject = null
}

function createSpaceScene() {
  if (!spaceMount.value || spaceRenderer || !hasWebGL.value) return
  const width = spaceMount.value.clientWidth
  const height = spaceMount.value.clientHeight
  spaceScene = new THREE.Scene()
  spaceScene.fog = new THREE.FogExp2(0x0b0f12, 0.04)
  spaceCamera = new THREE.PerspectiveCamera(54, width / height, 0.1, 100)
  spaceCamera.position.set(0, 0.2, 8)

  spaceRenderer = new THREE.WebGLRenderer({ antialias: renderQuality.value !== 'reduced', alpha: true })
  spaceRenderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality.value === 'high' ? 2 : 1.25))
  spaceRenderer.setSize(width, height)
  spaceMount.value.appendChild(spaceRenderer.domElement)

  spaceScene.add(new THREE.AmbientLight(0x9aa6a8, 0.45))
  const coreLight = new THREE.PointLight(0xb7f34a, 7, 17)
  coreLight.position.set(0, 0.15, 1.5)
  spaceScene.add(coreLight)
  const destinationLight = new THREE.PointLight(0xff6b5e, 3.2, 12)
  destinationLight.position.set(3.2, -0.4, -4)
  spaceScene.add(destinationLight)

  const count = renderQuality.value === 'high' ? 1300 : renderQuality.value === 'balanced' ? 760 : 330
  const starPositions = new Float32Array(count * 3)
  const starColors = new Float32Array(count * 3)
  for (let index = 0; index < count; index += 1) {
    const radius = 3 + Math.random() * 22
    const angle = Math.random() * Math.PI * 2
    starPositions[index * 3] = Math.cos(angle) * radius
    starPositions[index * 3 + 1] = (Math.random() - 0.5) * 12
    starPositions[index * 3 + 2] = -Math.random() * 28
    const warm = Math.random() > 0.82
    starColors[index * 3] = warm ? 1 : 0.72
    starColors[index * 3 + 1] = warm ? 0.42 : 0.95
    starColors[index * 3 + 2] = warm ? 0.36 : 0.62
  }
  const starGeometry = new THREE.BufferGeometry()
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3))
  spaceStars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 0.032, vertexColors: true, transparent: true, opacity: 0.86, sizeAttenuation: true }))
  spaceScene.add(spaceStars)

  const particleCount = renderQuality.value === 'reduced' ? 80 : 180
  const particlePositions = new Float32Array(particleCount * 3)
  for (let index = 0; index < particleCount; index += 1) {
    particlePositions[index * 3] = (Math.random() - 0.5) * 3.8
    particlePositions[index * 3 + 1] = (Math.random() - 0.5) * 2.3
    particlePositions[index * 3 + 2] = (Math.random() - 0.5) * 2.4
  }
  const particleGeometry = new THREE.BufferGeometry()
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
  spaceParticles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ color: 0xb7f34a, size: 0.026, transparent: true, opacity: 0.5 }))
  spaceScene.add(spaceParticles)

  spaceCore = new THREE.Group()
  const lime = new THREE.MeshStandardMaterial({ color: 0xb7f34a, emissive: 0x48671a, emissiveIntensity: 1.7, roughness: 0.24, metalness: 0.42 })
  const coral = new THREE.MeshStandardMaterial({ color: 0xff6b5e, emissive: 0x59231f, emissiveIntensity: 1.1, roughness: 0.32, metalness: 0.3 })
  const leftLoop = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.075, 18, 72), lime)
  const rightLoop = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.075, 18, 72), coral)
  leftLoop.position.x = -0.36
  rightLoop.position.x = 0.36
  leftLoop.rotation.y = 0.52
  rightLoop.rotation.y = -0.52
  const passage = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.026, 12, 48), new THREE.MeshBasicMaterial({ color: 0xf4f7f2, transparent: true, opacity: 0.42 }))
  passage.rotation.x = Math.PI / 2
  spaceCore.add(leftLoop, rightLoop, passage)
  spaceScene.add(spaceCore)

  spaceRemote = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), new THREE.MeshBasicMaterial({ color: 0xff6b5e }))
  spaceRemote.position.set(4.5, -0.6, -6)
  spaceScene.add(spaceRemote)

  spaceStartedAt = performance.now()
  spaceResizeObserver = new ResizeObserver(() => resizeSpaceScene())
  spaceResizeObserver.observe(spaceMount.value)
  spaceMount.value.addEventListener('pointermove', onSpacePointerMove)
  spaceMount.value.addEventListener('pointerleave', onSpacePointerLeave)
  spaceMount.value.addEventListener('pointerdown', onSpacePointerDown)
  spaceAnimationFrame = requestAnimationFrame(animateSpaceScene)
}

function onSpacePointerMove(event: PointerEvent) {
  if (!spaceMount.value || !spaceCamera || !spaceCore) return
  const rect = spaceMount.value.getBoundingClientRect()
  spaceTargetMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  spaceTargetMouse.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
  spacePointer.set(spaceTargetMouse.x, spaceTargetMouse.y)
  spaceRaycaster.setFromCamera(spacePointer, spaceCamera)
  coreHovered = spaceRaycaster.intersectObjects(spaceCore.children, true).length > 0
  spaceMount.value.classList.toggle('is-core-hovered', coreHovered)
}

function onSpacePointerDown() {
  if (view.value === 'start' && coreHovered && !isPreparingBackend.value && !isJoinExpanded.value) createRoom()
}

function onSpacePointerLeave() {
  spaceTargetMouse = { x: 0, y: 0 }
  coreHovered = false
  spaceMount.value?.classList.remove('is-core-hovered')
}

function resizeSpaceScene() {
  if (!spaceRenderer || !spaceCamera || !spaceMount.value) return
  spaceCamera.aspect = spaceMount.value.clientWidth / spaceMount.value.clientHeight
  spaceCamera.updateProjectionMatrix()
  spaceRenderer.setSize(spaceMount.value.clientWidth, spaceMount.value.clientHeight)
}

function animateSpaceScene(time: number) {
  if (!spaceRenderer || !spaceScene || !spaceCamera) return
  const elapsed = (time - spaceStartedAt) * 0.001
  const motion = !reduceMotion.value
  spaceMouse.x += (spaceTargetMouse.x - spaceMouse.x) * 0.035
  spaceMouse.y += (spaceTargetMouse.y - spaceMouse.y) * 0.035
  if (motion) {
    const entering = appState.value === 'entering-room'
    spaceCamera.position.x = spaceMouse.x * 0.38 + Math.sin(elapsed * 0.16) * 0.08
    spaceCamera.position.y = 0.24 + spaceMouse.y * 0.18 + Math.cos(elapsed * 0.2) * 0.05
    spaceCamera.position.z = THREE.MathUtils.lerp(spaceCamera.position.z, entering ? 3.7 : 8, 0.02)
  }
  spaceCamera.lookAt(0, 0.05, -1.5)
  if (spaceStars && motion) spaceStars.rotation.y = elapsed * 0.006
  if (spaceParticles && motion) {
    spaceParticles.rotation.z = elapsed * (appState.value === 'creating-room' ? 0.32 : 0.08)
    spaceParticles.scale.setScalar(appState.value === 'creating-room' ? 0.72 + Math.sin(elapsed * 4) * 0.08 : 1)
  }
  if (spaceCore) {
    const active = coreHovered || appState.value !== 'initial'
    const targetScale = active ? 1.12 : 1
    spaceCore.scale.setScalar(targetScale + (motion ? Math.sin(elapsed * 2.2) * 0.035 : 0))
    if (motion) {
      spaceCore.rotation.x = Math.sin(elapsed * 0.4) * 0.12
      spaceCore.rotation.y = elapsed * 0.22
    }
  }
  if (spaceRemote) {
    const connected = ['connected', 'entering-room', 'inside-room', 'file-ready', 'transferring', 'completed'].includes(appState.value)
    const waiting = appState.value === 'waiting'
    spaceRemote.visible = connected || waiting
    const targetX = connected ? 1.65 : 4.5
    const targetZ = connected ? -2.2 : -6
    spaceRemote.position.x = THREE.MathUtils.lerp(spaceRemote.position.x, targetX, 0.025)
    spaceRemote.position.z = THREE.MathUtils.lerp(spaceRemote.position.z, targetZ, 0.025)
    spaceRemote.scale.setScalar(connected ? 1.6 : 1)
  }
  spaceRenderer.render(spaceScene, spaceCamera)
  spaceAnimationFrame = requestAnimationFrame(animateSpaceScene)
}

function disposeSpaceScene() {
  cancelAnimationFrame(spaceAnimationFrame)
  spaceResizeObserver?.disconnect()
  if (spaceMount.value) {
    spaceMount.value.removeEventListener('pointermove', onSpacePointerMove)
    spaceMount.value.removeEventListener('pointerleave', onSpacePointerLeave)
    spaceMount.value.removeEventListener('pointerdown', onSpacePointerDown)
  }
  disposeObject3D(spaceScene)
  spaceRenderer?.dispose()
  spaceRenderer?.domElement.remove()
  spaceRenderer = null
  spaceScene = null
  spaceCamera = null
  spaceCore = null
  spaceRemote = null
  spaceStars = null
  spaceParticles = null
}

watch([view, immersiveMode, renderQuality], async () => {
  disposeThreeScene()
  disposeSpaceScene()
  if (!immersiveMode.value) return
  await nextTick()
  if (view.value === 'connected') {
    cameraEntry = 0
    createThreeScene()
  } else {
    createSpaceScene()
  }
})

watch(roomCode, async () => {
  await nextTick()
  await renderRoomQrCode()
})

watch(isTransferring, (transferring) => {
  if (transferring) sceneTransferProgress = 0
})

onBeforeUnmount(disposeThreeScene)
onBeforeUnmount(disposeSpaceScene)
onBeforeUnmount(() => {
  stopQrScanner()
  roomConnection?.disconnect()
  directTransfer?.close()
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(roomEntryTimer)
  window.clearTimeout(pendingDownloadUrl)
})

onMounted(() => {
  hasWebGL.value = supportsWebGL()
  reduceMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const roomCodeFromUrl = new URLSearchParams(window.location.search).get('room')
  if (roomCodeFromUrl) joinRoomByCode(roomCodeFromUrl)
  else prepareOnStartup()
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-immersive': immersiveMode }">
    <header class="topbar">
      <button class="brand" type="button" @click="reset()" aria-label="PyDrop home">
        <img class="brand-symbol" src="/pydrop-icon-192.png" alt="" aria-hidden="true" />
        <span>PyDrop</span>
      </button>
      <div class="topbar-actions">
        <button class="text-control" type="button" @click="setLanguage">{{ language.toUpperCase() }}</button>
        <button v-if="immersiveMode" class="text-control" type="button" :aria-pressed="reduceMotion" @click="toggleReduceMotion">
          {{ reduceMotion ? copy.motionReduced : copy.reduceMotion }}
        </button>
        <label v-if="immersiveMode" class="quality-control">
          <span>{{ copy.quality }}</span>
          <select v-model="renderQuality">
            <option value="high">{{ copy.qualityHigh }}</option>
            <option value="balanced">{{ copy.qualityBalanced }}</option>
            <option value="reduced">{{ copy.qualityReduced }}</option>
          </select>
        </label>
        <button class="mode-link" type="button" @click="toggleImmersiveMode">
          {{ immersiveMode ? copy.exitImmersive : copy.enterImmersive }}
        </button>
      </div>
    </header>

    <section v-if="view === 'start' && !immersiveMode" class="standard-home page-enter">
      <div class="home-copy">
        <h1>{{ copy.headline }}</h1>
        <p>{{ copy.intro }}</p>
        <div class="home-actions">
          <button class="button button-primary" type="button" :disabled="isPreparingBackend" @click="createRoom">
            {{ isPreparingBackend ? preparingLabel : copy.create }}
          </button>
          <button class="button button-secondary" type="button" @click="isJoinExpanded = !isJoinExpanded">
            {{ copy.join }}
          </button>
        </div>
        <form v-if="isJoinExpanded" class="join-inline" @submit.prevent="submitJoinCode">
          <label for="room-code">{{ copy.codeLabel }}</label>
          <div>
            <input id="room-code" v-model="joinCode" inputmode="text" autocomplete="off" placeholder="A7K29XQ4" maxlength="9" />
            <button class="button button-primary" type="submit" :disabled="normalizedJoinCode.length !== 8 || isPreparingBackend">{{ copy.joinRoom }}</button>
          </div>
        </form>
        <div v-if="serverStatus !== 'idle'" class="server-preparation" aria-live="polite">
          <strong>{{ preparationTitle }}</strong>
          <span>{{ statusMessage }}</span>
          <small v-if="isPreparingBackend">{{ copy.elapsedTime }} {{ serverElapsedSeconds }}s.</small>
          <button v-if="serverStatus === 'failed'" class="button button-secondary" type="button" @click="retryConnection">{{ copy.retry }}</button>
        </div>
        <p class="microcopy">{{ copy.footer }}</p>
      </div>
      <div class="connection-visual" aria-hidden="true">
        <div class="signal-line signal-a"></div>
        <div class="signal-line signal-b"></div>
        <div class="device-node node-local"><span></span><strong>YOU</strong></div>
        <div class="device-node node-remote"><span></span><strong>OTHER DEVICE</strong></div>
        <div class="portal-mark"><span></span><span></span></div>
      </div>
      <div v-if="isMobileDevice" class="mobile-scan">
        <button class="button button-secondary" type="button" @click="startQrScanner">{{ copy.scanQr }}</button>
      </div>
    </section>

    <section v-else-if="view === 'start' && immersiveMode" class="immersive-view page-enter">
      <div v-if="hasWebGL" ref="spaceMount" class="space-world" aria-label="Interactive PyDrop 3D space"></div>
      <div v-else class="webgl-fallback">WebGL is unavailable. The simple PyDrop flow is still ready.</div>
      <div class="immersive-core-panel" aria-live="polite">
        <p>{{ appState === 'creating-room' ? preparingLabel : 'Temporary device portal' }}</p>
        <button class="portal-action" type="button" :disabled="isPreparingBackend" @click="createRoom">
          {{ isPreparingBackend ? preparingLabel : 'CREATE A ROOM' }}
        </button>
        <button class="ghost-action" type="button" @click="isJoinExpanded = !isJoinExpanded">{{ copy.join }}</button>
        <form v-if="isJoinExpanded" class="join-inline compact" @submit.prevent="submitJoinCode">
          <label for="immersive-room-code">{{ copy.codeLabel }}</label>
          <div>
            <input id="immersive-room-code" v-model="joinCode" inputmode="text" autocomplete="off" placeholder="A7K29XQ4" maxlength="9" />
            <button class="button button-primary" type="submit" :disabled="normalizedJoinCode.length !== 8 || isPreparingBackend">{{ copy.joinRoom }}</button>
          </div>
        </form>
      </div>
    </section>

    <section v-else-if="view === 'room'" class="room-lobby page-enter" :class="{ immersive: immersiveMode }">
      <div v-if="immersiveMode && hasWebGL" ref="spaceMount" class="space-world" aria-label="3D waiting room"></div>
      <div class="room-content" aria-live="polite">
        <p class="eyebrow">{{ immersiveMode ? 'ROOM' : copy.roomReady }}</p>
        <h1>{{ immersiveMode ? displayRoomCode : copy.roomReady }}</h1>
        <p>{{ statusMessage }}</p>
        <div class="room-code-panel">
          <span>{{ copy.codeLabel }}</span>
          <strong>{{ displayRoomCode }}</strong>
          <button class="button button-secondary" type="button" @click="copyRoomCode">{{ copy.copyCode }}</button>
          <small v-if="copyFeedback">{{ copyFeedback }}</small>
        </div>
        <div class="room-actions">
          <button v-if="serverStatus === 'failed'" class="button button-primary" type="button" @click="retryConnection">{{ copy.retryConnection }}</button>
          <button class="button button-secondary" type="button" @click="reset()">{{ copy.cancel }}</button>
        </div>
      </div>
      <div class="qr-block">
        <canvas ref="qrCanvas" aria-label="QR code to join this room"></canvas>
        <span>{{ copy.scanToJoin }}</span>
      </div>
    </section>

    <section v-else class="connected-view page-enter" :class="{ immersive: immersiveMode }">
      <div v-if="immersiveMode" class="immersive-room">
        <div v-if="hasWebGL" ref="threeMount" class="three-room" aria-label="3D transfer room"></div>
        <div class="immersive-room-hud">
          <div>
            <p class="eyebrow">{{ appState === 'completed' ? copy.complete : copy.connectedTitle }}</p>
            <h1>{{ appState === 'completed' ? copy.arrived : 'YOU + MY PHONE' }}</h1>
          </div>
          <button class="exit-button" type="button" @click="reset()">{{ copy.exitRoom }}</button>
        </div>
        <div class="scene-device-label scene-computer-label">YOU <small>Connected</small></div>
        <div class="scene-device-label scene-phone-label">MY PHONE <small>{{ deviceConnectionStatus === 'connected' ? 'Connected' : copy.deviceDisconnected }}</small></div>
      </div>

      <div v-else class="standard-connected">
        <div class="connected-copy">
          <p class="eyebrow">{{ transferComplete ? copy.complete : copy.connectedTitle }}</p>
          <h1>{{ transferComplete ? copy.arrived : copy.connectedBody }}</h1>
        </div>
        <div class="connection-visual connected" aria-hidden="true">
          <div class="signal-line signal-a"></div>
          <div class="signal-line signal-b"></div>
          <div class="device-node node-local"><span></span><strong>MY COMPUTER</strong></div>
          <div class="device-node node-remote"><span></span><strong>MY PHONE</strong></div>
          <div class="portal-mark"><span></span><span></span></div>
        </div>
      </div>

      <div v-if="deviceConnectionStatus === 'disconnected'" class="connection-lost-banner" role="alert">
        <strong>{{ copy.connectionLostTitle }}</strong>
        <span>{{ copy.connectionLostBody }}</span>
        <button v-if="appState === 'error'" class="button button-secondary" type="button" @click="retryConnection">{{ copy.retryConnection }}</button>
      </div>

      <div class="transfer-dock">
        <div class="dock-top">
          <span>{{ selectedFile ? selectedFile.name : 'Direct transfer' }}</span>
          <div class="direction-switch">
            <button :class="{ active: direction === 'send' }" type="button" @click="direction = 'send'">Send</button>
            <button :class="{ active: direction === 'receive' }" type="button" @click="direction = 'receive'">Receive</button>
          </div>
        </div>
        <label
          class="drop-zone"
          :class="{ 'has-file': selectedFile, 'is-drag-over': isDragOver, 'is-disabled': isTransferring }"
          @dragover="onDropZoneDragOver"
          @dragleave="onDropZoneDragLeave"
          @drop="onDropZoneDrop"
        >
          <input type="file" :disabled="isTransferring" @change="onFileSelected" />
          <span class="upload-mark" aria-hidden="true"></span>
          <span><strong>{{ fileLabel }}</strong><small>{{ selectedFile ? copy.fileSelected : copy.chooseOrDrag }}</small></span>
        </label>
        <div v-if="isTransferring || transferComplete" class="transfer-progress" aria-live="polite">
          <span>{{ transferComplete ? copy.complete : `${copy.sending} ${activeTransferName}` }}</span>
          <strong>{{ transferPercent }}%</strong>
        </div>
        <button class="transfer-button" :disabled="!canTransfer" type="button" @click="startTransfer">
          {{ deviceConnectionStatus === 'disconnected' ? copy.deviceDisconnected : isTransferring ? `${copy.sending}...` : transferComplete ? copy.sendAnother : copy.send }}
        </button>
      </div>
    </section>

    <div v-if="isScanningQr" class="qr-scanner-panel" role="dialog" aria-label="Scan a PyDrop room QR code">
      <video ref="qrVideo" playsinline></video>
      <p>{{ copy.scanQrDialog }}</p>
      <button class="button button-secondary" type="button" @click="stopQrScanner">{{ copy.cancelScan }}</button>
    </div>
  </main>
</template>

<style scoped>
.app-shell { background: var(--deep-space); color: var(--soft-white); min-height: 100svh; overflow: hidden; padding: 28px clamp(20px, 4vw, 58px); position: relative; }
.app-shell::before { background: radial-gradient(circle at 68% 28%, rgba(183, 243, 74, .08), transparent 32%), radial-gradient(circle at 84% 64%, rgba(255, 107, 94, .08), transparent 30%); content: ''; inset: 0; pointer-events: none; position: absolute; }
.topbar { align-items: center; display: flex; gap: 24px; justify-content: space-between; margin: 0 auto; max-width: 1220px; position: relative; z-index: 10; }
.brand { align-items: center; background: transparent; border: 0; color: var(--soft-white); display: flex; font-family: var(--font-brand); font-size: 21px; font-weight: 700; gap: 12px; padding: 0; }
.brand-symbol { display: block; height: 34px; object-fit: contain; width: 42px; }
.topbar-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-end; }
.text-control, .mode-link, .quality-control select { background: rgba(18, 24, 28, .76); border: 1px solid var(--quiet-border); color: var(--soft-white); font-size: 12px; padding: 10px 12px; }
.quality-control { align-items: center; color: var(--muted-gray); display: flex; font-size: 11px; gap: 8px; }
.mode-link { color: var(--lime-flow); }
.standard-home { align-items: center; display: grid; gap: clamp(28px, 6vw, 88px); grid-template-columns: minmax(0, .9fr) minmax(360px, 1.1fr); margin: 0 auto; max-width: 1220px; min-height: calc(100svh - 90px); position: relative; z-index: 2; }
.home-copy h1, .connected-copy h1, .room-content h1 { font-family: var(--font-brand); font-size: clamp(3.6rem, 7vw, 7.4rem); font-weight: 700; letter-spacing: 0; line-height: .9; max-width: 760px; white-space: pre-line; }
.home-copy p, .connected-copy p, .room-content p { color: var(--muted-gray); font-size: 18px; margin-top: 24px; max-width: 480px; }
.home-actions, .room-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 14px; margin-top: 34px; }
.button, .transfer-button { border: 0; font-weight: 750; min-height: 46px; padding: 0 18px; transition: transform .2s ease, border-color .2s ease, background .2s ease; }
.button:hover, .transfer-button:hover, .mode-link:hover { transform: translateY(-1px); }
.button-primary { background: var(--lime-flow); color: var(--deep-space); }
.button-primary:disabled, .transfer-button:disabled { cursor: not-allowed; opacity: .45; transform: none; }
.button-secondary { background: var(--graphite); border: 1px solid var(--quiet-border); color: var(--soft-white); }
.join-inline { background: rgba(18, 24, 28, .7); border: 1px solid var(--quiet-border); margin-top: 18px; max-width: 500px; padding: 14px; }
.join-inline label { color: var(--muted-gray); display: block; font-size: 12px; margin-bottom: 8px; }
.join-inline div { display: grid; gap: 10px; grid-template-columns: 1fr auto; }
.join-inline input { background: var(--deep-space); border: 1px solid var(--quiet-border); color: var(--soft-white); font-family: var(--font-mono); min-width: 0; padding: 0 13px; text-transform: uppercase; }
.join-inline.compact { background: rgba(11, 15, 18, .58); margin-inline: auto; width: min(480px, 100%); }
.microcopy { color: var(--muted-gray); font-size: 13px; margin-top: 28px; }
.server-preparation { border-left: 2px solid var(--lime-flow); color: var(--muted-gray); display: grid; gap: 6px; margin-top: 24px; padding-left: 14px; }
.server-preparation strong { color: var(--soft-white); }
.connection-visual { aspect-ratio: 1.25; min-height: 390px; position: relative; }
.connection-visual::before { border: 1px solid rgba(244, 247, 242, .06); content: ''; inset: 9% 5%; position: absolute; transform: skewY(-5deg); }
.signal-line { background: linear-gradient(90deg, transparent, rgba(183, 243, 74, .72), rgba(255, 107, 94, .62), transparent); height: 1px; left: 20%; position: absolute; top: 50%; transform-origin: center; width: 60%; }
.signal-a { transform: rotate(-11deg); }
.signal-b { opacity: .52; transform: rotate(13deg); }
.device-node { align-items: center; display: grid; gap: 11px; justify-items: center; position: absolute; }
.device-node span { border-radius: 50%; box-shadow: 0 0 38px currentColor; display: block; height: 18px; width: 18px; }
.device-node strong { color: var(--muted-gray); font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em; }
.node-local { color: var(--lime-flow); left: 12%; top: 42%; }
.node-remote { color: var(--coral-signal); right: 10%; top: 54%; }
.portal-mark { display: grid; height: 112px; left: 50%; place-items: center; position: absolute; top: 48%; transform: translate(-50%, -50%); width: 146px; }
.portal-mark span { border: 2px solid var(--lime-flow); border-radius: 999px; height: 78px; position: absolute; transform: translateX(-24px) rotate(-24deg); width: 78px; }
.portal-mark span:last-child { border-color: var(--coral-signal); transform: translateX(24px) rotate(24deg); }
.mobile-scan { bottom: 28px; position: absolute; right: 0; }
.immersive-view, .room-lobby.immersive, .connected-view.immersive { height: calc(100svh - 90px); margin: 0 calc(clamp(20px, 4vw, 58px) * -1) -28px; position: relative; }
.space-world, .three-room { background: var(--deep-space); inset: 0; overflow: hidden; position: absolute; z-index: 0; }
.space-world::after, .three-room::after { background: radial-gradient(ellipse at center, transparent 46%, rgba(4, 7, 9, .78) 100%); content: ''; inset: 0; pointer-events: none; position: absolute; }
.space-world canvas, .three-room canvas { display: block; height: 100%; width: 100%; }
.space-world.is-core-hovered { cursor: pointer; }
.immersive-core-panel { bottom: 8vh; left: 50%; position: absolute; text-align: center; transform: translateX(-50%); width: min(720px, calc(100% - 42px)); z-index: 3; }
.immersive-core-panel p, .eyebrow { color: var(--muted-gray); font-family: var(--font-mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
.portal-action { background: rgba(183, 243, 74, .12); border: 1px solid rgba(183, 243, 74, .82); box-shadow: 0 0 30px rgba(183, 243, 74, .12), inset 0 0 22px rgba(183, 243, 74, .06); color: var(--lime-flow); font-family: var(--font-brand); font-size: clamp(2rem, 4.5vw, 4.5rem); font-weight: 700; margin-top: 16px; padding: 12px 24px; width: 100%; }
.ghost-action { background: transparent; border: 0; color: var(--muted-gray); margin-top: 14px; }
.webgl-fallback { display: grid; inset: 0; place-items: center; position: absolute; z-index: 2; }
.room-lobby { align-items: center; display: grid; gap: 34px; grid-template-columns: minmax(0, 1fr) auto; margin: 0 auto; max-width: 1120px; min-height: calc(100svh - 90px); position: relative; z-index: 2; }
.room-lobby.immersive { display: block; max-width: none; min-height: 0; }
.room-lobby.immersive .room-content { left: clamp(20px, 6vw, 82px); position: absolute; top: 14vh; z-index: 2; }
.room-content h1 { font-size: clamp(3.2rem, 6vw, 6.3rem); }
.room-code-panel { background: rgba(18, 24, 28, .78); border: 1px solid var(--quiet-border); display: grid; gap: 11px; margin-top: 28px; max-width: 380px; padding: 18px; }
.room-code-panel span, .room-code-panel small { color: var(--muted-gray); font-size: 12px; }
.room-code-panel strong { color: var(--lime-flow); font-family: var(--font-mono); font-size: clamp(2.1rem, 5vw, 4.2rem); letter-spacing: .04em; }
.qr-block { align-items: center; color: var(--muted-gray); display: grid; gap: 12px; justify-items: center; position: relative; z-index: 2; }
.qr-block canvas { border: 1px solid var(--quiet-border); height: 156px; width: 156px; }
.connected-view { margin: 0 auto; max-width: 1120px; min-height: calc(100svh - 90px); padding-top: 5vh; position: relative; z-index: 2; }
.standard-connected { align-items: center; display: grid; gap: 42px; grid-template-columns: minmax(0, .8fr) minmax(340px, 1fr); }
.standard-connected .connection-visual { min-height: 300px; }
.immersive-room { height: 100%; position: relative; }
.immersive-room-hud { align-items: flex-start; display: flex; justify-content: space-between; left: clamp(20px, 5vw, 70px); position: absolute; right: clamp(20px, 5vw, 70px); top: 32px; z-index: 4; }
.immersive-room-hud h1 { font-family: var(--font-brand); font-size: clamp(2.1rem, 4vw, 4.2rem); font-weight: 700; }
.exit-button { background: rgba(18, 24, 28, .72); border: 1px solid var(--quiet-border); color: var(--soft-white); padding: 11px 14px; }
.scene-device-label { background: rgba(18, 24, 28, .74); border: 1px solid rgba(244, 247, 242, .12); color: var(--soft-white); font-family: var(--font-mono); font-size: 12px; padding: 10px 12px; position: absolute; z-index: 3; }
.scene-device-label small { color: var(--muted-gray); display: block; margin-top: 4px; }
.scene-computer-label { bottom: 25%; left: 16%; }
.scene-phone-label { bottom: 25%; right: 16%; }
.connection-lost-banner { background: rgba(255, 89, 100, .12); border: 1px solid rgba(255, 89, 100, .55); color: var(--soft-white); display: grid; gap: 4px; margin: 16px 0; padding: 14px; }
.connection-lost-banner .button { justify-self: start; margin-top: 6px; }
.transfer-dock { background: rgba(18, 24, 28, .92); border: 1px solid var(--quiet-border); bottom: 24px; left: 50%; max-width: 760px; padding: 17px; position: fixed; transform: translateX(-50%); width: min(760px, calc(100% - 40px)); z-index: 7; }
.dock-top { align-items: center; display: flex; justify-content: space-between; margin-bottom: 13px; }
.dock-top > span { color: var(--muted-gray); font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.direction-switch { border: 1px solid var(--quiet-border); display: flex; padding: 3px; }
.direction-switch button { background: transparent; border: 0; color: var(--muted-gray); font-size: 12px; padding: 7px 11px; }
.direction-switch button.active { background: var(--lime-flow); color: var(--deep-space); }
.drop-zone { align-items: center; border: 1px dashed rgba(244, 247, 242, .22); cursor: pointer; display: flex; gap: 14px; min-height: 58px; padding: 10px 13px; transition: background .15s ease, border-color .15s ease; }
.drop-zone:hover, .drop-zone.has-file { background: rgba(183, 243, 74, .05); border-color: var(--lime-flow); }
.drop-zone.is-drag-over { background: rgba(183, 243, 74, .12); border-color: var(--lime-flow); border-style: solid; }
.drop-zone.is-disabled { cursor: not-allowed; opacity: .55; }
.drop-zone input { display: none; }
.upload-mark { border: 2px solid var(--lime-flow); border-radius: 999px; height: 30px; position: relative; width: 30px; }
.upload-mark::before, .upload-mark::after { background: var(--lime-flow); content: ''; left: 50%; position: absolute; top: 50%; transform: translate(-50%, -50%); }
.upload-mark::before { height: 13px; width: 2px; }
.upload-mark::after { height: 2px; width: 13px; }
.drop-zone strong, .drop-zone small { display: block; }
.drop-zone small { color: var(--muted-gray); font-size: 12px; margin-top: 2px; }
.transfer-progress { align-items: center; color: var(--muted-gray); display: flex; justify-content: space-between; margin: 12px 0 0; }
.transfer-progress strong { color: var(--lime-flow); font-family: var(--font-mono); }
.transfer-button { background: var(--coral-signal); color: var(--deep-space); margin-top: 12px; width: 100%; }
.qr-scanner-panel { background: rgba(11, 15, 18, .96); border: 1px solid var(--quiet-border); box-shadow: 0 24px 80px rgba(0, 0, 0, .42); display: grid; gap: 14px; left: 50%; padding: 18px; position: fixed; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100% - 34px)); z-index: 20; }
.qr-scanner-panel video { background: #000; width: 100%; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
}

@media (max-width: 820px) {
  .app-shell { padding: 20px; }
  .topbar { align-items: flex-start; }
  .topbar-actions { gap: 8px; }
  .quality-control span { display: none; }
  .standard-home, .standard-connected, .room-lobby { display: flex; flex-direction: column; justify-content: center; min-height: calc(100svh - 76px); }
  .home-copy h1, .connected-copy h1, .room-content h1 { font-size: clamp(3rem, 14vw, 5rem); }
  .connection-visual { min-height: 300px; width: 100%; }
  .join-inline div { grid-template-columns: 1fr; }
  .immersive-view, .room-lobby.immersive, .connected-view.immersive { height: calc(100svh - 76px); margin: 0 -20px -20px; }
  .room-lobby.immersive .room-content { left: 20px; right: 20px; top: 12vh; }
  .qr-block { display: none; }
  .immersive-room-hud { display: grid; gap: 12px; left: 20px; right: 20px; }
  .scene-computer-label { bottom: 28%; left: 20px; }
  .scene-phone-label { bottom: 28%; right: 20px; }
  .transfer-dock { bottom: 14px; width: calc(100% - 28px); }
}
</style>