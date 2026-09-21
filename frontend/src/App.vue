<script setup lang="ts">
import * as THREE from 'three'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from './api'

type View = 'start' | 'room' | 'connected'

const view = ref<View>('start')
const direction = ref<'send' | 'receive'>('send')
const selectedFile = ref<File | null>(null)
const isTransferring = ref(false)
const transferComplete = ref(false)
const immersiveMode = ref(false)
const roomCode = ref('')
const roomFiles = ref<api.TransferFile[]>([])
const threeMount = ref<HTMLElement | null>(null)
const spaceMount = ref<HTMLElement | null>(null)
const spacePhase = ref<'idle' | 'creating' | 'waiting' | 'connected'>('idle')
const serverStatus = ref<'idle' | 'checking' | 'waking_up' | 'ready' | 'connecting_ws' | 'connected' | 'failed'>('idle')
const serverElapsedSeconds = ref(0)
const roomFull = ref(false)
let roomConnection: ReturnType<typeof api.connectRoomSocket> | null = null
let directTransfer: api.DirectTransfer | null = null
let reconnectTimer = 0
let reconnectAttempts = 0
let intentionalDisconnect = false

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let animationFrame = 0
let resizeObserver: ResizeObserver | null = null
let portalGroup: THREE.Group | null = null
let transferParticle: THREE.Mesh | null = null
let cameraEntry = 0
let transferProgress = -1
let spaceRenderer: THREE.WebGLRenderer | null = null
let spaceScene: THREE.Scene | null = null
let spaceCamera: THREE.PerspectiveCamera | null = null
let spaceAnimationFrame = 0
let spaceResizeObserver: ResizeObserver | null = null
let spaceCore: THREE.Group | null = null
let spaceDoor: THREE.Group | null = null
let spaceStars: THREE.Points | null = null
let spaceMouse = { x: 0, y: 0 }
let spaceTargetMouse = { x: 0, y: 0 }
let spaceStartedAt = 0

const fileLabel = computed(() => selectedFile.value?.name ?? 'solte um arquivo aqui')
const isPreparingBackend = computed(() => ['checking', 'waking_up', 'connecting_ws'].includes(serverStatus.value))
const preparationTitle = computed(() => {
  if (serverStatus.value === 'checking') return 'Checking server...'
  if (serverStatus.value === 'waking_up') return 'Starting server...'
  if (serverStatus.value === 'connecting_ws') return 'Connecting...'
  if (serverStatus.value === 'failed') return 'Unable to connect to the server'
  return 'Server ready'
})
const preparationMessage = computed(() => {
  if (serverStatus.value === 'checking') return 'We are checking whether PyDrop is ready.'
  if (serverStatus.value === 'waking_up') return 'The server is starting. This usually takes a few seconds.'
  if (serverStatus.value === 'connecting_ws') return 'The server is ready. Establishing a secure connection.'
  if (serverStatus.value === 'failed') return 'We tried automatically, but the server did not respond.'
  return 'You can start your transfer.'
})

async function createRoom() {
  view.value = 'room'
  spacePhase.value = 'creating'
  try {
    await prepareBackend()
    const result = await api.createRoom()
    roomCode.value = result.code
    spacePhase.value = 'waiting'
    connectToRoom()
  } catch {
    serverStatus.value = 'failed'
  }
}

function retryCreateRoom() {
  createRoom()
}

async function prepareBackend() {
  await api.ensureBackendReady((state, elapsedSeconds) => {
    serverElapsedSeconds.value = elapsedSeconds
    if (state === 'checking') serverStatus.value = 'checking'
    if (state === 'waking_up') serverStatus.value = 'waking_up'
    if (state === 'ready') serverStatus.value = 'ready'
  })
}

async function joinRoom() {
  const code = window.prompt('Enter the room code')?.trim().toUpperCase()
  if (!code || !/^[A-Z0-9]{8}$/.test(code)) {
    if (code) window.alert('Room codes have eight letters or numbers.')
    return
  }
  roomCode.value = code
  view.value = 'room'
  spacePhase.value = 'creating'
  prepareBackend()
    .then(() => {
      spacePhase.value = 'waiting'
      connectToRoom()
    })
    .catch(() => { serverStatus.value = 'failed' })
}

function connectToRoom() {
  window.clearTimeout(reconnectTimer)
  serverStatus.value = 'connecting_ws'
  intentionalDisconnect = true
  roomConnection?.disconnect()
  directTransfer?.close()
  directTransfer = null
  intentionalDisconnect = false
  roomConnection = api.connectRoomSocket(roomCode.value, {
    onRoomState: (sessions, initiator) => {
      if (sessions > 1) {
        setupDirectTransfer(initiator)
        view.value = 'connected'
        spacePhase.value = 'connected'
        serverStatus.value = 'connected'
        reconnectAttempts = 0
      }
    },
    onUserJoined: (sessions) => {
      if (sessions > 1) {
        setupDirectTransfer(true)
        view.value = 'connected'
        spacePhase.value = 'connected'
        serverStatus.value = 'connected'
        reconnectAttempts = 0
      }
    },
    onSignal: (message) => {
      directTransfer?.handleSignal(message).catch((error) => window.alert(String(error)))
    },
    onDisconnect: () => {
      if (intentionalDisconnect || roomFull.value) return
      if (reconnectAttempts >= 3) {
        serverStatus.value = 'failed'
        return
      }
      reconnectAttempts += 1
      serverStatus.value = 'connecting_ws'
      reconnectTimer = window.setTimeout(() => connectToRoom(), reconnectAttempts * 1500)
    },
    onClose: (code) => {
      if (code === 1008) {
        roomFull.value = true
        serverStatus.value = 'failed'
        window.clearTimeout(reconnectTimer)
      }
    },
  })
}

function setupDirectTransfer(initiator: boolean) {
  if (directTransfer || !roomConnection) return
  directTransfer = new api.DirectTransfer(
    (message) => roomConnection?.send(message),
    () => { spacePhase.value = 'connected' },
    (file, blob) => {
      roomFiles.value = [...roomFiles.value, file]
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      URL.revokeObjectURL(url)
    },
    (progress) => { transferProgress = progress },
    (message) => window.alert(message),
  )
  directTransfer.start(initiator).catch((error) => window.alert(String(error)))
}

function reset() {
  intentionalDisconnect = true
  window.clearTimeout(reconnectTimer)
  roomConnection?.disconnect()
  directTransfer?.close()
  roomConnection = null
  directTransfer = null
  view.value = 'start'
  selectedFile.value = null
  transferComplete.value = false
  isTransferring.value = false
  serverStatus.value = 'idle'
  serverElapsedSeconds.value = 0
  roomFull.value = false
  reconnectAttempts = 0
}

async function prepareOnStartup() {
  try {
    await prepareBackend()
  } catch {
    serverStatus.value = 'failed'
  }
}

function toggleImmersiveMode() {
  immersiveMode.value = !immersiveMode.value
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (file) {
    const validationError = api.validateTransferFile(file)
    if (validationError) {
      input.value = ''
      selectedFile.value = null
      window.alert(validationError)
      return
    }
  }
  selectedFile.value = file
  transferComplete.value = false
}

