<script setup lang="ts">
/**
 * The connection between this device (lime) and the other one (coral).
 *
 * Drawn on a canvas rather than in the DOM: one rAF loop and one compositor
 * layer covers the link, the travelling signals and the pointer response,
 * where the equivalent in DOM would be dozens of independently animated nodes.
 *
 * The loop is not free, so it only runs when it has something to say — it
 * parks itself when the tab is hidden, when the element scrolls out of view,
 * and (in the settled 'linked' state) once the link has finished forming.
 *
 * Phases tell the story the connection actually follows:
 *   idle       nothing yet — this device alone, listening
 *   searching  reaching out; the link gropes toward where the other device will be
 *   linking    found it; the two ends pull together and the channel forms
 *   linked     established; a steady pulse keeps time
 * plus `flow`, which rides a payload along the finished link.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PortalMark from './PortalMark.vue'

const props = withDefaults(
  defineProps<{
    localLabel: string
    remoteLabel: string
    phase: 'idle' | 'searching' | 'linking' | 'linked'
    /** 0..1 while a file is moving; -1 when nothing is in flight. */
    flow?: number
    flowDirection?: 'send' | 'receive'
  }>(),
  { flow: -1, flowDirection: 'send' },
)

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const W = 400
const H = 170
const LOCAL = { x: 58, y: 120 }
const REMOTE = { x: 342, y: 52 }

const LIME = '183, 243, 74'
const CORAL = '255, 107, 94'
const WHITE = '244, 247, 242'

let ctx: CanvasRenderingContext2D | null = null
let frame = 0
let observer: IntersectionObserver | null = null
let visible = true
let reduce = false
let startedAt = 0
/** 0 → 1 as the link forms. Drives every "is it connected yet" visual. */
let formed = 0
/** Smoothed pointer offset in canvas units; the parallax and bend read from it. */
const pointer = { x: 0, y: 0, tx: 0, ty: 0 }

interface Signal {
  /** Position along the link, 0 at this device, 1 at the other. */
  t: number
  speed: number
  size: number
  /** Perpendicular offset so signals do not ride in single file. */
  spread: number
}
let signals: Signal[] = []

function seedSignals(count: number) {
  signals = Array.from({ length: count }, () => ({
    t: Math.random(),
    speed: 0.13 + Math.random() * 0.12,
    size: 1 + Math.random() * 1.2,
    spread: (Math.random() - 0.5) * 7,
  }))
}

/** The link bows toward the pointer, so the channel feels physical. */
function linkPoint(t: number) {
  const baseX = LOCAL.x + (REMOTE.x - LOCAL.x) * t
  const baseY = LOCAL.y + (REMOTE.y - LOCAL.y) * t
  // Bend peaks mid-link and vanishes at both anchored ends.
  const bend = Math.sin(t * Math.PI)
  return {
    x: baseX + pointer.x * 0.5 * bend,
    y: baseY + pointer.y * 0.5 * bend,
  }
}

