<script setup lang="ts">
import QrScanner from 'qr-scanner'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from './api'
import { dictionaries, type Copy, type Language } from './copy'
import type { PyDropScene, Quality, SceneState } from './scene'
import PortalMark from './components/PortalMark.vue'
import ConnectionField from './components/ConnectionField.vue'
import TransferDock from './components/TransferDock.vue'
import RoomQr from './components/RoomQr.vue'

type View = 'start' | 'room' | 'connected'
type AppState = SceneState
type EntryMode = 'create' | 'join' | null
/** Errors get a title + body + recovery action rather than a raw string. */
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
const activeTransferName = ref('')
const isTransferring = ref(false)
const transferComplete = ref(false)
const transferPercent = ref(0)
const receivePercent = ref(0)
const isReceiving = ref(false)
const incomingName = ref('')
const immersiveMode = ref(false)
const reduceMotion = ref(false)
const renderQuality = ref<Quality>('balanced')
const roomCode = ref('')
const joinCode = ref('')
const entryMode = ref<EntryMode>(null)
const isJoinExpanded = ref(false)
const isDragOver = ref(false)
const copyFeedback = ref('')
const notice = ref<AppError | null>(null)
const isOffline = ref(false)
const coreHovered = ref(false)
const sceneMount = ref<HTMLElement | null>(null)
const qrVideo = ref<HTMLVideoElement | null>(null)
const joinInput = ref<HTMLInputElement | null>(null)
const isScanningQr = ref(false)
const hasWebGL = ref(true)
const serverStatus = ref<'idle' | 'checking' | 'waking_up' | 'ready' | 'connecting_ws' | 'connected' | 'failed'>('idle')
const serverElapsedSeconds = ref(0)
const roomFull = ref(false)
const deviceConnectionStatus = ref<'connecting' | 'connected' | 'disconnected'>('connecting')

let qrScanner: QrScanner | null = null
let roomConnection: ReturnType<typeof api.connectRoomSocket> | null = null
let directTransfer: api.DirectTransfer | null = null
let scene: PyDropScene | null = null
let reconnectTimer = 0
let reconnectAttempts = 0
let traversalTimer = 0
let noticeTimer = 0
let pendingDownloadUrl = 0
let sceneTransferProgress = -1
// Bumped on every deliberate (re)connect so a stale socket's disconnect cannot
// trigger a reconnect loop for a connection we already tore down.
let connectionGeneration = 0

const copy = computed<Copy>(() => dictionaries[language.value])