async function startTransfer() {
  if (!selectedFile.value || !directTransfer) return
  isTransferring.value = true
  transferComplete.value = false
  transferProgress = 0
  try {
    await directTransfer.sendFile(selectedFile.value)
    transferComplete.value = true
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error))
  } finally {
    isTransferring.value = false
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

function createThreeScene() {
  if (!threeMount.value || renderer) return

  const width = threeMount.value.clientWidth
  const height = threeMount.value.clientHeight
  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x151614, 7, 17)
  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 40)
  camera.position.set(0, 2.2, 8.5)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  threeMount.value.appendChild(renderer.domElement)

  scene.add(new THREE.HemisphereLight(0xcad2a0, 0x171917, 1.3))
  const keyLight = new THREE.DirectionalLight(0xffc59f, 2.4)
  keyLight.position.set(-3, 6, 4)
  keyLight.castShadow = true
  scene.add(keyLight)
  const portalLight = new THREE.PointLight(0xd6e86a, 5, 7)
  portalLight.position.set(0, 2.2, 0)
  scene.add(portalLight)

  const room = new THREE.Group()
  scene.add(room)
  addBox(room, [12, 0.2, 9], [0, 0, 0], 0x33382d).receiveShadow = true
  addBox(room, [12, 6, 0.2], [0, 3, -3.5], 0x22251f)
  addBox(room, [0.2, 6, 9], [-5.8, 3, 0], 0x252a22)

  const rug = new THREE.Mesh(new THREE.PlaneGeometry(8, 4.5), material(0x454a3d))
  rug.rotation.x = -Math.PI / 2
  rug.position.y = 0.11
  rug.position.z = 0.2
  room.add(rug)

  const windowGroup = new THREE.Group()
  windowGroup.position.set(-3.4, 3.3, -3.32)
  addBox(windowGroup, [2.4, 1.8, 0.08], [0, 0, 0], 0x718171)
  addBox(windowGroup, [0.07, 1.8, 0.1], [0, 0, 0.08], 0x2a3028)
  addBox(windowGroup, [2.4, 0.07, 0.1], [0, 0, 0.08], 0x2a3028)
  room.add(windowGroup)

  const table = new THREE.Group()
  table.position.set(-2.7, 0, 0.5)
  addBox(table, [3.4, 0.18, 1.35], [0, 2.05, 0], 0x785b44)
  ;[-1.35, 1.35].forEach((x) => addBox(table, [0.12, 2, 0.12], [x, 1, 0], 0x4e3e32))
  room.add(table)

  const computer = new THREE.Group()
  computer.position.set(-2.7, 2.15, 0.45)
  addBox(computer, [1.6, 1.05, 0.12], [0, 0.62, 0], 0x191b19)
  addBox(computer, [0.12, 0.55, 0.12], [0, 0.18, 0], 0x626b5a)
  addBox(computer, [0.75, 0.04, 0.35], [0, -0.1, 0.08], 0x626b5a)
  room.add(computer)

  const phone = new THREE.Group()
  phone.position.set(3.1, 1.15, 0.1)
  addBox(phone, [0.65, 1.45, 0.12], [0, 0.75, 0], 0x151716)
  addBox(phone, [0.48, 1.05, 0.02], [0, 0.75, 0.07], 0x4a5945)
  phone.rotation.z = -0.1
  room.add(phone)

  const door = new THREE.Group()
  door.position.set(0, 2.6, -3.25)
  const doorFrame = material(0x79865a)
  addBox(door, [3.2, 0.18, 0.25], [0, 2, 0], 0x79865a)
  addBox(door, [0.18, 4, 0.25], [-1.5, 0, 0], 0x79865a)
  addBox(door, [0.18, 4, 0.25], [1.5, 0, 0], 0x79865a)
  const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.8, 0.08), doorFrame)
  doorPanel.position.y = 0
  door.add(doorPanel)
  doorPanel.userData.isDoor = true
  room.add(door)

  portalGroup = new THREE.Group()
  portalGroup.position.set(0, 2.35, 0)
  const portalMaterial = new THREE.MeshBasicMaterial({ color: 0xd6e86a, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
  const portal = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 16, 64), portalMaterial)
  portal.rotation.x = Math.PI / 2
  portalGroup.add(portal)
  const portalCore = new THREE.Mesh(new THREE.CircleGeometry(0.78, 64), new THREE.MeshBasicMaterial({ color: 0x3c4b2d, transparent: true, opacity: 0.8, side: THREE.DoubleSide }))
  portalCore.rotation.x = Math.PI / 2
  portalGroup.add(portalCore)
  scene.add(portalGroup)

  transferParticle = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), new THREE.MeshBasicMaterial({ color: 0xe78363 }))
  transferParticle.visible = false
  scene.add(transferParticle)

  camera.lookAt(0, 1.7, -0.7)
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
  if (portalGroup) {
    portalGroup.rotation.z = seconds * 0.35
    portalGroup.scale.setScalar(1 + Math.sin(seconds * 3) * 0.04)
  }
  cameraEntry = Math.min(cameraEntry + 0.012, 1)
  const entryEase = 1 - Math.pow(1 - cameraEntry, 3)
  camera.position.z = THREE.MathUtils.lerp(8.5, 5.4, entryEase)
  camera.position.x = Math.sin(seconds * 0.22) * 0.15
  camera.lookAt(0, 1.7, -0.7)
  if (transferParticle && transferProgress >= 0) {
    transferProgress = Math.min(transferProgress + 0.012, 1.12)
    const progress = Math.min(transferProgress, 1)
    transferParticle.visible = transferProgress < 1.12
    transferParticle.position.set(THREE.MathUtils.lerp(-2.7, 2.9, progress), 2.2 + Math.sin(progress * Math.PI) * 0.5, 0.1)
    transferParticle.rotation.x += 0.12
    transferParticle.rotation.y += 0.1
  }
  renderer.render(scene, camera)
  animationFrame = requestAnimationFrame(animateThreeScene)
}

function disposeThreeScene() {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  renderer?.dispose()
  renderer?.domElement.remove()
  renderer = null
  scene = null
  camera = null
  portalGroup = null
  transferParticle = null
}

function createSpaceScene() {
  if (!spaceMount.value || spaceRenderer) return
  const width = spaceMount.value.clientWidth
  const height = spaceMount.value.clientHeight
  spaceScene = new THREE.Scene()
  spaceScene.fog = new THREE.FogExp2(0x070b12, 0.035)
  spaceCamera = new THREE.PerspectiveCamera(52, width / height, 0.1, 100)
  spaceCamera.position.set(0, 0.3, 8)

  spaceRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  spaceRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8))
  spaceRenderer.setSize(width, height)
  spaceMount.value.appendChild(spaceRenderer.domElement)
  spaceScene.add(new THREE.AmbientLight(0x536078, 0.5))
  const cyanLight = new THREE.PointLight(0x9ce7d4, 8, 16)
  cyanLight.position.set(0, 0, 2)
  spaceScene.add(cyanLight)

  const starCount = window.innerWidth < 700 ? 450 : 1000
  const starPositions = new Float32Array(starCount * 3)
  const starColors = new Float32Array(starCount * 3)
  for (let index = 0; index < starCount; index += 1) {
    const radius = 4 + Math.random() * 18
    const angle = Math.random() * Math.PI * 2
    starPositions[index * 3] = Math.cos(angle) * radius
    starPositions[index * 3 + 1] = (Math.random() - 0.5) * 12
    starPositions[index * 3 + 2] = -Math.random() * 25
    const warm = Math.random() > 0.76
    starColors[index * 3] = warm ? 1 : 0.55
    starColors[index * 3 + 1] = warm ? 0.65 : 0.9
    starColors[index * 3 + 2] = warm ? 0.45 : 0.85
  }
  const starGeometry = new THREE.BufferGeometry()
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3))
  spaceStars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true }))
  spaceScene.add(spaceStars)

  const architecture = new THREE.Group()
  for (let index = 0; index < 12; index += 1) {
    const height = 0.4 + Math.random() * 2.2
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.025, height, 0.025), new THREE.MeshBasicMaterial({ color: index % 2 ? 0xe78363 : 0x9ce7d4, transparent: true, opacity: 0.36 }))
    beam.position.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 3, -3 - Math.random() * 8)
    beam.rotation.z = (Math.random() - 0.5) * 0.5
    architecture.add(beam)
  }
  spaceScene.add(architecture)

  spaceCore = new THREE.Group()
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.68, 2), new THREE.MeshStandardMaterial({ color: 0x9ce7d4, emissive: 0x376b68, emissiveIntensity: 2.2, roughness: 0.24, metalness: 0.65, wireframe: true }))
  spaceCore.add(core)
  const coreGlow = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 24), new THREE.MeshBasicMaterial({ color: 0xe1ffcf, transparent: true, opacity: 0.55 }))
  spaceCore.add(coreGlow)
  spaceCore.position.set(0, 0.3, -0.4)
  spaceScene.add(spaceCore)

  spaceDoor = new THREE.Group()
  spaceDoor.position.set(0, 0.7, -2)
  const doorMaterial = new THREE.MeshStandardMaterial({ color: 0xd6e86a, emissive: 0x63722b, emissiveIntensity: 1.7, transparent: true, opacity: 0 })
  const doorRing = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.12, 16, 64), doorMaterial)
  spaceDoor.add(doorRing)
  const doorSurface = new THREE.Mesh(new THREE.CircleGeometry(1.28, 64), new THREE.MeshBasicMaterial({ color: 0x2e3d2b, transparent: true, opacity: 0 }))
  spaceDoor.add(doorSurface)
  spaceScene.add(spaceDoor)

  spaceStartedAt = performance.now()
  spaceResizeObserver = new ResizeObserver(() => resizeSpaceScene())
  spaceResizeObserver.observe(spaceMount.value)
  spaceMount.value.addEventListener('pointermove', onSpacePointerMove)
  spaceMount.value.addEventListener('pointerleave', onSpacePointerLeave)
  spaceAnimationFrame = requestAnimationFrame(animateSpaceScene)
}