function draw(now: number) {
  const c = ctx
  if (!c) return
  const elapsed = (now - startedAt) * 0.001
  const phase = props.phase
  const active = phase === 'linked' || phase === 'linking'

  // Ease toward the target rather than snapping: every phase change is continuous.
  const target = phase === 'linked' ? 1 : phase === 'linking' ? 0.55 : phase === 'searching' ? 0.25 : 0
  formed += (target - formed) * (reduce ? 1 : 0.055)

  pointer.x += (pointer.tx - pointer.x) * 0.06
  pointer.y += (pointer.ty - pointer.y) * 0.06

  c.clearRect(0, 0, W, H)

  // ---- the link itself -------------------------------------------------
  // Searching draws a dashed, probing line; a formed link is solid.
  const steps = 48
  c.beginPath()
  for (let i = 0; i <= steps; i += 1) {
    const p = linkPoint(i / steps)
    if (i === 0) c.moveTo(p.x, p.y)
    else c.lineTo(p.x, p.y)
  }
  const gradient = c.createLinearGradient(LOCAL.x, LOCAL.y, REMOTE.x, REMOTE.y)
  gradient.addColorStop(0, `rgba(${LIME}, ${0.15 + formed * 0.75})`)
  gradient.addColorStop(1, `rgba(${CORAL}, ${0.12 + formed * 0.6})`)
  c.strokeStyle = gradient
  c.lineWidth = 1 + formed * 0.5
  if (formed < 0.9) {
    // The dashes crawl outward while searching: the link is looking for the far end.
    c.setLineDash([3, 8])
    c.lineDashOffset = reduce ? 0 : -elapsed * 26
  } else {
    c.setLineDash([])
  }
  c.stroke()
  c.setLineDash([])

  // ---- signals riding the link ----------------------------------------
  if (!reduce && phase !== 'idle') {
    for (const s of signals) {
      s.t += s.speed * 0.016
      if (s.t > 1) s.t -= 1
      // Before the link forms, signals fade out partway: they are not arriving yet.
      const reach = 0.3 + formed * 0.7
      if (s.t > reach) continue
      const p = linkPoint(s.t)
      // Fade in and out at the ends so nothing pops.
      const edge = Math.min(1, Math.min(s.t, reach - s.t) * 8)
      const alpha = edge * (0.3 + formed * 0.55)
      // Signals lean lime near the origin and coral as they approach the far end.
      const tint = s.t < 0.5 ? LIME : CORAL
      c.fillStyle = `rgba(${tint}, ${alpha})`
      c.beginPath()
      c.arc(p.x, p.y + s.spread * (1 - formed * 0.6), s.size, 0, Math.PI * 2)
      c.fill()
    }
  }

  // ---- the payload, while a file is moving -----------------------------
  const flow = props.flow ?? -1
  if (flow >= 0) {
    const t = props.flowDirection === 'receive' ? 1 - flow : flow
    const p = linkPoint(Math.min(Math.max(t, 0), 1))
    c.fillStyle = `rgba(${WHITE}, 0.95)`
    c.beginPath()
    c.roundRect(p.x - 5, p.y - 6.5, 10, 13, 2)
    c.fill()
    // A soft wake so the packet reads as moving, not placed.
    c.fillStyle = `rgba(${WHITE}, 0.16)`
    c.beginPath()
    c.arc(p.x, p.y, 11, 0, Math.PI * 2)
    c.fill()
  }

  // ---- the two devices -------------------------------------------------
  drawNode(c, LOCAL, LIME, 1, elapsed, true)
  drawNode(c, REMOTE, CORAL, formed, elapsed, active)

  frame = requestAnimationFrame(draw)
}

function drawNode(
  c: CanvasRenderingContext2D,
  at: { x: number; y: number },
  tint: string,
  presence: number,
  elapsed: number,
  solid: boolean,
) {
  // Parallax: nodes drift slightly against the pointer, which reads as depth.
  const x = at.x + pointer.x * (at === LOCAL ? 0.22 : 0.34)
  const y = at.y + pointer.y * (at === LOCAL ? 0.22 : 0.34)

  // A slow breathing ring while waiting; it settles once the link is up.
  if (!reduce) {
    const pulse = (elapsed * 0.7) % 1
    const waiting = 1 - presence
    if (waiting > 0.02) {
      c.strokeStyle = `rgba(${tint}, ${(1 - pulse) * 0.3 * waiting})`
      c.lineWidth = 1
      c.beginPath()
      c.arc(x, y, 7 + pulse * 22, 0, Math.PI * 2)
      c.stroke()
    }
  }

  // Glow, then core. Presence fades the remote device in as it is discovered.
  const glow = c.createRadialGradient(x, y, 0, x, y, 16)
  glow.addColorStop(0, `rgba(${tint}, ${0.42 * presence})`)
  glow.addColorStop(1, `rgba(${tint}, 0)`)
  c.fillStyle = glow
  c.beginPath()
  c.arc(x, y, 16, 0, Math.PI * 2)
  c.fill()

  if (solid && presence > 0.35) {
    c.fillStyle = `rgba(${tint}, ${presence})`
    c.beginPath()
    c.arc(x, y, 5.5, 0, Math.PI * 2)
    c.fill()
  } else {
    // Not here yet: an outline, waiting to be filled.
    c.strokeStyle = `rgba(${tint}, ${0.3 + presence * 0.5})`
    c.lineWidth = 1.2
    c.setLineDash([2, 3])
    c.beginPath()
    c.arc(x, y, 5.5, 0, Math.PI * 2)
    c.stroke()
    c.setLineDash([])
  }
}

