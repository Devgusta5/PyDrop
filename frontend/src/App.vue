<script setup lang="ts">
import QrScanner from 'qr-scanner'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from './api'
import { dictionaries, type Copy, type Language } from './copy'
import PortalMark from './components/PortalMark.vue'
import ConnectionField from './components/ConnectionField.vue'
import TransferDock from './components/TransferDock.vue'
import RoomQr from './components/RoomQr.vue'
import ClipboardNote from './components/ClipboardNote.vue'
import HelpGuide from './components/HelpGuide.vue'

type View = 'start' | 'room' | 'connected'
type AppState =
  | 'initial'
  | 'creating-room'
  | 'waiting'
  | 'connected'
  | 'selecting-file'
  | 'file-ready'
  | 'transferring'
  | 'completed'
  | 'error'
type EntryMode = 'create' | 'join' | null
interface AppError {
  title: string
  body: string
  action?: 'retry' | 'newRoom'
}

const view = ref<View>('start')
const appState = ref<AppState>('initial')
const language = ref<Language>('pt')
const direction = ref<api.TransferMode>('send')
const remoteDirection = ref<api.TransferMode>('send')
const selectedFile = ref<File | null>(null)
const queue = ref<File[]>([])
interface SharedItem {
  name: string
  size: number
  direction: 'sent' | 'received'
  at: number
  /** Only set for received files, and only while their blob is still in memory. */
  url?: string
}
const shared = ref<SharedItem[]>([])
const noteText = ref('')
const remoteNoteText = ref('')
let noteSendTimer = 0
const showHelp = ref(false)
const peerLeftAt = ref(0)
const peerLeftSeconds = ref(0)
// The window between losing the peer and admitting it: the app is retrying.
const isReconnecting = ref(false)
const reconnectingStage = ref(0)
const activeTransferName = ref('')
const isTransferring = ref(false)
const transferComplete = ref(false)
const transferPercent = ref(0)
const receivePercent = ref(0)
const isReceiving = ref(false)
const incomingName = ref('')
const roomCode = ref('')
const joinCode = ref('')
const entryMode = ref<EntryMode>(null)
const isJoinExpanded = ref(false)
const isDragOver = ref(false)
const copyFeedback = ref('')
const notice = ref<AppError | null>(null)
const isOffline = ref(false)
const installPrompt = ref<{ prompt: () => Promise<void> } | null>(null)
const qrVideo = ref<HTMLVideoElement | null>(null)
const joinInput = ref<HTMLInputElement | null>(null)
const isScanningQr = ref(false)
const serverStatus = ref<'idle' | 'checking' | 'waking_up' | 'ready' | 'connecting_ws' | 'connected' | 'failed'>('idle')
const serverElapsedSeconds = ref(0)
const roomFull = ref(false)
const completedTransfers = ref(0)
const deviceConnectionStatus = ref<'connecting' | 'connected' | 'disconnected'>('connecting')

let qrScanner: QrScanner | null = null
let roomConnection: ReturnType<typeof api.connectRoomSocket> | null = null
let directTransfer: api.DirectTransfer | null = null
let reconnectTimer = 0
let reconnectAttempts = 0
let noticeTimer = 0
// Bumped on every deliberate (re)connect so a stale socket's disconnect cannot
// trigger a reconnect loop for a connection we already tore down.
let connectionGeneration = 0
let peerLeftTimer = 0
let peerGraceTimer = 0
let reconnectStageTimer = 0
const ROOM_LIFETIME_SECONDS = 60 * 60
const PEER_GRACE_MS = 20_000
const RECONNECT_STAGES = 3

const copy = computed<Copy>(() => dictionaries[language.value])

const isMobile = computed(() => /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent))
const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as unknown as { standalone?: boolean }).standalone === true
const showInstallHint = ref(false)
const canOfferInstall = computed(() => isMobile.value && !isStandalone)
const installHintBody = computed(() =>
  isIos ? copy.value.installAppIosBody : copy.value.installAppAndroidBody,
)
const reconnectingMessage = computed(() => copy.value.reconnectingStages[reconnectingStage.value])
const isPreparingBackend = computed(() =>
  ['checking', 'waking_up', 'connecting_ws'].includes(serverStatus.value),
)
const preparingLabel = computed(() =>
  entryMode.value === 'join' ? copy.value.joiningRoom : copy.value.creatingRoom,
)
const fileLabel = computed(() => selectedFile.value?.name ?? copy.value.choose)
const queuedBytes = computed(() => queue.value.reduce((n, f) => n + f.size, 0))
const expiryClock = computed(() => {
  const m = Math.floor(peerLeftSeconds.value / 60)
  const sec = peerLeftSeconds.value % 60
  return `${m}:${String(sec).padStart(2, '0')}`
})
const displayRoomCode = computed(() => formatRoomCode(roomCode.value))
const joinUrl = computed(() => {
  if (!roomCode.value) return ''
  const base = import.meta.env.VITE_PUBLIC_APP_URL || 'https://pydrop.vercel.app'
  const url = new URL(base)
  url.search = ''
  url.searchParams.set('room', roomCode.value)
  return url.toString()
})
const normalizedJoinCode = computed(() => joinCode.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())
const canTransfer = computed(
  () =>
    queue.value.length > 0 &&
    !isTransferring.value &&
    direction.value === 'send' &&
    deviceConnectionStatus.value === 'connected',
)
const bothReceiving = computed(
  () => direction.value === 'receive' && remoteDirection.value === 'receive',
)
const peerModeMessage = computed(() => {
  if (deviceConnectionStatus.value !== 'connected') return ''
  if (bothReceiving.value) return copy.value.bothReceiving
  return remoteDirection.value === 'receive' ? copy.value.otherIsReceiving : copy.value.otherIsSending
})
const connectionPhase = computed<'idle' | 'searching' | 'linking' | 'linked'>(() => {
  if (deviceConnectionStatus.value === 'connected') return 'linked'
  if (view.value === 'connected') return 'linking'
  if (view.value === 'room' || isPreparingBackend.value) return 'searching'
  return 'idle'
})
const liveFlow = computed(() => {
  if (isTransferring.value) return transferPercent.value / 100
  if (isReceiving.value) return receivePercent.value / 100
  return -1
})

function formatRoomCode(code: string) {
  return code ? code.replace(/^(.{4})(.{4})$/, '$1-$2') : '••••-••••'
}

