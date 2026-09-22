/**
 * scene.ts — the immersive 3D world.
 *
 * One continuous scene, not two. Deep space sits at z≈0 with the portal core at its
 * centre; the physical room sits behind the portal at z≈-26. Entering the room is a
 * real camera flight through the portal rather than a cut between scenes, which is
 * what makes the portal read as a passage instead of a picture.
 *
 * The scene READS application state and never owns transfer logic. `update()` is the
 * only way state reaches it.
 */
import * as THREE from 'three'

export type SceneState =
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

export type Quality = 'high' | 'balanced' | 'reduced'

export interface SceneInput {
  state: SceneState
  quality: Quality
  reduceMotion: boolean
  /** 0..1 while a file moves, -1 when idle. */
  transferProgress: number
  transferDirection: 'send' | 'receive'
}

const LIME = 0xb7f34a
const CORAL = 0xff6b5e
const DEEP = 0x0b0f12

/** Where the room lives, far behind the portal plane. */
const ROOM_Z = -26
/** States in which the camera has already passed through the portal. */
const INSIDE: SceneState[] = [
  'inside-room',
  'selecting-file',
  'file-ready',
  'transferring',
  'completed',
]

function particleTexture() {
  // A soft round sprite. Without it, PointsMaterial renders hard squares.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.5)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

export class PyDropScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private frame = 0
  private resizeObserver: ResizeObserver
  private sprite = particleTexture()

  private core = new THREE.Group()
  private coreLoops: THREE.Mesh[] = []
  private passage!: THREE.Mesh
  private stars!: THREE.Points
  private dust!: THREE.Points
  private remoteDot!: THREE.Mesh
  private room = new THREE.Group()
  private payload!: THREE.Mesh
  private coreLight!: THREE.PointLight

  private pointer = new THREE.Vector2()
  private pointerTarget = new THREE.Vector2()
  private raycaster = new THREE.Raycaster()
  private startedAt = performance.now()
  /** 0 = in space, 1 = fully inside the room. Drives the whole traversal. */
  private traversal = 0
  private hovered = false

  private input: SceneInput = {
    state: 'initial',
    quality: 'balanced',
    reduceMotion: false,
    transferProgress: -1,
    transferDirection: 'send',
  }

  constructor(
    private readonly mount: HTMLElement,
    private readonly onCoreActivate: () => void,
    private readonly onHoverChange: (hovered: boolean) => void,
  ) {
    const { clientWidth: w, clientHeight: h } = mount
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.input.quality !== 'reduced',
      alpha: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setSize(w, h)
    this.renderer.setPixelRatio(this.pixelRatio())
    mount.appendChild(this.renderer.domElement)

    this.scene.fog = new THREE.FogExp2(DEEP, 0.022)
    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 140)
    this.camera.position.set(0, 0.2, 8)

    this.buildSpace()
    this.buildRoom()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(mount)
    mount.addEventListener('pointermove', this.handlePointerMove)
    mount.addEventListener('pointerleave', this.handlePointerLeave)
    mount.addEventListener('pointerdown', this.handlePointerDown)
    this.frame = requestAnimationFrame(this.tick)
  }

  private pixelRatio() {
    const cap = this.input.quality === 'high' ? 2 : this.input.quality === 'balanced' ? 1.5 : 1
    return Math.min(window.devicePixelRatio, cap)
  }

  private starCount() {
    return this.input.quality === 'high' ? 1400 : this.input.quality === 'balanced' ? 800 : 320
  }

  // ---------------------------------------------------------------- deep space

  private buildSpace() {
    this.scene.add(new THREE.AmbientLight(0x9aa6a8, 0.4))

    this.coreLight = new THREE.PointLight(LIME, 6, 18)
    this.coreLight.position.set(0, 0.1, 1.4)
    this.scene.add(this.coreLight)

    const destinationLight = new THREE.PointLight(CORAL, 2.8, 14)
    destinationLight.position.set(3, -0.5, -4)
    this.scene.add(destinationLight)

    // Stars at several depths so parallax has something to act on.
    const count = this.starCount()
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      const radius = 4 + Math.random() * 26
      const angle = Math.random() * Math.PI * 2
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = (Math.random() - 0.5) * 16
      positions[i * 3 + 2] = 4 - Math.random() * 34
      const warm = Math.random() > 0.85
      colors[i * 3] = warm ? 1 : 0.7
      colors[i * 3 + 1] = warm ? 0.45 : 0.94
      colors[i * 3 + 2] = warm ? 0.38 : 0.62
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.stars = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.06,
        map: this.sprite,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    )
    this.scene.add(this.stars)

    // Dust that converges on the core while the room is being created.
    const dustCount = this.input.quality === 'reduced' ? 90 : 220
    const dustPositions = new Float32Array(dustCount * 3)
    for (let i = 0; i < dustCount; i += 1) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 4.2
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 2.6
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 2.6
    }
    const dustGeometry = new THREE.BufferGeometry()
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    this.dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({
        color: LIME,
        size: 0.05,
        map: this.sprite,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    )
    this.scene.add(this.dust)

    // The core: two interlocked rings around a central passage — the symbol in 3D.
    const limeMaterial = new THREE.MeshStandardMaterial({
      color: LIME,
      emissive: 0x4a6b1c,
      emissiveIntensity: 1.6,
      roughness: 0.26,
      metalness: 0.4,
    })
    const coralMaterial = new THREE.MeshStandardMaterial({
      color: CORAL,
      emissive: 0x5b241f,
      emissiveIntensity: 1.1,
      roughness: 0.32,
      metalness: 0.3,
    })
    const segments = this.input.quality === 'reduced' ? 36 : 72
    const left = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.07, 16, segments), limeMaterial)
    const right = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.07, 16, segments), coralMaterial)
    left.position.x = -0.34
    right.position.x = 0.34
    left.rotation.y = 0.5
    right.rotation.y = -0.5
    this.coreLoops = [left, right]

    // The passage the camera will eventually fly through.
    this.passage = new THREE.Mesh(
      new THREE.CircleGeometry(0.52, 48),
      new THREE.MeshBasicMaterial({
        color: DEEP,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    )
    this.passage.position.z = -0.1

    this.core.add(left, right, this.passage)
    this.scene.add(this.core)

    // The other device, arriving from far away.
    this.remoteDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 20, 20),
      new THREE.MeshBasicMaterial({ color: CORAL }),
    )
    this.remoteDot.position.set(4.6, -0.7, -6)
    this.remoteDot.visible = false
    this.scene.add(this.remoteDot)
  }

  // ------------------------------------------------------------- physical room

  private surface(color: number, roughness = 0.75) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.06 })
  }

  private box(
    parent: THREE.Object3D,
    size: [number, number, number],
    position: [number, number, number],
    color: number,
  ) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), this.surface(color))
    mesh.position.set(...position)
    parent.add(mesh)
    return mesh
  }

  private buildRoom() {
    this.room.position.z = ROOM_Z
    // Hidden until the traversal starts, so the room is a reveal rather than
    // scenery visible through the portal from the first frame.
    this.room.visible = false
    this.scene.add(this.room)

    // Shell: floor, back wall, two side walls at different values so corners read.
    this.box(this.room, [13, 0.18, 10], [0, -1.6, 0], 0x1a2328)
    this.box(this.room, [13, 5.6, 0.18], [0, 1.1, -4.2], 0x12181c)
    this.box(this.room, [0.18, 5.6, 10], [-6.4, 1.1, 0], 0x151d21)
    this.box(this.room, [0.18, 5.6, 10], [6.4, 1.1, 0], 0x101518)

    // Window: the room's only cool light source, so the lamp reads warm against it.
    const window = this.box(this.room, [2.8, 1.9, 0.06], [-3.6, 1.5, -4.1], 0x24323a)
    ;(window.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x1d2b33)
    ;(window.material as THREE.MeshStandardMaterial).emissiveIntensity = 1

    this.room.add(new THREE.AmbientLight(0x9aa6a8, 0.5))
    const windowLight = new THREE.DirectionalLight(0xc8dce6, 1.1)
    windowLight.position.set(-4, 3, -2)
    this.room.add(windowLight)

    // Desk.
    const desk = new THREE.Group()
    desk.position.set(-2.4, 0, 0.6)
    this.box(desk, [3.6, 0.16, 1.4], [0, -0.1, 0], 0x273238)
    ;[-1.6, 1.6].forEach((x) => this.box(desk, [0.12, 1.4, 0.12], [x, -0.82, 0], 0x1a2328))
    this.room.add(desk)

    // Laptop — this device, so its screen glows lime.
    const laptop = new THREE.Group()
    laptop.position.set(-2.4, 0, 0.5)
    this.box(laptop, [1.7, 1.05, 0.08], [0, 0.52, -0.3], 0x0b0f12)
    const laptopScreen = this.box(laptop, [1.45, 0.84, 0.02], [0, 0.52, -0.25], 0x1e2f14)
    ;(laptopScreen.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(LIME)
    ;(laptopScreen.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.32
    this.box(laptop, [1.7, 0.05, 1.1], [0, 0, 0.25], 0x9aa6a8)
    this.room.add(laptop)

    // Phone — the other device, so its screen glows coral.
    const phone = new THREE.Group()
    phone.position.set(2.6, 0.1, 0.7)
    phone.rotation.z = -0.1
    phone.rotation.x = -0.35
    this.box(phone, [0.66, 1.34, 0.08], [0, 0, 0], 0x0b0f12)
    const phoneScreen = this.box(phone, [0.55, 1.2, 0.02], [0, 0, 0.05], 0x3a211f)
    ;(phoneScreen.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(CORAL)
    ;(phoneScreen.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.3
    this.room.add(phone)

    // Lamp, and the warm pool of light that makes the room feel occupied.
    const lamp = new THREE.Group()
    lamp.position.set(4.3, 0, -1.4)
    this.box(lamp, [0.5, 0.06, 0.5], [0, -1.45, 0], 0x273238)
    this.box(lamp, [0.07, 2.4, 0.07], [0, -0.3, 0], 0x273238)
    this.box(lamp, [0.8, 0.5, 0.8], [0, 1.05, 0], 0x2d1a17)
    const lampLight = new THREE.PointLight(0xffb27a, 4.5, 9)
    lampLight.position.set(0, 0.7, 0)
    lamp.add(lampLight)
    this.room.add(lamp)

    // The portal, now standing inside the room between the two devices.
    const portal = new THREE.Group()
    portal.position.set(0, 0.4, -1.2)
    const ringLime = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.05, 14, 56),
      new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.8 }),
    )
    const ringCoral = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.05, 14, 56),
      new THREE.MeshBasicMaterial({ color: CORAL, transparent: true, opacity: 0.66 }),
    )
    ringLime.position.x = -0.3
    ringCoral.position.x = 0.3
    ringLime.rotation.y = 0.42
    ringCoral.rotation.y = -0.42
    portal.add(ringLime, ringCoral)
    this.room.add(portal)
    this.roomPortal = portal

    // The file, as a physical object that crosses the room during a transfer.
    this.payload = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.45, 0.03),
      new THREE.MeshBasicMaterial({ color: 0xf4f7f2, transparent: true, opacity: 0.92 }),
    )
    this.payload.visible = false
    this.room.add(this.payload)
  }

  private roomPortal!: THREE.Group

  // ------------------------------------------------------------------ interaction

  private handlePointerMove = (event: PointerEvent) => {
    const rect = this.mount.getBoundingClientRect()
    this.pointerTarget.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointerTarget.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)

    // Only the core is interactive, and only while we are still in space.
    if (this.traversal > 0.02) return
    this.raycaster.setFromCamera(this.pointerTarget, this.camera)
    const hit = this.raycaster.intersectObjects(this.coreLoops, false).length > 0
    if (hit !== this.hovered) {
      this.hovered = hit
      this.onHoverChange(hit)
    }
  }

  private handlePointerLeave = () => {
    this.pointerTarget.set(0, 0)
    if (this.hovered) {
      this.hovered = false
      this.onHoverChange(false)
    }
  }

  private handlePointerDown = () => {
    if (this.hovered && this.input.state === 'initial') this.onCoreActivate()
  }

  // ----------------------------------------------------------------- frame loop

  private tick = (time: number) => {
    const elapsed = (time - this.startedAt) * 0.001
    const motion = !this.input.reduceMotion
    const state = this.input.state
    const wantsInside = INSIDE.includes(state)
    const traversing = state === 'entering-room'

    // Traversal drives everything about where the camera is.
    const target = wantsInside ? 1 : traversing ? 1 : 0
    const speed = this.input.reduceMotion ? 1 : traversing ? 0.012 : 0.05
    this.traversal += (target - this.traversal) * speed
    if (this.input.reduceMotion) this.traversal = target
    // Exponential approach never quite reaches its target, so snap the last
    // sliver; otherwise the camera creeps forever and hasArrived stays false.
    if (Math.abs(target - this.traversal) < 0.004) this.traversal = target

    // Exponential ease-out: fast departure, gentle arrival.
    const eased = 1 - Math.pow(1 - Math.min(this.traversal, 1), 3)

    this.pointer.x += (this.pointerTarget.x - this.pointer.x) * 0.04
    this.pointer.y += (this.pointerTarget.y - this.pointer.y) * 0.04

    // Camera flies from deep space, through the passage, into the room.
    const spaceZ = 8 + (state === 'creating-room' ? -0.6 : 0)
    const insideZ = ROOM_Z + 7.4
    this.camera.position.z = THREE.MathUtils.lerp(spaceZ, insideZ, eased)
    const parallax = motion ? 1 : 0
    this.camera.position.x =
      this.pointer.x * 0.36 * parallax * (1 - eased * 0.6) +
      (motion ? Math.sin(elapsed * 0.16) * 0.07 * (1 - eased) : 0)
    this.camera.position.y =
      THREE.MathUtils.lerp(0.2, 1.0, eased) +
      this.pointer.y * 0.16 * parallax * (1 - eased * 0.6) +
      (motion ? Math.cos(elapsed * 0.2) * 0.04 * (1 - eased) : 0)
    this.camera.lookAt(0, THREE.MathUtils.lerp(0.05, 0.3 + ROOM_Z * 0, eased), ROOM_Z + 2)

    // Core: hover and activity make it brighter and tighter.
    const active = this.hovered || state !== 'initial'
    const coreScale = (active ? 1.1 : 1) + (motion ? Math.sin(elapsed * 2.1) * 0.03 : 0)
    this.core.scale.setScalar(coreScale)
    if (motion) {
      this.core.rotation.y = elapsed * 0.2
      this.core.rotation.x = Math.sin(elapsed * 0.4) * 0.1
    }
    // The core dissolves as we pass through it, so it never clips the camera.
    const coreFade = 1 - Math.min(1, eased * 1.6)
    this.coreLoops.forEach((loop) => {
      const material = loop.material as THREE.MeshStandardMaterial
      material.transparent = true
      material.opacity = coreFade
    })
    ;(this.passage.material as THREE.MeshBasicMaterial).opacity = 0.85 * coreFade
    this.core.visible = coreFade > 0.01
    this.coreLight.intensity = (this.hovered ? 9 : 6) * coreFade

    // Room creation: dust converges, then settles.
    if (motion) {
      this.dust.rotation.z = elapsed * (state === 'creating-room' ? 0.34 : 0.07)
      const converge = state === 'creating-room' ? 0.68 + Math.sin(elapsed * 4) * 0.07 : 1
      this.dust.scale.setScalar(converge)
      this.stars.rotation.y = elapsed * 0.005
    }
    ;(this.dust.material as THREE.PointsMaterial).opacity = 0.55 * (1 - eased)
    ;(this.stars.material as THREE.PointsMaterial).opacity = 0.9 * (1 - eased * 0.85)

    // The other device approaches once it joins.
    const linked = state === 'connected' || wantsInside || traversing
    this.remoteDot.visible = (linked || state === 'waiting') && coreFade > 0.01
    const dotX = linked ? 1.7 : 4.6
    const dotZ = linked ? -2.1 : -6
    this.remoteDot.position.x += (dotX - this.remoteDot.position.x) * 0.03
    this.remoteDot.position.z += (dotZ - this.remoteDot.position.z) * 0.03
    this.remoteDot.scale.setScalar(linked ? 1.5 : 1)

    // The room only exists once we are on our way into it.
    this.room.visible = this.traversal > 0.001

    // Inside the room: the portal breathes and the file physically crosses it.
    if (motion) this.roomPortal.rotation.z = elapsed * 0.16
    const progress = this.input.transferProgress
    const moving = progress >= 0
    this.payload.visible = moving || state === 'file-ready' || state === 'completed'
    if (this.payload.visible) {
      const t = state === 'completed' ? 1 : moving ? Math.min(Math.max(progress, 0), 1) : 0
      // Receiving reverses the journey: the file arrives from the other device.
      const travel = this.input.transferDirection === 'receive' ? 1 - t : t
      this.payload.position.set(
        THREE.MathUtils.lerp(-2.4, 2.6, travel),
        0.4 + Math.sin(travel * Math.PI) * 0.8,
        THREE.MathUtils.lerp(0.5, 0.7, travel),
      )
      if (motion) this.payload.rotation.y += 0.03
    }

    this.renderer.render(this.scene, this.camera)
    this.frame = requestAnimationFrame(this.tick)
  }

  // --------------------------------------------------------------------- public

  update(input: Partial<SceneInput>) {
    const previousQuality = this.input.quality
    this.input = { ...this.input, ...input }
    if (this.input.quality !== previousQuality) this.renderer.setPixelRatio(this.pixelRatio())
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.mount
    if (!w || !h) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.mount.removeEventListener('pointermove', this.handlePointerMove)
    this.mount.removeEventListener('pointerleave', this.handlePointerLeave)
    this.mount.removeEventListener('pointerdown', this.handlePointerDown)
    this.scene.traverse((child) => {
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      const list = Array.isArray(material) ? material : material ? [material] : []
      list.forEach((m) => m.dispose())
    })
    this.sprite.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