// ---------------------------------------------------------------- pointer

function onPointerMove(event: PointerEvent) {
  const el = host.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // Normalised to -1..1, then scaled into canvas units.
  pointer.tx = (((event.clientX - rect.left) / rect.width) * 2 - 1) * 14
  pointer.ty = (((event.clientY - rect.top) / rect.height) * 2 - 1) * 10
}

function onPointerLeave() {
  pointer.tx = 0
  pointer.ty = 0
}

// ------------------------------------------------------------- lifecycle

function resize() {
  const el = canvas.value
  if (!el || !ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  el.width = W * dpr
  el.height = H * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function start() {
  if (frame || !visible || document.hidden) return
  startedAt = performance.now() - 1
  frame = requestAnimationFrame(draw)
}

function stop() {
  cancelAnimationFrame(frame)
  frame = 0
}

function onVisibility() {
  if (document.hidden) stop()
  else start()
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  ctx = el.getContext('2d')
  reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  resize()
  // Fewer signals on phones: this loop shares the device with a live transfer.
  const small = window.matchMedia('(max-width: 860px)').matches
  seedSignals(reduce ? 0 : small ? 5 : 9)

  // Park the loop when the field is off screen; nobody is watching it there.
  observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible) start()
      else stop()
    },
    { threshold: 0.01 },
  )
  if (host.value) observer.observe(host.value)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', resize)
  start()
})

onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('resize', resize)
})

// A phase change always deserves a frame, even if the loop had settled.
watch(() => props.phase, start)
</script>

<template>
  <div
    ref="host"
    class="field"
    :class="[`phase-${phase}`]"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <canvas ref="canvas" :width="W" :height="H" aria-hidden="true"></canvas>

    <!-- Labels stay real DOM: they carry the meaning and must be selectable. -->
    <p class="tag tag-local tabular">{{ localLabel }}</p>
    <p class="tag tag-remote tabular" :class="{ absent: phase !== 'linked' }">
      {{ remoteLabel }}
    </p>

    <div class="portal" :class="{ live: phase === 'linked' }">
      <PortalMark :size="44" :muted="phase === 'idle'" />
    </div>
  </div>
</template>

<style scoped>
.field {
  position: relative;
  width: 100%;
  aspect-ratio: 400 / 170;
  min-height: 190px;
  /* The pointer parallax is a desktop-hover affordance (gated by @media
     hover below); on touch it has no purpose, and left unset it can compete
     with the page's own scroll gesture and cause a momentary jump. */
  touch-action: pan-y;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.tag {
  position: absolute;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--muted-gray);
  white-space: nowrap;
  transition: color 400ms var(--ease-out), opacity 400ms var(--ease-out);
}

.tag-local {
  left: 4%;
  top: 78%;
}

.tag-remote {
  right: 3%;
  top: 20%;
}

.tag-remote.absent {
  opacity: 0.55;
}

.portal {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.94);
  opacity: 0.5;
  transition: opacity 600ms var(--ease-out), transform 600ms var(--ease-out);
}

/* The mark settles into full presence only once the channel is up. */
.portal.live {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

@media (max-width: 860px) {
  .field {
    aspect-ratio: 400 / 140;
    min-height: 0;
  }

  .tag {
    font-size: 10px;
  }
}
</style>