function setAppState(state: AppState) {
  appState.value = state
}

function showError(title: string, body: string, action?: AppError['action']) {
  notice.value = { title, body, action }
  window.clearTimeout(noticeTimer)
  if (!action) noticeTimer = window.setTimeout(() => { notice.value = null }, 7000)
}

function dismissNotice() {
  window.clearTimeout(noticeTimer)
  notice.value = null
}

function setLanguage() {
  language.value = language.value === 'en' ? 'pt' : 'en'
  document.documentElement.lang = language.value
}

function setDirection(mode: api.TransferMode) {
  if (direction.value === mode) return
  direction.value = mode
  if (mode === 'receive') selectedFile.value = null
  directTransfer?.setMode(mode)
}

// ------------------------------------------------------------------ room flow

async function prepareBackend() {
  await api.ensureBackendReady((state, elapsedSeconds) => {
    serverElapsedSeconds.value = elapsedSeconds
    if (state === 'checking') serverStatus.value = 'checking'
    if (state === 'waking_up') serverStatus.value = 'waking_up'
    if (state === 'ready') serverStatus.value = 'ready'
  })
}

/** Shared tail of every room-entry path: prepare the backend, then connect. */
async function connectRoom(beforeConnect?: () => Promise<void>) {
  setAppState('creating-room')
  try {
    await prepareBackend()
    await beforeConnect?.()
    setAppState('waiting')
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry')
  }
}

async function createRoom() {
  if (isOffline.value) {
    showError(copy.value.offline, copy.value.offlineBody)
    return
  }
  entryMode.value = 'create'
  direction.value = 'receive'
  view.value = 'room'
  copyFeedback.value = ''
  dismissNotice()
  await connectRoom(async () => {
    const result = await api.createRoom()
    roomCode.value = result.code
  })
}

async function joinRoomByCode(rawCode: string) {
  const code = rawCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    if (code) showError(copy.value.invalidCode, copy.value.codeLabel)
    return
  }
  if (isOffline.value) {
    showError(copy.value.offline, copy.value.offlineBody)
    return
  }
  entryMode.value = 'join'
  roomCode.value = code
  view.value = 'room'
  dismissNotice()
  await connectRoom()
}

function submitJoinCode() {
  joinRoomByCode(joinCode.value)
}

async function expandJoin() {
  isJoinExpanded.value = !isJoinExpanded.value
  if (!isJoinExpanded.value) return
  await nextTick()
  joinInput.value?.focus()
}

async function retryConnection() {
  dismissNotice()
  if (!roomCode.value) {
    await createRoom()
    return
  }
  await connectRoom()
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
      clearPeerLeft()
      if (sessions > 1) handleDevicesConnected(true)
    },
    onUserLeft: () => {
      if (myGeneration !== connectionGeneration) return
      handlePeerLost()
    },
    onSignal: (message) => {
      directTransfer?.handleSignal(message).catch(() =>
        showError(copy.value.transferFailed, copy.value.transferFailedBody),
      )
    },
    onTransferCount: (count) => {
      completedTransfers.value = count
    },
    onDisconnect: () => {
      if (myGeneration !== connectionGeneration) return
      if (roomFull.value) return
      if (reconnectAttempts >= 6) {
        serverStatus.value = 'failed'
        setAppState('error')
        showError(copy.value.connectionLostTitle, copy.value.connectionLostBody, 'retry')
        return
      }
      reconnectAttempts += 1
      serverStatus.value = 'connecting_ws'
      if (view.value === 'connected') beginReconnecting()
      const delay = Math.min(400 * 2 ** (reconnectAttempts - 1), 5_000)
      reconnectTimer = window.setTimeout(() => connectToRoom(), delay)
    },
    onClose: (code) => {
      if (myGeneration !== connectionGeneration) return
      if (code === 1008) {
        roomFull.value = true
        serverStatus.value = 'failed'
        setAppState('error')
        window.clearTimeout(reconnectTimer)
        showError(copy.value.roomFull, copy.value.roomFullBody, 'newRoom')
      }
    },
  })
}

// #10 Rooms live one hour; once alone, say how long is left rather than nothing.
function startPeerLeftCountdown() {
  if (peerLeftAt.value) return
  peerLeftAt.value = Date.now()
  const tick = () => {
    const left = ROOM_LIFETIME_SECONDS - Math.floor((Date.now() - peerLeftAt.value) / 1000)
    peerLeftSeconds.value = Math.max(0, left)
    if (peerLeftSeconds.value === 0) window.clearInterval(peerLeftTimer)
  }
  tick()
  peerLeftTimer = window.setInterval(tick, 1000)
}

function clearPeerLeft() {
  window.clearInterval(peerLeftTimer)
  window.clearTimeout(peerGraceTimer)
  window.clearInterval(reconnectStageTimer)
  isReconnecting.value = false
  reconnectingStage.value = 0
  peerLeftAt.value = 0
  peerLeftSeconds.value = 0
}

function handlePeerLost() {
  directTransfer?.close()
  directTransfer = null
  deviceConnectionStatus.value = 'disconnected'
  beginReconnecting()
}

function beginReconnecting() {
  if (isReconnecting.value) return
  isReconnecting.value = true
  reconnectingStage.value = 0

  const startedAt = Date.now()
  const stageLength = PEER_GRACE_MS / RECONNECT_STAGES
  window.clearInterval(reconnectStageTimer)
  reconnectStageTimer = window.setInterval(() => {
    const elapsed = Date.now() - startedAt
    reconnectingStage.value = Math.min(Math.floor(elapsed / stageLength), RECONNECT_STAGES - 1)
  }, 500)

  window.clearTimeout(peerGraceTimer)
  peerGraceTimer = window.setTimeout(() => {
    isReconnecting.value = false
    window.clearInterval(reconnectStageTimer)
    startPeerLeftCountdown()
  }, PEER_GRACE_MS)
}

function handleDevicesConnected(initiator: boolean) {
  clearPeerLeft()
  dismissNotice()
  setupDirectTransfer(initiator)
  view.value = 'connected'
  deviceConnectionStatus.value = 'connecting'
  serverStatus.value = 'connected'
  reconnectAttempts = 0
  setAppState('connected')
}