const isMobile = computed(() => /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent))
const isPreparingBackend = computed(() =>
  ['checking', 'waking_up', 'connecting_ws'].includes(serverStatus.value),
)
const preparingLabel = computed(() =>
  entryMode.value === 'join' ? copy.value.joiningRoom : copy.value.creatingRoom,
)
const fileLabel = computed(() => selectedFile.value?.name ?? copy.value.choose)
const displayRoomCode = computed(() => formatRoomCode(roomCode.value))
// The QR encodes the deep link the other device opens; RoomQr draws it.
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
    !!selectedFile.value &&
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
/** What the connection field should be showing right now. */
const connectionPhase = computed<'idle' | 'waiting' | 'linked'>(() => {
  if (deviceConnectionStatus.value === 'connected') return 'linked'
  if (view.value !== 'start' || isPreparingBackend.value) return 'waiting'
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
  syncScene()
}

function showError(title: string, body: string, action?: AppError['action']) {
  notice.value = { title, body, action }
  window.clearTimeout(noticeTimer)
  // Errors offering a recovery action stay until dismissed; plain ones time out.
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

function toggleImmersiveMode() {
  immersiveMode.value = !immersiveMode.value
  // Entering immersive while already connected replays the traversal.
  if (immersiveMode.value && appState.value === 'connected') beginTraversal()
  if (!immersiveMode.value && appState.value === 'entering-room') setAppState('connected')
}

function toggleReduceMotion() {
  reduceMotion.value = !reduceMotion.value
  syncScene()
}

function setDirection(mode: api.TransferMode) {
  if (direction.value === mode) return
  direction.value = mode
  if (mode === 'receive') selectedFile.value = null
  directTransfer?.setMode(mode)
}

// ---------------------------------------------------------------- 3D lifecycle

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

function syncScene() {
  scene?.update({
    state: appState.value,
    quality: renderQuality.value,
    reduceMotion: reduceMotion.value,
    transferProgress: sceneTransferProgress,
    transferDirection: direction.value,
  })
}

async function mountScene() {
  if (!immersiveMode.value || !hasWebGL.value || scene) return
  await nextTick()
  if (!sceneMount.value) return
  // Three.js is ~600kB and only immersive mode needs it, so the standard flow
  // never pays for it. Loaded on demand, when the user opts into the experience.
  const { PyDropScene } = await import('./scene')
  // The user may have left immersive mode while the chunk was in flight.
  if (!immersiveMode.value || !sceneMount.value || scene) return
  scene = new PyDropScene(
    sceneMount.value,
    () => { if (appState.value === 'initial') createRoom() },
    (hovered) => { coreHovered.value = hovered },
  )
  syncScene()
}

function unmountScene() {
  scene?.dispose()
  scene = null
  coreHovered.value = false
}

/** The authored moment: fly through the portal, then land inside the room. */
function beginTraversal() {
  window.clearTimeout(traversalTimer)
  if (reduceMotion.value || !hasWebGL.value) {
    setAppState('inside-room')
    return
  }
  setAppState('entering-room')
  traversalTimer = window.setTimeout(() => setAppState('inside-room'), 2400)
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

async function createRoom() {
  if (isOffline.value) {
    showError(copy.value.offline, copy.value.offlineBody)
    return
  }
  entryMode.value = 'create'
  view.value = 'room'
  setAppState('creating-room')
  copyFeedback.value = ''
  dismissNotice()
  try {
    await prepareBackend()
    const result = await api.createRoom()
    roomCode.value = result.code
    setAppState('waiting')
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry')
  }
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
  setAppState('creating-room')
  dismissNotice()
  try {
    await prepareBackend()
    setAppState('waiting')
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry')
  }
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

// Reconnects to the room we already have rather than minting a new code and
// stranding the other device.
async function retryConnection() {
  dismissNotice()
  if (!roomCode.value) {
    await createRoom()
    return
  }
  setAppState('creating-room')
  try {
    await prepareBackend()
    setAppState('waiting')
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
    setAppState('error')
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry')
  }
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
      directTransfer?.handleSignal(message).catch(() =>
        showError(copy.value.transferFailed, copy.value.transferFailedBody),
      )
    },
    onDisconnect: () => {
      if (myGeneration !== connectionGeneration) return
      deviceConnectionStatus.value = 'disconnected'
      if (roomFull.value) return
      if (reconnectAttempts >= 3) {
        serverStatus.value = 'failed'
        setAppState('error')
        showError(copy.value.connectionLostTitle, copy.value.connectionLostBody, 'retry')
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
        showError(copy.value.roomFull, copy.value.roomFullBody, 'newRoom')
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
  if (immersiveMode.value) beginTraversal()
  else setAppState('connected')
}

function setupDirectTransfer(initiator: boolean) {
  if (directTransfer || !roomConnection) return
  directTransfer = new api.DirectTransfer(
    (message) => roomConnection?.send(message),
    () => {
      deviceConnectionStatus.value = 'connected'
      if (appState.value === 'connected' && immersiveMode.value) beginTraversal()
    },
    (file, blob) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      // Give the browser a moment to take the blob before revoking it; revoking
      // synchronously after click() is flaky on some mobile browsers.
      window.clearTimeout(pendingDownloadUrl)
      pendingDownloadUrl = window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      isReceiving.value = false
      receivePercent.value = 100
      incomingName.value = file.name
      // Don't declare the whole screen complete while our own send is still running.
      if (!isTransferring.value) {
        transferComplete.value = true
        setAppState('completed')
      }
    },
    (progress, mode) => {
      if (mode === 'receive') {
        isReceiving.value = true
        receivePercent.value = Math.round(progress * 100)
        sceneTransferProgress = progress
        syncScene()
        return
      }
      transferPercent.value = Math.round(progress * 100)
      sceneTransferProgress = progress
      syncScene()
    },
    () => showError(copy.value.transferFailed, copy.value.transferFailedBody),
    () => {
      if (view.value === 'connected') {
        isTransferring.value = false
        deviceConnectionStatus.value = 'disconnected'
      }
    },
    (mode) => { remoteDirection.value = mode },
  )
  directTransfer.setMode(direction.value)
  directTransfer.start(initiator).catch(() =>
    showError(copy.value.unableToConnectTitle, copy.value.unableToConnectBody, 'retry'),
  )
}

// ------------------------------------------------------------------ room code

async function copyRoomCode() {
  if (!roomCode.value) return
  try {
    await navigator.clipboard.writeText(roomCode.value)
    copyFeedback.value = copy.value.copied
  } catch {
    // Clipboard blocked (insecure context or denied) — show the code to copy by hand.
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

// --------------------------------------------------------------------- files

function acceptFile(file: File | null) {
  if (file) {
    const error = api.validateTransferFile(file)
    if (error) {
      selectedFile.value = null
      // The only validation users realistically hit is the size ceiling.
      if (file.size > api.MAX_FILE_SIZE_BYTES) {
        showError(copy.value.fileTooLarge, copy.value.fileTooLargeBody)
      } else {
        showError(copy.value.transferFailed, error)
      }
      return
    }
  }
  selectedFile.value = file
  transferComplete.value = false
  transferPercent.value = 0
  setAppState(file ? 'file-ready' : immersiveMode.value ? 'inside-room' : 'connected')
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  acceptFile(input.files?.[0] ?? null)
  if (!selectedFile.value) input.value = ''
}

function clearFile() {
  selectedFile.value = null
  transferPercent.value = 0
  transferComplete.value = false
  setAppState(immersiveMode.value ? 'inside-room' : 'connected')
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
  } catch {
    setAppState('error')
    showError(copy.value.transferFailed, copy.value.transferFailedBody)
  } finally {
    isTransferring.value = false
  }
}

function reset(force = false) {
  if (!force && isTransferring.value && !window.confirm(copy.value.confirmLeave)) return
  stopQrScanner()
  dismissNotice()
  connectionGeneration += 1
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(traversalTimer)
  window.clearTimeout(pendingDownloadUrl)
  roomConnection?.disconnect()
  directTransfer?.close()
  roomConnection = null
  directTransfer = null
  view.value = 'start'
  setAppState('initial')
  direction.value = 'send'
  remoteDirection.value = 'send'
  selectedFile.value = null
  activeTransferName.value = ''
  incomingName.value = ''
  transferComplete.value = false
  isTransferring.value = false
  isReceiving.value = false
  transferPercent.value = 0
  receivePercent.value = 0
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
}

function handleNoticeAction(action: AppError['action']) {
  if (action === 'retry') retryConnection()
  if (action === 'newRoom') {
    reset(true)
    createRoom()
  }
}

// ------------------------------------------------------------------ lifecycle

watch([immersiveMode, hasWebGL], () => {
  unmountScene()
  mountScene()
})

watch(renderQuality, syncScene)


const handleOnline = () => { isOffline.value = false }
const handleOffline = () => { isOffline.value = true }

onMounted(() => {
  hasWebGL.value = supportsWebGL()
  reduceMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  isOffline.value = !navigator.onLine
  document.documentElement.lang = language.value
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  // Phones are the device that scans, so start them at reduced quality.
  if (isMobile.value) renderQuality.value = 'reduced'

  const roomFromUrl = new URLSearchParams(window.location.search).get('room')
  if (roomFromUrl) joinRoomByCode(roomFromUrl)
  else prepareBackend().catch(() => { serverStatus.value = 'failed' })
})

onBeforeUnmount(() => {
  unmountScene()
  stopQrScanner()
  roomConnection?.disconnect()
  directTransfer?.close()
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(traversalTimer)
  window.clearTimeout(pendingDownloadUrl)
  window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="shell" :class="{ immersive: immersiveMode }">
    <!-- The 3D world sits behind everything and fills the viewport in immersive mode. -->
    <div
      v-if="immersiveMode && hasWebGL"
      ref="sceneMount"
      class="world"
      :class="{ interactive: coreHovered }"
      aria-hidden="true"
    ></div>

    <header class="topbar">
      <button class="brand" type="button" @click="reset()">
        <PortalMark :size="30" />
        <span class="wordmark">PyDrop</span>
        <span class="visually-hidden">— {{ copy.tagline }}</span>
      </button>

      <div class="controls">
        <button class="chip" type="button" :aria-label="copy.language" @click="setLanguage">
          {{ language.toUpperCase() }}
        </button>

        <template v-if="immersiveMode">
          <button
            class="chip reduce-motion"
            type="button"
            :aria-pressed="reduceMotion"
            :aria-label="copy.reduceMotion"
            :title="copy.reduceMotion"
            @click="toggleReduceMotion"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="7.5" />
              <path v-if="reduceMotion" d="M8 12h8" stroke-linecap="round" />
              <path v-else d="M12 8.5v7M8.5 12h7" stroke-linecap="round" />
            </svg>
            <span>{{ reduceMotion ? copy.motionReduced : copy.reduceMotion }}</span>
          </button>
          <label class="chip select">
            <span class="visually-hidden">{{ copy.quality }}</span>
            <select v-model="renderQuality">
              <option value="high">{{ copy.qualityHigh }}</option>
              <option value="balanced">{{ copy.qualityBalanced }}</option>
              <option value="reduced">{{ copy.qualityReduced }}</option>
            </select>
          </label>
        </template>

        <button class="chip mode-toggle" type="button" @click="toggleImmersiveMode">
          <!-- Phones get the short form; there is no room for the full phrase. -->
          <span class="full">{{ immersiveMode ? copy.exitImmersive : copy.enterImmersive }}</span>
          <span class="short">{{ immersiveMode ? copy.exitShort : copy.enterShort }}</span>
        </button>
      </div>
    </header>

    <!-- ------------------------------------------------ start (immersive) -->
    <!-- The scene IS the interface here: no hero column, no 2D connection visual.
         Controls sit low and quiet so the environment owns the viewport. -->
    <main v-if="view === 'start' && immersiveMode" class="stage immersive-start">
      <div class="core-console">
        <p class="console-label">{{ copy.portalLabel }}</p>
        <button
          class="core-action"
          type="button"
          :disabled="isPreparingBackend || isOffline"
          @click="createRoom"
        >
          {{ isPreparingBackend ? preparingLabel : copy.create }}
        </button>
        <button class="link" type="button" :aria-expanded="isJoinExpanded" @click="expandJoin">
          {{ copy.join }}
        </button>

        <form v-if="isJoinExpanded" class="join compact" @submit.prevent="submitJoinCode">
          <label for="immersive-room-code">{{ copy.codeLabel }}</label>
          <div class="join-row">
            <input
              id="immersive-room-code"
              ref="joinInput"
              v-model="joinCode"
              class="tabular"
              inputmode="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="A7K29XQ4"
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
      </div>
    </main>

    <!-- ------------------------------------------------- start (standard) -->
    <main v-else-if="view === 'start'" class="stage start">
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
              placeholder="A7K29XQ4"
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
          <button v-if="isMobile" class="link" type="button" @click="startQrScanner">
            {{ copy.scanQr }}
          </button>
        </form>

        <!-- The free backend sleeps; say so rather than looking broken. -->
        <div v-if="isPreparingBackend" class="waking" aria-live="polite">
          <span class="pulse" aria-hidden="true"></span>
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

    <!-- ----------------------------------------------------------- room -->
    <main v-else-if="view === 'room'" class="stage room" :class="{ immersive: immersiveMode }">
      <div class="room-copy" aria-live="polite">
        <h2>{{ appState === 'creating-room' ? preparingLabel : copy.roomReady }}</h2>
        <p class="lede">{{ copy.waitingBody }}</p>

        <div class="code-plate">
          <span class="code-label">{{ copy.codeLabel }}</span>
          <strong class="code tabular">{{ displayRoomCode }}</strong>
          <div class="code-actions">
            <button class="btn ghost" type="button" @click="copyRoomCode">
              {{ copy.copyCode }}
            </button>
            <span class="copy-feedback" aria-live="polite">{{ copyFeedback }}</span>
          </div>
        </div>

        <div class="waiting-row">
          <span class="pulse coral" aria-hidden="true"></span>
          <span>{{ copy.waiting }}</span>
        </div>

        <button class="link" type="button" @click="reset()">{{ copy.cancel }}</button>
      </div>

      <!-- The QR is the fastest path on a phone, so it stays visible in both modes
           on desktop; in immersive it sits smaller so the scene keeps the room. -->
      <RoomQr v-if="joinUrl" :value="joinUrl" :label="copy.scanToJoin" />
    </main>

    <!-- ------------------------------------------------------ connected -->
    <main v-else class="stage connected" :class="{ 'on-world': immersiveMode }">
      <div class="connected-head">
        <h2>{{ transferComplete ? copy.complete : copy.connectedTitle }}</h2>
        <p class="lede">{{ transferComplete ? copy.arrived : copy.connectedBody }}</p>
      </div>

      <!-- In standard mode the 2D field carries the connection; in immersive the 3D does. -->
      <div v-if="!immersiveMode" class="visual">
        <ConnectionField
          :local-label="copy.thisDevice"
          :remote-label="copy.otherDevice"
          :phase="deviceConnectionStatus === 'connected' ? 'linked' : 'waiting'"
          :flow="liveFlow"
          :flow-direction="isReceiving ? 'receive' : 'send'"
        />
      </div>

      <p v-else-if="appState === 'entering-room'" class="traversing" aria-live="polite">
        {{ copy.enteringRoom }}
      </p>

      <div v-if="deviceConnectionStatus === 'disconnected'" class="banner" role="alert">
        <strong>{{ copy.connectionLostTitle }}</strong>
        <span>{{ copy.connectionLostBody }}</span>
      </div>

      <TransferDock
        :copy="copy"
        :direction="direction"
        :remote-direction="remoteDirection"
        :selected-file="selectedFile"
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
      />

      <button class="link leave" type="button" @click="reset()">{{ copy.exitRoom }}</button>
    </main>

    <footer class="credit">
      <span>{{ copy.createdBy }}</span>
      <a href="https://github.com/Devgusta5" target="_blank" rel="noopener noreferrer">
        Gustavo Rodrigues
      </a>
    </footer>

    <!-- WebGL missing: say what is lost and that nothing else is. -->
    <p v-if="immersiveMode && !hasWebGL" class="webgl-note" role="status">
      <strong>{{ copy.webglMissing }}</strong>
      <span>{{ copy.webglMissingAction }}</span>
    </p>

    <!-- ------------------------------------------------------- overlays -->
    <div v-if="isScanningQr" class="scanner" role="dialog" :aria-label="copy.scanQr">
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

.world {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: var(--deep-space);
}

.world.interactive {
  cursor: pointer;
}

.world :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

/* A vignette so overlaid text always has ground, whatever the scene is doing. */
.shell.immersive::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 45%, transparent 38%, rgba(6, 9, 11, 0.86) 100%);
}

.topbar,
.stage,
.credit,
.webgl-note {
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

.chip:hover {
  color: var(--soft-white);
  border-color: var(--muted-gray);
}

.chip.reduce-motion {
  gap: var(--space-2);
}

.chip.reduce-motion svg {
  width: 15px;
  height: 15px;
  flex: none;
}

.chip.select {
  padding: 0;
}

.chip.select select {
  background: transparent;
  border: 0;
  padding: 0 var(--space-3);
  height: 36px;
  color: inherit;
  font-size: 12px;
}

.chip.select select option {
  background: var(--graphite);
  color: var(--soft-white);
}

.mode-toggle {
  color: var(--lime-flow);
  border-color: var(--lime-edge);
}

.mode-toggle .short {
  display: none;
}

.mode-toggle:hover {
  color: var(--deep-space);
  background: var(--lime-flow);
  border-color: var(--lime-flow);
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

.btn.ghost:hover {
  border-color: var(--muted-gray);
}

.btn:hover:not(:disabled) {
  transform: translateY(-1px);
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

.copy-feedback {
  color: var(--transfer-green);
  font-size: 13px;
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
.connected {
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  max-width: 720px;
  justify-items: stretch;
}

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
  border: 1px solid rgba(255, 89, 100, 0.5);
  border-radius: var(--radius);
  font-size: 14px;
}

.banner span {
  color: var(--muted-gray);
}

.leave {
  justify-self: start;
}

/* ------------------------------------------------------- immersive start */
/* No hero column here: the scene is the interface. The console sits low so the
   core stays the centre of attention, and stays a real focusable control. */
.immersive-start {
  align-content: end;
  justify-items: center;
  padding-bottom: clamp(var(--space-6), 8vh, var(--space-8));
  pointer-events: none;
}

.core-console {
  pointer-events: auto;
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  width: min(460px, 100%);
  text-align: center;
}

.console-label {
  color: var(--muted-gray);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

/* Sized as a control, not a billboard: the 3D core is the hero, not this. */
.core-action {
  min-height: 52px;
  padding: 0 var(--space-6);
  background: color-mix(in srgb, var(--lime-flow) 14%, transparent);
  border: 1px solid var(--lime-flow);
  border-radius: var(--radius);
  color: var(--lime-flow);
  font-family: var(--font-brand);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
  backdrop-filter: blur(8px);
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.core-action:hover:not(:disabled) {
  background: var(--lime-flow);
  color: var(--deep-space);
}

.core-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Panels floating over the world need their own ground to stay readable. */
.immersive .code-plate,
.join.compact {
  background: color-mix(in srgb, var(--deep-space) 84%, transparent);
  backdrop-filter: blur(14px);
}

.join.compact {
  margin-top: var(--space-2);
  width: 100%;
  text-align: left;
}

/* In immersive the room readout is a quiet overlay, not a two-column page. */
.room.immersive {
  grid-template-columns: minmax(0, 1fr) auto;
  align-content: end;
  padding-bottom: clamp(var(--space-6), 7vh, var(--space-8));
}

.room.immersive h2 {
  font-size: clamp(1.4rem, 2.4vw, 1.9rem);
}

.room.immersive .lede {
  font-size: 14px;
}

.room.immersive .qr canvas {
  width: 124px;
  height: 124px;
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

/* Over the world the credit stays out of the console's way. */
.shell.immersive .credit {
  justify-content: center;
  padding-top: var(--space-3);
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

.webgl-note {
  display: grid;
  gap: var(--space-1);
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: var(--space-4);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  font-size: 14px;
}

.webgl-note span {
  color: var(--muted-gray);
}

/* --------------------------------------------------------------- overlays */
.scanner {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  width: min(420px, calc(100% - var(--space-6)));
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
  border: 1px solid rgba(255, 89, 100, 0.55);
  border-radius: var(--radius);
  box-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.66);
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
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: none;
  border: 0;
  color: var(--muted-gray);
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
  .room {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-6);
  }

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

  /* Phones keep the header on one row: the two scene controls become icon-width
     and the mode toggle shortens, rather than wrapping into a second bar. */
  .controls {
    flex-wrap: nowrap;
  }

  .chip {
    padding: 0 var(--space-2);
    font-size: 11px;
  }

  .chip.reduce-motion span {
    display: none;
  }

  /* Phones are pinned to reduced quality already, so the picker is noise there.
     It stays available on tablets and desktop. */
  .chip.select {
    display: none;
  }

  .mode-toggle {
    white-space: nowrap;
  }

  .mode-toggle .full {
    display: none;
  }

  .mode-toggle .short {
    display: inline;
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