function onSpacePointerMove(event: PointerEvent) {
  if (!spaceMount.value) return
  spaceTargetMouse.x = (event.clientX / spaceMount.value.clientWidth) * 2 - 1
  spaceTargetMouse.y = (event.clientY / spaceMount.value.clientHeight) * 2 - 1
}

function onSpacePointerLeave() {
  spaceTargetMouse = { x: 0, y: 0 }
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
  spaceMouse.x += (spaceTargetMouse.x - spaceMouse.x) * 0.025
  spaceMouse.y += (spaceTargetMouse.y - spaceMouse.y) * 0.025
  spaceCamera.position.x = spaceMouse.x * 0.35 + Math.sin(elapsed * 0.16) * 0.08
  spaceCamera.position.y = 0.3 - spaceMouse.y * 0.22 + Math.cos(elapsed * 0.2) * 0.06
  spaceCamera.lookAt(0, 0.25, -1.5)
  if (spaceStars) spaceStars.rotation.y = elapsed * 0.006
  if (spaceCore) {
    spaceCore.rotation.x = elapsed * 0.18
    spaceCore.rotation.y = elapsed * 0.3
    spaceCore.scale.setScalar(1 + Math.sin(elapsed * 2.3) * 0.08)
    const coreOpacity = spacePhase.value === 'creating' ? Math.min(elapsed * 2, 1) : 1
    spaceCore.visible = spacePhase.value !== 'waiting' || elapsed % 3 < 2.7
    spaceCore.children.forEach((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material && 'opacity' in child.material) child.material.opacity = coreOpacity
    })
  }
  if (spaceDoor) {
    const doorProgress = spacePhase.value === 'waiting' || spacePhase.value === 'connected' ? Math.min(Math.max(elapsed - 0.5, 0) / 1.5, 1) : 0
    spaceDoor.scale.setScalar(0.72 + doorProgress * 0.28)
    spaceDoor.position.z = -2 + doorProgress * 0.5
    spaceDoor.children.forEach((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material && 'opacity' in child.material) child.material.opacity = doorProgress * 0.65
    })
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
  }
  spaceRenderer?.dispose()
  spaceRenderer?.domElement.remove()
  spaceRenderer = null
  spaceScene = null
  spaceCamera = null
  spaceCore = null
  spaceDoor = null
  spaceStars = null
}

watch(view, async (currentView) => {
  if (immersiveMode.value && (currentView === 'start' || currentView === 'room')) {
    disposeSpaceScene()
    await nextTick()
    createSpaceScene()
  } else if (currentView === 'connected') {
    disposeSpaceScene()
    if (immersiveMode.value) {
      await nextTick()
      cameraEntry = 0
      createThreeScene()
    }
  } else {
    disposeThreeScene()
    disposeSpaceScene()
  }
})

watch(immersiveMode, async (enabled) => {
  disposeThreeScene()
  disposeSpaceScene()
  if (!enabled) return
  await nextTick()
  if (view.value === 'connected') {
    cameraEntry = 0
    createThreeScene()
  } else {
    createSpaceScene()
  }
})

watch(isTransferring, (transferring) => {
  if (transferring) transferProgress = 0
})