function setupDirectTransfer(initiator: boolean) {
  if (directTransfer || !roomConnection) return
  directTransfer = new api.DirectTransfer(
    (message) => roomConnection?.send(message),
    () => {
      deviceConnectionStatus.value = 'connected'
    },
    (file, blob) => {
      // Kept alive for the rest of the session (not revoked like a one-shot
      // download link) so the ledger below can reopen the same file later.
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      isReceiving.value = false
      receivePercent.value = 100
      incomingName.value = file.name
      shared.value = [
        { name: file.name, size: file.size, direction: 'received', at: Date.now(), url },
        ...shared.value,
      ]
      if (!isTransferring.value) {
        transferComplete.value = true
        setAppState('completed')
      }
    },
    (progress, mode) => {
      if (mode === 'receive') {
        isReceiving.value = true
        receivePercent.value = Math.round(progress * 100)
        return
      }
      transferPercent.value = Math.round(progress * 100)
    },
    () => showError(copy.value.transferFailed, copy.value.transferFailedBody),
    () => {
      if (view.value === 'connected') {
        isTransferring.value = false
        handlePeerLost()
      }
    },
    (mode) => { remoteDirection.value = mode },
    () => {
      deviceConnectionStatus.value = 'connected'
      clearPeerLeft()
    },
    (text) => { remoteNoteText.value = text },
  )
  directTransfer.setMode(direction.value)
  directTransfer.start(initiator).catch(() =>
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry'),
  )
}

// ------------------------------------------------------------- shared note

// Debounced so every keystroke doesn't open its own DataChannel message.
function updateNote(text: string) {
  noteText.value = text
  window.clearTimeout(noteSendTimer)
  noteSendTimer = window.setTimeout(() => directTransfer?.sendNote(text), 150)
}

async function copyRemoteNote() {
  if (!remoteNoteText.value) return
  try {
    await navigator.clipboard.writeText(remoteNoteText.value)
  } catch {
    // Clipboard permission denied — the text is still visible to copy by hand.
  }
}

// ------------------------------------------------------------------ room code

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
  qrScanner = new QrScanner(
    qrVideo.value,
    (result) => {
      const value = typeof result === 'string' ? result : result.data
      try {
        const code = new URL(value).searchParams.get('room')
        if (!code) throw new Error('not a room')
        stopQrScanner()
        joinRoomByCode(code)
      } catch {
        showError(copy.value.invalidQr, copy.value.codeLabel)
      }
    },
    { highlightScanRegion: true, highlightCodeOutline: true },
  )
  try {
    await qrScanner.start()
  } catch {
    stopQrScanner()
    showError(copy.value.cameraRequired, copy.value.cameraRequiredBody)
  }
}

function stopQrScanner() {
  qrScanner?.stop()
  qrScanner?.destroy()
  qrScanner = null
  isScanningQr.value = false
}

let scrollBeforeScan = 0
watch(isScanningQr, (scanning) => {
  if (scanning) {
    scrollBeforeScan = window.scrollY
    document.body.style.top = `-${scrollBeforeScan}px`
    document.body.classList.add('scan-lock')
    return
  }
  document.body.classList.remove('scan-lock')
  document.body.style.top = ''
  // Fixing the body collapses the scroll position, so put it back by hand.
  window.scrollTo(0, scrollBeforeScan)
})

// --------------------------------------------------------------------- files

function acceptFiles(files: File[]) {
  const rejected: string[] = []
  for (const file of files) {
    if (api.validateTransferFile(file)) rejected.push(file.name)
    else if (!queue.value.some((q) => q.name === file.name && q.size === file.size)) {
      queue.value = [...queue.value, file]
    }
  }
  if (rejected.length) showError(copy.value.fileTooLarge, copy.value.fileTooLargeBody)
  selectedFile.value = queue.value[0] ?? null
  transferComplete.value = false
  transferPercent.value = 0
  setAppState(queue.value.length ? 'file-ready' : 'connected')
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  acceptFiles(Array.from(input.files ?? []))
  // Always reset, so picking the same file twice still fires a change event.
  input.value = ''
}

function removeQueued(index: number) {
  queue.value = queue.value.filter((_, i) => i !== index)
  selectedFile.value = queue.value[0] ?? null
  if (!queue.value.length) setAppState('connected')
}

function clearFile() {
  queue.value = []
  selectedFile.value = null
  transferPercent.value = 0
  transferComplete.value = false
  setAppState('connected')
}

function onDragOver(event: DragEvent) {
  if (isTransferring.value) return
  event.preventDefault()
  isDragOver.value = true
}

function onDragLeave() {
  isDragOver.value = false
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  isDragOver.value = false
  if (isTransferring.value) return
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) acceptFiles(files)
}

async function startTransfer() {
  if (!queue.value.length || !directTransfer || deviceConnectionStatus.value !== 'connected') return
  isTransferring.value = true
  transferComplete.value = false
  setAppState('transferring')
  // One file at a time over the single channel; the queue drains in order.
  const batch = [...queue.value]
  try {
    for (const file of batch) {
      activeTransferName.value = file.name
      transferPercent.value = 0
      await directTransfer.sendFile(file)
      shared.value = [
        { name: file.name, size: file.size, direction: 'sent', at: Date.now() },
        ...shared.value,
      ]
      queue.value = queue.value.filter((q) => q !== file)
    }
    transferComplete.value = true
    transferPercent.value = 100
    selectedFile.value = null
    setAppState('completed')
  } catch {
    setAppState('error')
    showError(copy.value.transferFailed, copy.value.transferFailedBody)
  } finally {
    isTransferring.value = false
  }
}

function revokeSharedUrls() {
  for (const item of shared.value) if (item.url) URL.revokeObjectURL(item.url)
}

function reset(force = false) {
  if (!force && isTransferring.value && !window.confirm(copy.value.confirmLeave)) return
  stopQrScanner()
  dismissNotice()
  connectionGeneration += 1
  window.clearTimeout(reconnectTimer)
  clearPeerLeft()
  roomConnection?.disconnect()
  directTransfer?.close()
  roomConnection = null
  directTransfer = null
  view.value = 'start'
  setAppState('initial')
  direction.value = 'send'
  remoteDirection.value = 'send'
  selectedFile.value = null
  queue.value = []
  revokeSharedUrls()
  shared.value = []
  window.clearTimeout(noteSendTimer)
  noteText.value = ''
  remoteNoteText.value = ''
  activeTransferName.value = ''
  incomingName.value = ''
  transferComplete.value = false
  isTransferring.value = false
  isReceiving.value = false
  transferPercent.value = 0
  receivePercent.value = 0
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
}

function handleNoticeAction(action: AppError['action']) {
  if (action === 'retry') retryConnection()
  if (action === 'newRoom') {
    reset(true)
    createRoom()
  }
}

// ------------------------------------------------------------------ lifecycle

async function installApp() {
  const event = installPrompt.value
  // Without a captured prompt there is no way to open the native install flow,
  // so show where the browser keeps it instead of doing nothing.
  if (!event) {
    showInstallHint.value = true
    return
  }
  installPrompt.value = null
  await event.prompt()
}

const handleInstallPrompt = (event: Event) => {
  event.preventDefault()
  installPrompt.value = event as unknown as { prompt: () => Promise<void> }
}

const handleOnline = () => { isOffline.value = false }
const handleOffline = () => { isOffline.value = true }

// A phone backgrounding the tab (e.g. to show the file picker) throttles our
// timers, so the signaling socket's own retry budget can run out silently
// while hidden. Coming back to the foreground is a much stronger signal that
// it's worth trying again than a fixed number of background-timer retries.
const handleVisibilityChange = () => {
  if (document.visibilityState !== 'visible') return
  if (view.value === 'start' || !roomCode.value || roomFull.value) return
  if (serverStatus.value === 'connected') return
  // A pending retry may be sitting on a timer the browser froze while hidden,
  // so don't wait for it — coming back is the moment to try again.
  window.clearTimeout(reconnectTimer)
  reconnectAttempts = 0
  connectToRoom()
}

onMounted(() => {
  isOffline.value = !navigator.onLine
  document.documentElement.lang = language.value
  window.addEventListener('beforeinstallprompt', handleInstallPrompt)
  window.addEventListener('appinstalled', () => { installPrompt.value = null })
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  const roomFromUrl = new URLSearchParams(window.location.search).get('room')
  if (roomFromUrl) joinRoomByCode(roomFromUrl)
  else prepareBackend().catch(() => { serverStatus.value = 'failed' })

  // The badge is optional decoration — never block startup on it. It still has
  // to wait for the backend, or a sleeping Render answers nothing and the
  // count stays at zero for the whole visit.
  loadTransferStats()
})

async function loadTransferStats() {
  try {
    await api.ensureBackendReady()
    const stats = await api.getTransferStats()
    completedTransfers.value = stats.completed_transfers
  } catch {
    // Leave the badge at its current value; the socket updates it later.
  }
}