onBeforeUnmount(disposeThreeScene)
onBeforeUnmount(disposeSpaceScene)
onBeforeUnmount(() => {
  roomConnection?.disconnect()
  directTransfer?.close()
})
onMounted(() => {
  if (immersiveMode.value && view.value === 'start') nextTick(createSpaceScene)
  prepareOnStartup()
})
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <button class="brand" type="button" @click="reset">
        <span class="brand-mark"><span></span><span></span></span>
        <span>pydrop</span>
      </button>
      <div class="topbar-actions">
        <div class="topbar-status"><span class="status-dot"></span> {{ immersiveMode ? 'immersive mode' : 'simple mode' }}</div>
        <button class="mode-toggle" :class="{ active: immersiveMode }" type="button" @click="toggleImmersiveMode">
          <span class="mode-toggle-icon">{{ immersiveMode ? '◈' : '✦' }}</span>
          {{ immersiveMode ? 'simple view' : 'enable 3D' }}
        </button>
      </div>
    </header>

    <section v-if="view === 'start'" class="welcome-view page-enter" :class="{ 'simple-mode': !immersiveMode }">
      <div v-if="immersiveMode" ref="spaceMount" class="space-world" aria-label="Espaço 3D interativo do PyDrop"></div>
      <div class="welcome-copy">
        <p class="eyebrow">private file transfer</p>
        <h1>Move files<br /><em>simply.</em></h1>
        <p class="intro">Create a temporary room and connect your devices in seconds.</p>
        <div class="welcome-actions">
          <button class="button button-primary" type="button" :disabled="isPreparingBackend" @click="createRoom">{{ isPreparingBackend ? 'preparing server...' : 'create a room' }} <span>↗</span></button>
          <button class="button button-quiet" type="button" @click="joinRoom">join with a code</button>
        </div>
        <div v-if="serverStatus !== 'idle' && view === 'start'" class="server-preparation" aria-live="polite">
          <strong>{{ preparationTitle }}</strong>
          <span>{{ preparationMessage }}</span>
          <small v-if="isPreparingBackend">Elapsed time: {{ serverElapsedSeconds }}s. You do not need to refresh.</small>
          <button v-if="serverStatus === 'failed'" class="button button-quiet" type="button" @click="retryCreateRoom">try again</button>
        </div>
        <p class="microcopy"><span class="lock-icon">+</span> no account · temporary room</p>
      </div>
      <div v-if="immersiveMode" class="home-caption" aria-hidden="true"><span>01</span><i></i><span>a temporary room for your devices</span></div>
    </section>

    <section v-else-if="view === 'room'" class="room-lobby page-enter" :class="{ 'simple-mode': !immersiveMode }">
      <div v-if="immersiveMode" ref="spaceMount" class="space-world" aria-label="Espaço 3D aguardando dispositivo"></div>
      <div class="lobby-heading">
        <p class="eyebrow">room ready</p>
        <h1>Connect another<br /><em>device.</em></h1>
        <p>Open PyDrop on another device and enter this code.</p>
      </div>
      <div class="code-panel">
        <span class="code-label">room / código</span>
        <strong>{{ roomCode || '...' }}</strong>
        <div class="code-meta">
          <span class="pulse-dot"></span>
          {{ roomFull ? 'room is full' : serverStatus === 'checking' ? 'checking server...' : serverStatus === 'waking_up' ? 'starting server...' : serverStatus === 'connecting_ws' ? 'connecting...' : serverStatus === 'failed' ? 'could not connect' : 'waiting for device' }}
        </div>
        <small v-if="roomFull" class="server-elapsed">This room already has two connected devices.</small>
        <small v-if="isPreparingBackend" class="server-elapsed">Elapsed time: {{ serverElapsedSeconds }}s</small>
      </div>
      <div class="lobby-actions">
        <button v-if="serverStatus === 'failed'" class="button button-primary" type="button" @click="retryCreateRoom">retry connection <span>↗</span></button>
        <button v-else class="button button-primary" type="button" disabled>{{ roomCode ? 'waiting for another device' : 'connecting to server' }} <span>...</span></button>
        <button class="button button-quiet" type="button" @click="reset">cancel</button>
      </div>
      <div class="qr-placeholder"><span class="qr-grid"></span><div><strong>or scan to join</strong><small>QR code coming soon</small></div></div>
    </section>

    <section v-else class="connected-view page-enter" :class="{ 'simple-mode': !immersiveMode }">
      <div class="scene-header">
        <div><p class="eyebrow">sala nova-47</p><h1>Seus dispositivos<br /><em>estão juntos.</em></h1></div>
        <button class="exit-button" type="button" @click="reset">sair da sala <span>×</span></button>
      </div>

      <div class="room-scene" :class="{ transferring: isTransferring, complete: transferComplete }">
        <div v-if="immersiveMode" ref="threeMount" class="three-room" aria-label="Sala 3D do PyDrop"></div>
        <div v-if="immersiveMode" class="scene-device-label scene-computer-label">my computer <small>Windows · Chrome</small></div>
        <div v-if="immersiveMode" class="scene-device-label scene-phone-label">my phone <small>Android · Chrome</small></div>
        <div v-if="immersiveMode" class="scene-portal-label">{{ transferComplete ? 'sent' : 'portal' }}</div>
        <div v-else class="simple-room-content">
          <div class="simple-device"><span class="simple-device-icon">▣</span><strong>My computer</strong><small>Windows · Chrome</small></div>
          <div class="simple-connection"><span></span><strong>{{ transferComplete ? 'Transfer complete' : 'Connected' }}</strong><span></span></div>
          <div class="simple-device"><span class="simple-device-icon">▯</span><strong>My phone</strong><small>Android · Chrome</small></div>
        </div>
      </div>

      <div class="transfer-dock">
        <div class="dock-top"><span class="dock-kicker">choose an action</span><div class="direction-switch"><button :class="{ active: direction === 'send' }" type="button" @click="direction = 'send'">send</button><button :class="{ active: direction === 'receive' }" type="button" @click="direction = 'receive'">receive</button></div></div>
        <label class="drop-zone" :class="{ 'has-file': selectedFile }"><input type="file" @change="onFileSelected" /><span class="upload-mark">↑</span><span><strong>{{ fileLabel }}</strong><small>{{ selectedFile ? 'file selected' : 'choose a file to transfer' }}</small></span></label>
        <button class="transfer-button" :disabled="!selectedFile || isTransferring" type="button" @click="startTransfer">{{ isTransferring ? 'transferring...' : transferComplete ? 'send another file' : direction === 'send' ? 'send file' : 'receive file' }} <span>→</span></button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.app-shell { min-height: 100vh; overflow: hidden; padding: 30px 5vw 42px; position: relative; background: radial-gradient(circle at 72% 45%, #2a2d22 0, var(--night) 34rem); }
.app-shell::before { background-image: linear-gradient(rgba(244,241,234,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(244,241,234,.025) 1px, transparent 1px); background-size: 72px 72px; content: ''; inset: 0; mask-image: linear-gradient(to bottom, black, transparent 80%); opacity: .5; pointer-events: none; position: absolute; }
.topbar, .welcome-view, .room-lobby, .connected-view { margin: 0 auto; max-width: 1320px; position: relative; z-index: 1; }
.topbar { align-items: center; display: flex; justify-content: space-between; }
.brand { align-items: center; background: transparent; border: 0; color: var(--ink); display: flex; font-size: 20px; font-weight: 700; gap: 11px; letter-spacing: -.8px; padding: 0; }
.brand-mark { display: flex; gap: 3px; height: 20px; transform: rotate(-28deg); width: 21px; }
.brand-mark span { background: var(--lime); border-radius: 6px; display: block; transform: skew(-17deg); width: 8px; }
.brand-mark span:last-child { background: var(--coral); margin-top: 5px; }
.topbar-status { align-items: center; color: var(--muted); display: flex; font-size: 11px; gap: 8px; letter-spacing: .08em; text-transform: uppercase; }
.status-dot, .pulse-dot { background: var(--lime); border-radius: 50%; display: inline-block; height: 6px; width: 6px; }
.welcome-view { align-items: center; display: grid; grid-template-columns: minmax(340px, .85fr) 1.15fr; min-height: calc(100vh - 105px); }
.eyebrow { color: var(--lime); font-size: 11px; letter-spacing: .18em; margin-bottom: 25px; text-transform: uppercase; }
h1 { font-size: clamp(3rem, 5.6vw, 5.8rem); font-weight: 400; letter-spacing: -0.075em; line-height: .95; margin: 0; }
h1 em { color: var(--coral); font-family: Georgia, serif; font-weight: 400; }
.intro { color: var(--muted); font-size: 16px; line-height: 1.65; margin: 31px 0; max-width: 365px; }
.welcome-actions, .lobby-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 19px; }
.button { border: 0; font-size: 12px; letter-spacing: .02em; padding: 15px 20px; transition: transform .25s, background .25s; }
.button:hover { transform: translateY(-3px); }
.button-primary { background: var(--lime); color: #1a1b17; font-weight: 700; }
.button-primary span, .transfer-button span { font-size: 18px; margin-left: 18px; vertical-align: -1px; }
.button-quiet { background: transparent; color: var(--muted); padding-left: 0; padding-right: 0; }
.button-quiet:hover { color: var(--ink); }
.microcopy { color: #706f68; font-size: 10px; letter-spacing: .05em; margin-top: 34px; text-transform: uppercase; }
.server-preparation { border-left: 2px solid var(--lime); display: grid; gap: 6px; margin: 24px 0 0; max-width: 380px; padding-left: 14px; }
.server-preparation strong { color: var(--ink); font-size: 13px; font-weight: 600; }
.server-preparation span, .server-preparation small, .server-elapsed { color: var(--muted); font-size: 12px; line-height: 1.5; }
.server-preparation .button { justify-self: start; margin-top: 4px; }
.server-elapsed { display: block; margin-top: 8px; }
.lock-icon { border: 1px solid #6f7068; border-radius: 50%; display: inline-block; font-size: 9px; height: 15px; line-height: 13px; margin-right: 6px; text-align: center; width: 15px; }
.hero-orbit { height: min(49vw, 600px); justify-self: end; max-height: 600px; max-width: 650px; position: relative; width: 100%; }
.orbit { border: 1px solid rgba(214,232,106,.22); border-radius: 50%; left: 50%; position: absolute; top: 50%; transform: translate(-50%, -50%) rotate(-18deg); }
.orbit-one { height: 62%; width: 72%; }
.orbit-two { border-color: rgba(231,131,99,.24); height: 77%; transform: translate(-50%, -50%) rotate(67deg); width: 55%; }
.hero-core { align-items: center; background: radial-gradient(circle, #596339 0, #2a3025 48%, #1b1e1b 70%); border: 1px solid rgba(214,232,106,.4); border-radius: 50%; box-shadow: 0 0 90px rgba(214,232,106,.18); display: flex; height: 142px; justify-content: center; left: 50%; position: absolute; top: 50%; transform: translate(-50%, -50%); width: 142px; }
.hero-core strong { color: var(--lime); font-size: 36px; font-weight: 400; transform: rotate(-45deg); }
.core-ring { border: 1px solid rgba(244,241,234,.32); border-radius: 50%; inset: 12px; position: absolute; }
.orbit-label { align-items: center; background: rgba(32,34,30,.82); border: 1px solid var(--line); color: var(--muted); display: flex; font-size: 11px; gap: 10px; padding: 10px 13px; position: absolute; }
.label-pc { left: 7%; top: 22%; }.label-phone { bottom: 18%; right: 5%; }
.device-glyph { border: 1px solid var(--muted); display: inline-block; position: relative; }.small-screen { height: 13px; width: 18px; }.small-phone { border-radius: 3px; height: 17px; width: 10px; }
.small-screen::after { background: var(--muted); bottom: -4px; content: ''; height: 2px; left: 5px; position: absolute; width: 7px; }
.page-enter { animation: enter .65s ease both; }
@keyframes enter { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
.room-lobby { align-items: center; display: flex; flex-direction: column; justify-content: center; min-height: calc(100vh - 105px); text-align: center; }
.room-lobby .eyebrow { margin-bottom: 20px; }.room-lobby h1 { font-size: clamp(3rem, 6vw, 5.5rem); }.room-lobby > p { color: var(--muted); margin: 23px 0 35px; }
.code-panel { background: rgba(32,34,30,.8); border: 1px solid var(--line); margin-bottom: 29px; padding: 25px 50px 20px; }
.code-label, .dock-kicker { color: var(--muted); display: block; font-size: 10px; letter-spacing: .18em; text-transform: uppercase; }.code-panel strong { display: block; font-size: clamp(2.8rem, 6vw, 5rem); letter-spacing: .12em; line-height: 1.1; margin: 10px 0 13px; }.code-meta { align-items: center; color: var(--lime); display: flex; font-size: 11px; gap: 8px; justify-content: center; }.pulse-dot { animation: pulse 1.8s infinite; }.qr-placeholder { align-items: center; color: var(--muted); display: flex; gap: 17px; margin-top: 52px; text-align: left; }.qr-placeholder strong, .qr-placeholder small { display: block; font-size: 11px; font-weight: 400; }.qr-placeholder small { color: #6f7068; margin-top: 4px; }.qr-grid { background: repeating-linear-gradient(90deg, var(--ink) 0 3px, transparent 3px 6px), repeating-linear-gradient(0deg, var(--ink) 0 3px, transparent 3px 6px); border: 7px solid var(--ink); height: 49px; opacity: .8; width: 49px; }
@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(214,232,106,.08); opacity: .45; } }
.connected-view { padding-top: 7vh; }.scene-header { align-items: flex-end; display: flex; justify-content: space-between; }.scene-header .eyebrow { margin-bottom: 18px; }.scene-header h1 { font-size: clamp(2.8rem, 5vw, 5rem); }.exit-button { background: transparent; border: 1px solid var(--line); color: var(--muted); font-size: 11px; padding: 10px 13px; }.exit-button span { color: var(--coral); font-size: 18px; margin-left: 13px; vertical-align: -2px; }
.room-scene { background: linear-gradient(145deg, rgba(39,43,33,.9), rgba(22,24,22,.96)); border: 1px solid var(--line); height: min(43vw, 495px); margin-top: 38px; overflow: hidden; position: relative; }.room-scene::after { background: linear-gradient(transparent 55%, rgba(10,11,10,.9)); content: ''; inset: 0; pointer-events: none; position: absolute; }.wall-line { background: rgba(244,241,234,.08); height: 1px; left: 0; position: absolute; right: 0; top: 62%; transform: skewY(-8deg); }.window-shape { border: 1px solid rgba(244,241,234,.14); height: 31%; left: 10%; position: absolute; top: 13%; transform: perspective(180px) rotateY(-15deg); width: 19%; }.window-shape i { border-left: 1px solid rgba(244,241,234,.12); bottom: 0; position: absolute; top: 0; width: 33%; }.window-shape i:nth-child(1) { left: 33%; }.window-shape i:nth-child(2) { left: 66%; }.window-shape i:nth-child(3) { border-bottom: 1px solid rgba(244,241,234,.12); border-left: 0; left: 0; right: 0; top: 50%; }.lamp-shape { background: var(--coral); border-radius: 50% 50% 5px 5px; box-shadow: 0 0 90px 25px rgba(231,131,99,.12); height: 43px; opacity: .55; position: absolute; right: 19%; top: 15%; width: 72px; }.lamp-shape::after { background: var(--coral); content: ''; height: 80px; left: 35px; opacity: .3; position: absolute; top: 40px; width: 2px; }.shelf-shape { border-bottom: 3px solid #45493c; height: 20%; position: absolute; right: 6%; top: 40%; width: 20%; }.shelf-shape::after { background: #373b32; bottom: -39px; content: ''; height: 38px; left: 12%; position: absolute; width: 3px; }.shelf-shape i { background: #9d7657; bottom: 3px; height: 15px; position: absolute; width: 17px; }.shelf-shape i:nth-child(1) { left: 11%; }.shelf-shape i:nth-child(2) { height: 25px; left: 40%; }.shelf-shape i:nth-child(3) { left: 70%; }
.device { bottom: 18%; position: absolute; text-align: center; z-index: 2; }.device-computer { left: 16%; }.device-phone { right: 17%; }.monitor { background: #171917; border: 4px solid #4d5144; height: 105px; padding-top: 44px; position: relative; transform: perspective(400px) rotateY(7deg); width: 155px; }.monitor span { color: var(--lime); font-size: 10px; letter-spacing: .16em; }.monitor-stand { background: #4d5144; height: 42px; margin: 0 auto; position: relative; width: 9px; }.monitor-stand::after { background: #4d5144; bottom: -5px; content: ''; height: 5px; left: -25px; position: absolute; width: 59px; }.phone { background: #171917; border: 4px solid #707667; border-radius: 13px; height: 145px; padding: 8px; transform: rotate(8deg); width: 78px; }.phone span { border: 1px solid rgba(214,232,106,.4); display: block; height: 100%; }.device-caption { display: block; margin-top: 17px; text-align: left; }.device-phone .device-caption { text-align: right; }.device-caption strong, .device-caption small { display: block; }.device-caption strong { font-size: 12px; font-weight: 400; }.device-caption small { color: var(--muted); font-size: 10px; margin-top: 3px; }.portal { align-items: center; display: flex; flex-direction: column; left: 50%; position: absolute; top: 30%; transform: translateX(-50%); z-index: 3; }.portal-glow { background: var(--lime); border-radius: 50%; box-shadow: 0 0 50px 12px rgba(214,232,106,.48); height: 76px; opacity: .6; position: absolute; top: 13px; width: 76px; }.portal-core { align-items: center; background: radial-gradient(circle, #d6e86a 0, #788642 37%, #252a22 67%); border: 1px solid var(--lime); border-radius: 50%; color: #313525; display: flex; font-size: 28px; height: 102px; justify-content: center; position: relative; transform: rotate(-45deg); width: 102px; }.portal > span { color: var(--lime); font-size: 10px; letter-spacing: .2em; margin-top: 18px; text-transform: uppercase; }.file-particle { animation: fly 1.8s ease-in-out both; background: var(--coral); bottom: 46%; box-shadow: 0 0 20px rgba(231,131,99,.65); color: var(--night); font-size: 10px; left: 22%; padding: 8px; position: absolute; z-index: 5; }.room-scene.complete .portal-core { animation: success .55s ease; }.room-scene.complete .portal > span { color: var(--lime); }
.three-room { inset: 0; position: absolute; z-index: 1; }.three-room canvas { display: block; height: 100%; width: 100%; }.scene-device-label, .scene-portal-label { background: rgba(20,22,19,.78); border: 1px solid rgba(244,241,234,.18); color: var(--ink); font-size: 11px; padding: 8px 10px; position: absolute; z-index: 2; }.scene-device-label small { color: var(--muted); display: block; font-size: 9px; margin-top: 2px; }.scene-computer-label { bottom: 18%; left: 14%; }.scene-phone-label { bottom: 18%; right: 14%; text-align: right; }.scene-portal-label { color: var(--lime); left: 50%; top: 26%; transform: translateX(-50%); text-transform: uppercase; }
@keyframes fly { 0% { left: 22%; opacity: 0; transform: scale(.5); } 20% { opacity: 1; } 50% { left: 49%; transform: scale(1.1) rotate(20deg); } 100% { left: 76%; opacity: 0; transform: scale(.5) rotate(70deg); } } @keyframes success { 50% { box-shadow: 0 0 0 20px rgba(214,232,106,.1), 0 0 55px 20px rgba(214,232,106,.6); } }
.transfer-dock { background: rgba(32,34,30,.96); border: 1px solid var(--line); margin: -1px auto 0; max-width: 850px; padding: 22px 25px 25px; position: relative; z-index: 4; }.dock-top { align-items: center; display: flex; justify-content: space-between; margin-bottom: 17px; }.direction-switch { border: 1px solid var(--line); display: flex; padding: 3px; }.direction-switch button { background: transparent; border: 0; color: var(--muted); font-size: 10px; padding: 7px 12px; text-transform: uppercase; }.direction-switch button.active { background: var(--lime); color: var(--night); }.drop-zone { align-items: center; border: 1px dashed rgba(244,241,234,.25); cursor: pointer; display: flex; gap: 15px; min-height: 54px; padding: 10px 16px; transition: border-color .2s, background .2s; }.drop-zone:hover, .drop-zone.has-file { background: rgba(214,232,106,.05); border-color: var(--lime); }.drop-zone input { display: none; }.upload-mark { align-items: center; border: 1px solid var(--coral); border-radius: 50%; color: var(--coral); display: flex; height: 27px; justify-content: center; width: 27px; }.drop-zone strong, .drop-zone small { display: block; font-size: 11px; font-weight: 400; }.drop-zone small { color: var(--muted); margin-top: 2px; }.transfer-button { background: var(--coral); border: 0; color: #211b17; font-size: 12px; font-weight: 700; margin-top: 12px; padding: 14px 17px; width: 100%; }.transfer-button:disabled { cursor: not-allowed; filter: grayscale(.6); opacity: .4; }
@media (max-width: 720px) { .app-shell { padding: 23px 22px 30px; }.topbar-status { font-size: 9px; }.welcome-view { display: flex; flex-direction: column; justify-content: center; min-height: calc(100vh - 85px); }.welcome-copy { align-self: flex-start; }.welcome-view h1 { font-size: clamp(3rem, 14vw, 5rem); }.hero-orbit { height: 300px; margin-top: 5px; width: 100%; }.hero-core { height: 100px; width: 100px; }.hero-core strong { font-size: 26px; }.label-pc { left: 0; top: 16%; }.label-phone { bottom: 12%; right: 0; }.room-lobby { align-items: flex-start; min-height: calc(100vh - 85px); padding-top: 18vh; text-align: left; }.room-lobby > p { max-width: 290px; }.code-panel { padding: 22px 27px; }.code-meta, .qr-placeholder { justify-content: flex-start; }.connected-view { padding-top: 8vh; }.scene-header { align-items: flex-start; flex-direction: column; gap: 22px; }.scene-header h1 { font-size: 3rem; }.room-scene { height: 430px; margin-top: 28px; }.device-computer { left: 5%; transform: scale(.78); transform-origin: bottom left; }.device-phone { right: 3%; transform: scale(.78); transform-origin: bottom right; }.portal { top: 26%; }.transfer-dock { padding: 18px 15px; }.dock-top { align-items: flex-start; flex-direction: column; gap: 12px; } }

.welcome-view { display: block; height: calc(100svh - 82px); min-height: 540px; overflow: hidden; position: relative; }
.welcome-copy { bottom: 7vh; left: 4vw; position: absolute; z-index: 4; }
.welcome-copy h1 { animation: home-copy-in 1.1s .18s both cubic-bezier(.2,.8,.2,1); font-size: clamp(3.7rem, 7.4vw, 8.4rem); max-width: 780px; }
.welcome-copy .eyebrow { animation: home-copy-in .8s both; }
.welcome-copy .intro { animation: home-copy-in .8s .42s both; font-size: 15px; margin: 27px 0 23px; }
.welcome-actions { animation: home-copy-in .8s .58s both; }
.welcome-copy .microcopy { animation: home-copy-in .8s .72s both; }
.home-atmosphere { inset: 0; overflow: hidden; position: absolute; }
.moon-haze { background: radial-gradient(circle, rgba(214,232,106,.12) 0, rgba(214,232,106,.025) 22%, transparent 61%); height: 90vh; left: 50%; position: absolute; top: 38%; transform: translate(-50%, -50%); width: 90vw; }
.home-stage { height: min(80vh, 790px); left: 50%; position: absolute; top: 43%; transform: translate(-50%, -50%); width: min(76vw, 900px); }
.home-stage::before { background: linear-gradient(110deg, transparent 20%, rgba(231,131,99,.17), transparent 75%); content: ''; filter: blur(30px); height: 35%; left: 12%; position: absolute; top: 33%; transform: rotate(-20deg); width: 78%; }
.stage-ring { border: 1px solid rgba(214,232,106,.3); border-radius: 50%; left: 50%; position: absolute; top: 49%; transform: translate(-50%, -50%); }
.stage-ring-a { animation: orbit-drift 18s linear infinite; height: 48%; width: 76%; }
.stage-ring-b { animation: orbit-drift-reverse 24s linear infinite; border-color: rgba(231,131,99,.24); height: 74%; transform: translate(-50%, -50%) rotate(65deg); width: 46%; }
.stage-ring-a::after, .stage-ring-b::after { background: var(--lime); border-radius: 50%; box-shadow: 0 0 18px 5px rgba(214,232,106,.45); content: ''; height: 7px; position: absolute; right: 9%; top: 9%; width: 7px; }
.stage-ring-b::after { background: var(--coral); left: 5%; right: auto; top: 68%; }
.stage-portal { align-items: center; animation: portal-breathe 3.8s ease-in-out infinite; background: radial-gradient(circle, rgba(214,232,106,.75) 0, rgba(71,87,48,.42) 28%, rgba(16,21,17,.12) 69%); border: 1px solid rgba(214,232,106,.8); border-radius: 50%; box-shadow: 0 0 100px rgba(214,232,106,.2), inset 0 0 35px rgba(214,232,106,.35); display: flex; height: 23%; justify-content: center; left: 50%; position: absolute; top: 49%; transform: translate(-50%, -50%); width: 23%; }
.stage-portal::before { border: 1px solid rgba(244,241,234,.4); border-radius: 50%; content: ''; inset: 10px; position: absolute; }
.stage-portal span { color: #283120; font-size: clamp(22px, 3.5vw, 42px); transform: rotate(-45deg); }
.stage-device { animation: device-float 5s ease-in-out infinite; position: absolute; }
.stage-pc { bottom: 24%; left: 13%; transform: perspective(500px) rotateY(12deg); }
.stage-screen { background: linear-gradient(145deg, #101310, #37452f); border: 5px solid #66735a; box-shadow: 0 0 35px rgba(214,232,106,.1); color: var(--lime); font-size: 10px; height: 116px; letter-spacing: .18em; padding-top: 49px; text-align: center; width: 178px; }
.stage-pc i { background: #66735a; display: block; height: 44px; margin: 0 auto; position: relative; width: 10px; }.stage-pc i::after { background: #66735a; bottom: -5px; content: ''; height: 5px; left: -31px; position: absolute; width: 72px; }
.stage-phone { animation-delay: -2.4s; bottom: 22%; right: 15%; transform: rotate(11deg); }.stage-phone-screen { background: linear-gradient(160deg, #162019, #606d4e); border: 5px solid #899478; border-radius: 14px; box-shadow: 0 0 30px rgba(214,232,106,.12); height: 152px; width: 82px; }
.stage-thread { border-top: 1px solid rgba(214,232,106,.45); position: absolute; transform-origin: left center; }.thread-a { left: 31%; top: 56%; transform: rotate(-15deg); width: 23%; }.thread-b { right: 31%; top: 56%; transform: rotate(17deg); transform-origin: right center; width: 23%; }
.stage-particle { animation: particle-drift 5s ease-in-out infinite; background: var(--coral); border-radius: 50%; box-shadow: 0 0 14px 4px rgba(231,131,99,.35); height: 5px; position: absolute; width: 5px; }.particle-a { left: 29%; top: 29%; }.particle-b { animation-delay: -1.7s; right: 24%; top: 39%; }.particle-c { animation-delay: -3.2s; left: 63%; top: 21%; }
.home-caption { align-items: center; bottom: 8vh; color: #77786e; display: flex; font-size: 10px; gap: 13px; letter-spacing: .12em; position: absolute; right: 4vw; text-transform: uppercase; z-index: 4; }.home-caption span:first-child { color: var(--coral); }.home-caption i { background: var(--coral); height: 1px; width: 45px; }
@keyframes home-copy-in { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: translateY(0); } }
@keyframes orbit-drift { from { transform: translate(-50%, -50%) rotate(0); } to { transform: translate(-50%, -50%) rotate(360deg); } }
@keyframes orbit-drift-reverse { from { transform: translate(-50%, -50%) rotate(65deg); } to { transform: translate(-50%, -50%) rotate(-295deg); } }
@keyframes portal-breathe { 0%, 100% { box-shadow: 0 0 65px rgba(214,232,106,.16), inset 0 0 25px rgba(214,232,106,.25); transform: translate(-50%, -50%) scale(.94); } 50% { box-shadow: 0 0 125px rgba(214,232,106,.38), inset 0 0 50px rgba(214,232,106,.5); transform: translate(-50%, -50%) scale(1.08); } }
@keyframes device-float { 0%, 100% { margin-top: 0; } 50% { margin-top: -16px; } }
@keyframes particle-drift { 0%, 100% { opacity: .25; transform: translate(0, 0); } 50% { opacity: 1; transform: translate(19px, -25px); } }
@media (max-width: 720px) { .welcome-view { height: calc(100svh - 65px); min-height: 600px; }.welcome-copy { bottom: 6vh; left: 0; }.welcome-copy h1 { font-size: clamp(3.3rem, 15vw, 5rem); }.home-stage { height: 59vh; top: 34%; width: 135vw; }.stage-screen { height: 82px; padding-top: 32px; transform: scale(.7); transform-origin: bottom left; width: 128px; }.stage-pc { bottom: 18%; left: 13%; }.stage-pc i { transform: scale(.7); transform-origin: top center; }.stage-phone { bottom: 20%; right: 16%; }.stage-phone-screen { height: 112px; transform: scale(.72); transform-origin: bottom right; width: 61px; }.stage-portal { height: 27%; width: 27%; }.home-caption { bottom: 2vh; right: 0; }.home-caption span:last-child { display: none; }.home-caption i { width: 30px; } }

.space-world { background: #070b12; inset: 0; overflow: hidden; position: absolute; z-index: 0; }
.space-world::after { background: radial-gradient(ellipse at center, transparent 40%, rgba(2,4,8,.7) 100%); content: ''; inset: 0; pointer-events: none; position: absolute; }
.space-world canvas { display: block; height: 100%; width: 100%; }
.welcome-view .welcome-copy { bottom: 10vh; left: 5vw; }.welcome-view .welcome-copy h1 { text-shadow: 0 0 28px rgba(156,231,212,.12); }.welcome-view .welcome-copy .intro { color: #a1b1b0; }
.welcome-view .button-primary { background: rgba(156,231,212,.14); border: 1px solid rgba(156,231,212,.8); box-shadow: 0 0 25px rgba(156,231,212,.12), inset 0 0 20px rgba(156,231,212,.06); color: #c5ffef; text-transform: uppercase; }.welcome-view .button-primary:hover { background: rgba(156,231,212,.25); box-shadow: 0 0 40px rgba(156,231,212,.25); }.welcome-view .button-quiet { color: #8da9a6; text-transform: uppercase; }
.room-lobby { height: calc(100svh - 82px); min-height: 540px; overflow: hidden; position: relative; }.room-lobby .space-world { position: absolute; }.room-lobby .lobby-heading, .room-lobby .code-panel, .room-lobby .lobby-actions, .room-lobby .qr-placeholder { position: relative; z-index: 2; }.room-lobby .lobby-heading { align-self: flex-start; margin-left: 5vw; text-align: left; }.room-lobby .lobby-heading h1 { text-shadow: 0 0 30px rgba(156,231,212,.2); }.room-lobby > p { color: #9bb2ad; }.room-lobby .code-panel { align-self: flex-end; background: rgba(8,14,18,.5); border: 1px solid rgba(156,231,212,.42); box-shadow: 0 0 35px rgba(156,231,212,.09), inset 0 0 24px rgba(156,231,212,.04); margin: -90px 11vw 0 0; padding: 20px 35px 17px; text-align: left; }.room-lobby .code-panel strong { color: #c5ffef; font-family: 'Courier New', monospace; font-size: clamp(2.4rem, 5vw, 4rem); text-shadow: 0 0 18px rgba(156,231,212,.35); }.room-lobby .code-meta { justify-content: flex-start; color: #9ce7d4; }.room-lobby .lobby-actions { align-self: flex-end; margin-right: 11vw; margin-top: 22px; }.room-lobby .qr-placeholder { align-self: flex-end; margin: 30px 11vw 0 0; }.room-lobby .button-primary { background: rgba(214,232,106,.14); border: 1px solid rgba(214,232,106,.7); box-shadow: 0 0 24px rgba(214,232,106,.1); color: var(--lime); text-transform: uppercase; }
@media (max-width: 720px) { .welcome-view .welcome-copy { bottom: 6vh; left: 22px; }.welcome-view .welcome-copy h1 { font-size: clamp(3.1rem, 14vw, 5rem); }.room-lobby { height: calc(100svh - 65px); min-height: 600px; }.room-lobby .lobby-heading { margin: 0 22px; }.room-lobby .lobby-heading h1 { font-size: 3rem; }.room-lobby .code-panel { align-self: flex-start; margin: 28px 22px 0; }.room-lobby .lobby-actions, .room-lobby .qr-placeholder { align-self: flex-start; margin-left: 22px; margin-right: 22px; }.room-lobby .qr-placeholder { margin-top: 24px; } }

.topbar-actions { align-items: center; display: flex; gap: 22px; }
.mode-toggle { align-items: center; background: rgba(244, 241, 234, .06); border: 1px solid var(--line); color: var(--muted); display: flex; font-size: 10px; gap: 8px; letter-spacing: .08em; padding: 9px 12px; text-transform: uppercase; transition: border-color .2s, color .2s, background .2s; }
.mode-toggle:hover, .mode-toggle.active { background: rgba(214, 232, 106, .1); border-color: rgba(214, 232, 106, .6); color: var(--lime); }
.mode-toggle-icon { color: var(--coral); font-size: 14px; }
.mode-toggle.active .mode-toggle-icon { color: var(--lime); }

.simple-mode { background: #f7f8fa; color: #18202b; }
.app-shell:has(.simple-mode) { background: #f7f8fa; color: #18202b; }
.app-shell:has(.simple-mode) .topbar { color: #18202b; }
.app-shell:has(.simple-mode) .brand { color: #18202b; }
.app-shell:has(.simple-mode) .topbar-status { color: #788392; }
.app-shell:has(.simple-mode) .mode-toggle { background: #fff; border-color: #dce2e8; color: #43505f; }
.app-shell:has(.simple-mode) .mode-toggle:hover { background: #eef5ff; border-color: #9db9d9; color: #1e5a9a; }
.app-shell:has(.simple-mode) .mode-toggle-icon { color: #1e5a9a; }
.welcome-view.simple-mode { display: flex; align-items: center; justify-content: center; min-height: calc(100vh - 105px); height: auto; overflow: visible; }
.simple-mode .welcome-copy { bottom: auto; left: auto; max-width: 520px; position: relative; text-align: center; z-index: 1; }
.simple-mode .welcome-copy .eyebrow { color: #5377a0; margin-bottom: 20px; }
.simple-mode .welcome-copy h1 { color: #18202b; font-size: clamp(3rem, 6vw, 5.6rem); text-shadow: none; }
.simple-mode .welcome-copy h1 em { color: #1e5a9a; }
.simple-mode .welcome-copy .intro { color: #667383; margin: 25px auto; max-width: 390px; }
.simple-mode .button-primary { background: #1e5a9a; border: 0; box-shadow: 0 8px 18px rgba(30, 90, 154, .18); color: #fff; text-transform: none; }
.simple-mode .button-primary:hover { background: #164a81; box-shadow: 0 10px 24px rgba(30, 90, 154, .24); }
.simple-mode .button-quiet { color: #526173; text-transform: none; }
.simple-mode .microcopy { color: #84909d; }
.simple-mode .lock-icon { border-color: #9ca9b6; }
.room-lobby.simple-mode { background: #f7f8fa; color: #18202b; }
.room-lobby.simple-mode .lobby-heading { align-self: auto; margin: 0; text-align: center; }
.room-lobby.simple-mode .lobby-heading .eyebrow { color: #5377a0; }
.room-lobby.simple-mode .lobby-heading h1 { color: #18202b; text-shadow: none; }
.room-lobby.simple-mode .lobby-heading h1 em { color: #1e5a9a; }
.room-lobby.simple-mode .lobby-heading > p { color: #667383; margin: 20px 0 28px; }
.room-lobby.simple-mode .code-panel { align-self: auto; background: #fff; border: 1px solid #dce2e8; box-shadow: 0 12px 30px rgba(38, 58, 79, .08); margin: 0; padding: 24px 42px 19px; text-align: center; }
.room-lobby.simple-mode .code-label, .room-lobby.simple-mode .dock-kicker { color: #788392; }
.room-lobby.simple-mode .code-panel strong { color: #1e5a9a; font-family: 'Courier New', monospace; text-shadow: none; }
.room-lobby.simple-mode .code-meta { color: #2d8b5b; justify-content: center; }
.room-lobby.simple-mode .pulse-dot { background: #2d8b5b; }
.room-lobby.simple-mode .lobby-actions { align-self: auto; margin: 26px 0 0; }
.room-lobby.simple-mode .button-primary { background: #1e5a9a; border: 0; color: #fff; }
.room-lobby.simple-mode .qr-placeholder { align-self: auto; color: #667383; margin: 34px 0 0; }
.room-lobby.simple-mode .qr-grid { background: repeating-linear-gradient(90deg, #526173 0 3px, transparent 3px 6px), repeating-linear-gradient(0deg, #526173 0 3px, transparent 3px 6px); border-color: #526173; }
.connected-view.simple-mode { background: #f7f8fa; color: #18202b; padding-top: 7vh; }
.simple-mode .scene-header h1 { color: #18202b; }
.simple-mode .scene-header h1 em { color: #1e5a9a; }
.simple-mode .exit-button { border-color: #dce2e8; color: #526173; }
.simple-mode .room-scene { background: #fff; border-color: #dce2e8; box-shadow: 0 14px 35px rgba(38, 58, 79, .08); height: 220px; }
.simple-room-content { align-items: center; display: flex; height: 100%; justify-content: center; gap: clamp(20px, 8vw, 110px); }
.simple-device { align-items: center; display: flex; flex-direction: column; gap: 6px; min-width: 120px; }
.simple-device-icon { align-items: center; border: 2px solid #1e5a9a; color: #1e5a9a; display: flex; font-size: 27px; height: 58px; justify-content: center; width: 76px; }
.simple-device:nth-child(3) .simple-device-icon { border-radius: 12px; width: 42px; }
.simple-device strong { color: #253446; font-size: 13px; font-weight: 600; }.simple-device small { color: #788392; font-size: 10px; }.simple-connection { align-items: center; color: #2d8b5b; display: flex; flex-direction: column; font-size: 11px; gap: 10px; text-transform: uppercase; }.simple-connection span { background: #2d8b5b; height: 1px; opacity: .5; width: 65px; }
.simple-mode .transfer-dock { background: #fff; border-color: #dce2e8; box-shadow: 0 14px 35px rgba(38, 58, 79, .08); }
.simple-mode .dock-kicker { color: #526173; }.simple-mode .direction-switch { border-color: #dce2e8; }.simple-mode .direction-switch button { color: #788392; }.simple-mode .direction-switch button.active { background: #e9f1fa; color: #1e5a9a; }.simple-mode .drop-zone { border-color: #b8c5d2; }.simple-mode .drop-zone:hover, .simple-mode .drop-zone.has-file { background: #f4f8fc; border-color: #1e5a9a; }.simple-mode .drop-zone strong { color: #253446; }.simple-mode .drop-zone small { color: #788392; }.simple-mode .upload-mark { border-color: #1e5a9a; color: #1e5a9a; }.simple-mode .transfer-button { background: #1e5a9a; color: #fff; }.simple-mode .transfer-button:disabled { background: #9aa9b8; }
@media (max-width: 720px) { .topbar-actions { gap: 10px; }.topbar-status { display: none; }.mode-toggle { padding: 8px 9px; }.mode-toggle-icon { font-size: 12px; }.simple-mode .welcome-copy { left: auto; }.simple-mode .welcome-actions { justify-content: center; }.simple-mode .simple-room-content { gap: 8px; }.simple-device { min-width: 88px; }.simple-connection span { width: 25px; }.simple-device-icon { height: 48px; width: 62px; }.connected-view.simple-mode { padding-top: 8vh; }.simple-mode .scene-header h1 { font-size: 3rem; } }
</style>