onBeforeUnmount(() => {
  stopQrScanner()
  document.body.classList.remove('scan-lock')
  document.body.style.top = ''
  roomConnection?.disconnect()
  directTransfer?.close()
  window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(peerGraceTimer)
  window.clearInterval(peerLeftTimer)
  window.clearInterval(reconnectStageTimer)
  window.clearTimeout(noticeTimer)
  window.clearTimeout(noteSendTimer)
  revokeSharedUrls()
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <button class="brand" type="button" @click="reset()">
        <PortalMark :size="30" />
        <span class="wordmark">PyDrop</span>
        <span class="visually-hidden">— {{ copy.tagline }}</span>
      </button>

      <div class="controls">
        <button class="chip help" type="button" :aria-label="copy.help" @click="showHelp = true">?</button>
        <button class="chip lang" type="button" :aria-label="copy.language" @click="setLanguage">
          <span class="flag" aria-hidden="true">
            <svg v-if="language === 'pt'" viewBox="0 0 24 16">
              <rect width="24" height="16" fill="#B31942" />
              <path d="M0 1.85h24v1.84H0zm0 3.69h24v1.85H0zm0 3.69h24v1.85H0zm0 3.7h24v1.84H0z" fill="#fff" />
              <rect width="10.5" height="8.6" fill="#0A3161" />
            </svg>
            <svg v-else viewBox="0 0 24 16">
              <rect width="24" height="16" fill="#009B3A" />
              <path d="M12 2.3 21.6 8 12 13.7 2.4 8z" fill="#FEDF00" />
              <circle cx="12" cy="8" r="3.4" fill="#002776" />
              <path d="M8.9 6.8a7.4 7.4 0 0 1 6.3 2" stroke="#fff" stroke-width=".85" fill="none" />
            </svg>
          </span>
          {{ language === 'pt' ? 'EN' : 'PT' }}
        </button>
      </div>
    </header>

    <!-- ------------------------------------------------- start -->
    <main v-if="view === 'start'" class="stage start">
      <div class="pitch">
        <h1>{{ copy.headline }}</h1>
        <p class="lede">{{ copy.intro }}</p>

        <div class="actions">
          <button
            class="btn primary"
            type="button"
            :disabled="isPreparingBackend || isOffline"
            @click="createRoom"
          >
            {{ isPreparingBackend ? preparingLabel : copy.create }}
          </button>
          <button
            class="btn ghost"
            type="button"
            :aria-expanded="isJoinExpanded"
            @click="expandJoin"
          >
            {{ copy.join }}
          </button>
          <button v-if="isMobile" class="btn ghost scan" type="button" @click="startQrScanner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" stroke-linecap="round" />
              <path d="M4 12h16" stroke-linecap="round" opacity=".55" />
            </svg>
            {{ copy.scanQr }}
          </button>
        </div>

        <form v-if="isJoinExpanded" class="join" @submit.prevent="submitJoinCode">
          <label for="room-code">{{ copy.codeLabel }}</label>
          <div class="join-row">
            <input
              id="room-code"
              ref="joinInput"
              v-model="joinCode"
              class="tabular"
              inputmode="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="ABCD1234"
              maxlength="9"
            />
            <button
              class="btn primary"
              type="submit"
              :disabled="normalizedJoinCode.length !== 8 || isPreparingBackend"
            >
              {{ copy.joinRoom }}
            </button>
          </div>
        </form>

        <div v-if="isPreparingBackend" class="waking" aria-live="polite">
          <span class="sweep" aria-hidden="true"></span>
          <div>
            <strong>{{ serverStatus === 'waking_up' ? copy.startingServer : copy.checkingServer }}</strong>
            <small v-if="serverStatus === 'waking_up'">{{ copy.startingServerBody }}</small>
            <small v-else>{{ copy.elapsedTime }} {{ serverElapsedSeconds }}s</small>
          </div>
        </div>

        <p class="fineprint">{{ copy.footer }}</p>
      </div>

      <div class="visual">
        <ConnectionField
          :local-label="copy.you"
          :remote-label="copy.otherDevice"
          :phase="connectionPhase"
        />
      </div>
    </main>

    <main
      v-else-if="view === 'room' && entryMode === 'join'"
      class="stage room joining"
    >
      <div class="room-copy" aria-live="polite">
        <h2>{{ copy.joiningRoom }}</h2>
        <p class="lede">{{ copy.joiningBody }}</p>
        <div class="waiting-row">
          <span class="pulse" aria-hidden="true"></span>
          <span class="tabular">{{ displayRoomCode }}</span>
        </div>
        <button class="btn danger" type="button" @click="reset()">{{ copy.cancel }}</button>
      </div>
    </main>

    <main v-else-if="view === 'room'" class="stage room">
      <div class="room-copy" aria-live="polite">
        <h2>{{ appState === 'creating-room' ? preparingLabel : copy.roomReady }}</h2>
        <p class="lede">{{ copy.waitingBody }}</p>

        <div class="code-plate">
          <span class="code-label">{{ copy.codeLabel }}</span>
          <strong class="code tabular">{{ displayRoomCode }}</strong>
          <div class="code-actions">
            <button class="btn ghost copy" :class="{ done: copyFeedback }" type="button" @click="copyRoomCode">
              <span class="copy-icon" aria-hidden="true">
                <svg v-if="!copyFeedback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V6a2 2 0 0 1 2-2h8" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path class="tick" d="M5 12.5l4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              {{ copyFeedback || copy.copyCode }}
            </button>
          </div>
        </div>

        <div class="waiting-row">
          <span class="pulse coral" aria-hidden="true"></span>
          <span>{{ copy.waiting }}</span>
        </div>

        <button class="btn danger" type="button" @click="reset()">{{ copy.cancel }}</button>
      </div>

      <!-- The QR is the fastest path on a phone, so it stays visible on desktop too. -->
      <RoomQr
        v-if="joinUrl"
        :value="joinUrl"
        :label="copy.scanToJoin"
        :size="330"
      />
    </main>

    <!-- ------------------------------------------------------ connected -->
    <main v-else class="stage connected">
      <div class="transfer-column">
      <div class="connected-head">
        <h2>{{ peerLeftAt ? copy.peerLeftTitle : transferComplete ? copy.complete : copy.connectedTitle }}</h2>
        <p class="lede">{{ peerLeftAt ? copy.peerLeftBody : transferComplete ? copy.arrived : copy.connectedBody }}</p>
      </div>

      <div class="visual">
        <ConnectionField
          :local-label="copy.thisDevice"
          :remote-label="copy.otherDevice"
          :phase="connectionPhase"
          :flow="liveFlow"
          :flow-direction="isReceiving ? 'receive' : 'send'"
        />
      </div>

      <!-- #10 The peer really left: say so, and show how long the room lasts.
           The code and QR live here because this is the moment they are useful:
           the other device needs a way back into this same room. -->
      <div v-if="peerLeftAt" class="left-card" role="alert">
        <div class="left-main">
          <span class="left-dot" aria-hidden="true"></span>
          <div>
            <strong>{{ copy.peerLeftTitle }}</strong>
            <span>{{ copy.rejoinBody }}</span>
            <p class="countdown tabular">
              {{ copy.roomExpiresIn }} <strong>{{ expiryClock }}</strong>
            </p>
          </div>
          <button class="btn danger small" type="button" @click="reset()">{{ copy.exitRoom }}</button>
        </div>

      </div>

      <!-- Still trying: this is a wait, not a failure, so it never alarms. -->
      <div v-else-if="isReconnecting" class="banner reconnecting" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <div>
          <strong>{{ reconnectingMessage }}</strong>
          <span>{{ copy.reconnectingBody }}</span>
        </div>
      </div>

      <div
        v-else-if="deviceConnectionStatus === 'disconnected'"
        class="banner"
        role="alert"
      >
        <strong>{{ copy.connectionLostTitle }}</strong>
        <span>{{ copy.connectionLostBody }}</span>
      </div>

      <TransferDock
        :copy="copy"
        :direction="direction"
        :remote-direction="remoteDirection"
        :selected-file="selectedFile"
        :queue="queue"
        :queued-bytes="queuedBytes"
        :is-transferring="isTransferring"
        :is-receiving="isReceiving"
        :transfer-complete="transferComplete"
        :transfer-percent="transferPercent"
        :receive-percent="receivePercent"
        :active-transfer-name="activeTransferName"
        :incoming-name="incomingName"
        :can-transfer="canTransfer"
        :connection="deviceConnectionStatus"
        :peer-mode-message="peerModeMessage"
        :both-receiving="bothReceiving"
        :is-drag-over="isDragOver"
        :file-label="fileLabel"
        @set-direction="setDirection"
        @select-file="onFileSelected"
        @drag-over="onDragOver"
        @drag-leave="onDragLeave"
        @drop="onDrop"
        @send="startTransfer"
        @clear="clearFile"
        @remove-queued="removeQueued"
      />

      <ClipboardNote
        :copy="copy"
        :local-text="noteText"
        :remote-text="remoteNoteText"
        :connection="deviceConnectionStatus"
        @update="updateNote"
        @copy-remote="copyRemoteNote"
      />

      <button class="btn danger leave" type="button" @click="reset()">{{ copy.exitRoom }}</button>
      </div>

      <!-- #3 Everything that crossed this room, newest first. -->
      <aside class="ledger" :aria-label="copy.sharedTitle">
        <h3>{{ copy.sharedTitle }}</h3>
        <p v-if="!shared.length" class="ledger-empty">{{ copy.sharedEmpty }}</p>
        <ul v-else>
          <li v-for="item in shared" :key="item.at + item.name">
            <span class="dir" :class="item.direction" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path
                  :d="item.direction === 'sent' ? 'M12 19V6m0 0l-5 5m5-5l5 5' : 'M12 5v13m0 0l5-5m-5 5l-5-5'"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <a v-if="item.url" class="l-name l-name-open" :href="item.url" target="_blank" rel="noopener noreferrer">
              {{ item.name }}
            </a>
            <span v-else class="l-name">{{ item.name }}</span>
            <span class="l-meta tabular">
              {{ item.direction === 'sent' ? copy.sent : copy.receivedLabel }} ·
              {{ (item.size / 1024 / 1024).toFixed(1) }} MB
            </span>
          </li>
        </ul>

        <div v-if="joinUrl && roomCode" class="room-share">
          <RoomQr :value="joinUrl" :label="copy.scanToJoin" :size="180" />
          <div class="room-share-code">
            <span class="code-label">{{ copy.codeLabel }}</span>
            <strong class="code tabular">{{ displayRoomCode }}</strong>
            <button class="btn ghost copy small" :class="{ done: copyFeedback }" type="button" @click="copyRoomCode">
              {{ copyFeedback || copy.copyCode }}
            </button>
          </div>
        </div>
      </aside>
    </main>

    <footer class="credit">
      <div class="transfer-badge" aria-live="polite"><span class="badge-dot"></span>{{ copy.transferCount(completedTransfers) }}</div>
      <a class="gh" href="https://github.com/Devgusta5/PyDrop" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
        </svg>
        <span>Devgusta5</span>
      </a>
      <!-- #7 Shown on any phone that isn't already running the installed app:
           the native prompt when the browser offered one, steps otherwise. -->
      <button v-if="canOfferInstall || installPrompt" class="install" type="button" @click="installApp">
        {{ copy.installApp }}
      </button>
    </footer>

    <div v-if="showInstallHint" class="scanner" role="dialog" :aria-label="copy.installApp">
      <p>{{ installHintBody }}</p>
      <button class="btn ghost" type="button" @click="showInstallHint = false">{{ copy.close }}</button>
    </div>

    <HelpGuide v-if="showHelp" :copy="copy" @close="showHelp = false" />

    <!-- ------------------------------------------------------- overlays -->
    <!-- The scrim is what makes this modal: it dims the page, swallows taps
         meant for the scanner, and (with .scan-lock on body) stops scrolling. -->
    <div v-if="isScanningQr" class="scrim" @click="stopQrScanner"></div>
    <div
      v-if="isScanningQr"
      class="scanner"
      role="dialog"
      aria-modal="true"
      :aria-label="copy.scanQr"
    >
      <video ref="qrVideo" playsinline></video>
      <p>{{ copy.scanQrDialog }}</p>
      <button class="btn ghost" type="button" @click="stopQrScanner">{{ copy.cancelScan }}</button>
    </div>

    <div v-if="isOffline" class="offline-bar" role="status">
      {{ copy.offline }} {{ copy.offlineBody }}
    </div>

    <div v-if="notice" class="notice" role="alert">
      <div class="notice-text">
        <strong>{{ notice.title }}</strong>
        <span>{{ notice.body }}</span>
      </div>
      <button
        v-if="notice.action"
        class="btn ghost small"
        type="button"
        @click="handleNoticeAction(notice.action)"
      >
        {{ notice.action === 'newRoom' ? copy.create : copy.retry }}
      </button>
      <button class="dismiss" type="button" :aria-label="copy.dismiss" @click="dismissNotice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ shell */
.shell {
  position: relative;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  /* Safe areas: the dock and credit sit near the bottom edge on phones. */
  padding: max(var(--space-5), env(safe-area-inset-top)) clamp(var(--space-4), 4vw, var(--space-8))
    max(var(--space-5), env(safe-area-inset-bottom));
}

.topbar,
.stage,
.credit {
  position: relative;
  z-index: 2;
}

/* ----------------------------------------------------------------- topbar */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--shell-max);
  margin: 0 auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: none;
  border: 0;
  padding: 0;
  color: var(--soft-white);
}

.wordmark {
  font-family: var(--font-brand);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 0 var(--space-3);
  background: color-mix(in srgb, var(--graphite) 80%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  color: var(--muted-gray);
  font-size: 12px;
  font-weight: 500;
  transition: color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .chip:hover {
    color: var(--soft-white);
    border-color: var(--muted-gray);
  }
}

.chip:active {
  transform: scale(0.96);
  transition: transform 100ms var(--ease-out);
}


/* ------------------------------------------------------------------ stage */
.stage {
  flex: 1;
  width: 100%;
  max-width: var(--shell-max);
  margin: 0 auto;
  display: grid;
  align-content: center;
  padding: var(--space-7) 0 var(--space-5);
}

/* Two fields, per the spec: language left, connection right. */
.start {
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.92fr);
  align-items: center;
  gap: clamp(var(--space-6), 6vw, var(--space-8));
}

h1 {
  font-family: var(--font-brand);
  font-size: clamp(2.6rem, 6.4vw, 5.4rem);
  font-weight: 700;
  line-height: 0.96;
  letter-spacing: -0.035em;
  white-space: pre-line;
  text-wrap: balance;
}

h2 {
  font-family: var(--font-brand);
  font-size: clamp(1.9rem, 3.6vw, 3rem);
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.lede {
  color: var(--muted-gray);
  font-size: clamp(15px, 1.4vw, 17px);
  max-width: var(--measure);
  margin-top: var(--space-4);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-6);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 var(--space-5);
  border: 0;
  border-radius: var(--radius);
  font-size: 15px;
  font-weight: 600;
  transition: transform var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.btn.primary {
  background: var(--lime-flow);
  color: var(--deep-space);
}

.btn.ghost {
  background: color-mix(in srgb, var(--graphite) 85%, transparent);
  border: 1px solid var(--quiet-border);
  color: var(--soft-white);
}

@media (hover: hover) and (pointer: fine) {
  .btn.ghost:hover {
    border-color: var(--muted-gray);
  }
}

/* Hover lifts only where a pointer can actually hover; touch fires it on tap. */
@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
  }
}

/* Press feedback: the interface confirms it heard you, instantly. */
.btn:active:not(:disabled) {
  transform: scale(0.97);
  transition-duration: 100ms;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
}

.btn.small {
  min-height: 36px;
  padding: 0 var(--space-3);
  font-size: 13px;
}

.link {
  background: none;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--muted-gray);
  font-size: 14px;
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: var(--quiet-border);
}

.link:hover {
  color: var(--soft-white);
  text-decoration-color: currentColor;
}

/* ------------------------------------------------------------------- join */
.join {
  margin-top: var(--space-5);
  padding: var(--space-4);
  background: color-mix(in srgb, var(--graphite) 70%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  max-width: 480px;
}

.join label {
  display: block;
  color: var(--muted-gray);
  font-size: 12px;
  margin-bottom: var(--space-2);
}

.join-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-2);
}

.join input {
  min-width: 0;
  min-height: 48px;
  padding: 0 var(--space-3);
  background: var(--deep-space);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  color: var(--soft-white);
  font-size: 17px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.join input::placeholder {
  color: var(--muted-gray);
  opacity: 0.6;
  letter-spacing: 0.12em;
}

.join input:focus-visible {
  border-color: var(--lime-flow);
}

/* ---------------------------------------------------------------- waking */
.waking {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-top: var(--space-5);
  color: var(--muted-gray);
  font-size: 13px;
}

.waking strong {
  display: block;
  color: var(--soft-white);
  font-weight: 500;
}

.waking small {
  display: block;
  margin-top: 2px;
}

/* A signal sweeping outward — the shape of reaching for something, not a
   spinner going nowhere. */
.sweep {
  position: relative;
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--lime-flow);
}

.sweep::before,
.sweep::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--lime-flow);
  animation: sweep 2s cubic-bezier(0.23, 1, 0.32, 1) infinite;
}

.sweep::after {
  animation-delay: 1s;
}

@keyframes sweep {
  from { transform: scale(1); opacity: 0.7; }
  to { transform: scale(3.4); opacity: 0; }
}

.pulse {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--lime-flow);
  box-shadow: 0 0 0 0 var(--lime-edge);
  animation: pulse 1.8s var(--ease-out) infinite;
}

.pulse.coral {
  background: var(--coral-signal);
  box-shadow: 0 0 0 0 var(--coral-edge);
}

@keyframes pulse {
  70% { box-shadow: 0 0 0 9px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.fineprint {
  margin-top: var(--space-6);
  color: var(--muted-gray);
  font-size: 13px;
}

/* ------------------------------------------------------------------- room */
/* The code and the QR are two routes to the same thing, so they sit together
   rather than at opposite ends of a wide screen. */
.room {
  grid-template-columns: minmax(0, auto) auto;
  justify-content: start;
  align-items: center;
  gap: clamp(var(--space-6), 5vw, var(--space-8));
}

/* The joiner has no QR to pair it with — center the single column instead
   of leaving it pinned to the left edge of a two-column grid. */
.room.joining {
  grid-template-columns: minmax(0, 1fr);
  justify-content: center;
  justify-items: center;
  text-align: center;
}

.room.joining .waiting-row {
  justify-content: center;
}

.code-plate {
  margin-top: var(--space-5);
  padding: var(--space-4);
  background: color-mix(in srgb, var(--graphite) 80%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  max-width: 460px;
}

.code-label {
  display: block;
  color: var(--muted-gray);
  font-size: 12px;
}

.code {
  display: block;
  margin: var(--space-2) 0 var(--space-3);
  color: var(--lime-flow);
  font-size: clamp(2rem, 5.6vw, 3.4rem);
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1;
}

.code-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.copy {
  gap: var(--space-2);
}

/* Success is the button turning green, not a message appearing next to it. */
.copy.done {
  border-color: var(--transfer-green);
  color: var(--transfer-green);
}

.copy-icon {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
}

.copy-icon svg {
  width: 16px;
  height: 16px;
}

/* The tick draws itself on, so the confirmation has a moment of its own. */
.tick {
  stroke-dasharray: 22;
  stroke-dashoffset: 22;
  animation: tick 260ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
}

@keyframes tick {
  to { stroke-dashoffset: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .tick {
    animation: none;
    stroke-dashoffset: 0;
  }
}

.waiting-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-5);
  color: var(--muted-gray);
  font-size: 14px;
}

.waiting-row .pulse {
  margin-top: 0;
}

.qr {
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  margin: 0;
}

.qr canvas {
  display: block;
  width: 168px;
  height: 168px;
  padding: var(--space-3);
  background: var(--soft-white);
  border-radius: var(--radius);
}

.qr figcaption {
  color: var(--muted-gray);
  font-size: 12px;
  text-align: center;
  max-width: 180px;
}

/* -------------------------------------------------------------- connected */
/* Transfer on the left, the room's history on the right. */
.connected {
  grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
  align-items: start;
  gap: clamp(var(--space-5), 4vw, var(--space-7));
  max-width: 1100px;
}

.transfer-column {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}

/* #3 the ledger */
.ledger {
  background: color-mix(in srgb, var(--graphite) 70%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  padding: var(--space-4);
  min-width: 0;
}

.ledger h3 {
  font-family: var(--font-brand);
  font-size: 14px;
  font-weight: 600;
  margin-bottom: var(--space-3);
}

.ledger-empty {
  color: var(--muted-gray);
  font-size: 13px;
}

.ledger ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
  max-height: 380px;
  overflow-y: auto;
}

.ledger li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: var(--space-3);
  align-items: center;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--quiet-border);
}

.ledger li:last-child { border-bottom: 0; }

.dir {
  grid-row: span 2;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid currentColor;
}

/* Lime leaves this device, coral arrives from the other one. */
.dir.sent { color: var(--lime-flow); }
.dir.received { color: var(--coral-signal); }
.dir svg { width: 14px; height: 14px; }

.l-name {
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Only a received file still has its blob in memory to reopen; sent items
   stay plain text rather than promising an action that would do nothing. */
.l-name-open {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--quiet-border);
  text-underline-offset: 2px;
}

.l-name-open:hover {
  color: var(--coral-signal);
  text-decoration-color: currentColor;
}

.l-meta {
  color: var(--muted-gray);
  font-size: 11px;
}

/* #10 peer-left card */
/* Not an error: the other device left and the room is still here, waiting.
   Coral is the right voice — it is the remote device's own colour. */
.left-card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--coral-wash);
  border: 1px solid var(--coral-edge);
  border-radius: var(--radius);
}

.left-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--space-3);
}

.left-card strong { display: block; font-size: 14px; }
.left-main > div > span { color: var(--muted-gray); font-size: 13px; }

.left-dot {
  width: 9px;
  height: 9px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--coral-signal);
}

/* The room access details stay available below the shared-file ledger. */
.room-share {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--quiet-border);
}

.room-share-code {
  display: grid;
  gap: var(--space-2);
  justify-items: center;
}

.room-share-code .code {
  font-size: 22px;
  letter-spacing: 0.08em;
}

.countdown {
  margin-top: var(--space-2);
  color: var(--muted-gray);
  font-size: 12px;
}

.countdown strong { display: inline; color: var(--coral-signal); }

/* #9 destructive actions read as destructive. */
.btn.danger {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--error-red) 60%, transparent);
  color: var(--error-red);
}

@media (hover: hover) and (pointer: fine) {
  .btn.danger:hover {
    background: var(--error-wash);
    border-color: var(--error-red);
  }
}

/* #11 credit + install */
.gh {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  text-decoration: none;
}

.gh svg { width: 15px; height: 15px; }
.gh:hover { color: var(--soft-white); }

.install {
  background: transparent;
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  color: var(--muted-gray);
  font-size: 12px;
  padding: var(--space-2) var(--space-3);
  min-height: 34px;
}

.install:hover { color: var(--lime-flow); border-color: var(--lime-edge); }

.chip.help {
  justify-content: center;
  width: 38px;
  padding: 0;
  font-weight: 700;
}

/* #5 language flag */
.chip.lang { gap: var(--space-2); }
.flag {
  display: grid;
  place-items: center;
  width: 18px;
  height: 12px;
  overflow: hidden;
  border-radius: 2px;
}
.flag svg { width: 18px; height: 12px; display: block; }

/* #6 scan action */
.btn.scan { gap: var(--space-2); }
.btn.scan svg { width: 17px; height: 17px; }

.connected-head {
  text-align: left;
}

.traversing {
  color: var(--muted-gray);
  font-size: 14px;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
}

.banner {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  background: var(--error-wash);
  border: 1px solid color-mix(in srgb, var(--error-red) 50%, transparent);
  border-radius: var(--radius);
  font-size: 14px;
}

.banner span {
  color: var(--muted-gray);
}

/* Reconnecting is a wait, not a fault: quiet surface, no alarm red. */
.banner.reconnecting {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--quiet-border);
}

.banner.reconnecting div {
  display: grid;
  gap: var(--space-1);
}

.spinner {
  flex: none;
  width: 16px;
  height: 16px;
  border: 2px solid var(--quiet-border);
  border-top-color: var(--lime-flow);
  border-radius: 50%;
  animation: spin 720ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 2.4s; }
}

.leave {
  justify-self: start;
}

/* ----------------------------------------------------------------- credit */
.credit {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-2);
  width: 100%;
  max-width: var(--shell-max);
  margin: 0 auto;
  padding-top: var(--space-5);
  color: var(--muted-gray);
  font-size: 12px;
  opacity: 0.72;
}

.credit:hover {
  opacity: 1;
}

.transfer-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-right: auto;
  padding: 8px 10px;
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--coral-signal);
}

.credit a {
  color: var(--muted-gray);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--quiet-border);
}

.credit a:hover {
  color: var(--lime-flow);
  text-decoration-color: currentColor;
}

/* --------------------------------------------------------------- overlays */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 39;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.scanner {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  width: min(420px, calc(100% - var(--space-6)));
  max-height: calc(100dvh - var(--space-6));
  overflow: auto;
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--graphite);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  box-shadow: 0 24px 70px -12px rgba(0, 0, 0, 0.7);
}

.scanner video {
  width: 100%;
  max-height: 50vh;
  object-fit: cover;
  border-radius: var(--radius);
  background: #000;
}

.scanner p {
  color: var(--muted-gray);
  font-size: 14px;
}

.offline-bar {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 45;
  padding: var(--space-2) var(--space-4);
  background: var(--slate-charcoal);
  border-bottom: 1px solid var(--quiet-border);
  color: var(--muted-gray);
  font-size: 13px;
  text-align: center;
}

.notice {
  position: fixed;
  left: var(--space-5);
  bottom: max(var(--space-5), env(safe-area-inset-bottom));
  z-index: 50;
  width: min(420px, calc(100% - var(--space-7)));
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--graphite);
  border: 1px solid color-mix(in srgb, var(--error-red) 55%, transparent);
  border-radius: var(--radius);
  box-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.66);
  /* Enters from where it lives — the bottom edge — so the motion explains
     where it came from and where a dismiss would send it. */
  transition: opacity 260ms var(--ease-out), transform 260ms var(--ease-out);

  @starting-style {
    opacity: 0;
    transform: translateY(12px);
  }
}

.notice-text {
  flex: 1;
  display: grid;
  gap: 2px;
}

.notice-text strong {
  font-size: 14px;
  font-weight: 600;
}

.notice-text span {
  color: var(--muted-gray);
  font-size: 13px;
}

.dismiss {
  position: relative;
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: none;
  border: 0;
  color: var(--muted-gray);
}

/* Visual size stays compact next to the message text; the tap target still
   meets the 44px minimum by extending into the toast's own padding. */
.dismiss::before {
  content: '';
  position: absolute;
  inset: -7px;
}

.dismiss:hover {
  color: var(--soft-white);
}

.dismiss svg {
  width: 15px;
  height: 15px;
}

/* ------------------------------------------------------------ responsive */
@media (max-width: 900px) {
  .start,
  .room,
  .connected {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-6);
  }

  /* The ledger follows the transfer surface rather than sitting beside it. */
  .ledger ul { max-height: 220px; }
  .left-card { grid-template-columns: auto minmax(0, 1fr); }
  .left-card .btn { grid-column: 2; justify-self: start; }

  /* The visual reads as a band above the copy rather than a shrunken square. */
  .start .visual {
    order: -1;
  }

  .qr {
    justify-items: start;
  }

  .stage {
    padding: var(--space-6) 0 var(--space-4);
  }
}

@media (max-width: 620px) {
  .topbar {
    gap: var(--space-2);
  }

  .wordmark {
    font-size: 19px;
  }

  /* Phones keep the header on one row. */
  .controls {
    flex-wrap: nowrap;
  }

  .chip {
    padding: 0 var(--space-2);
    font-size: 11px;
  }

  .actions .btn {
    flex: 1 1 100%;
  }

  .join-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .notice {
    left: var(--space-3);
    right: var(--space-3);
    width: auto;
  }
}
</style>
