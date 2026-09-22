<script setup lang="ts">
/**
 * The room QR, drawn by hand rather than by QRCode.toCanvas.
 *
 * Two reasons to own the drawing:
 *   1. The centre is cleared for the PyDrop mark. Error correction level H
 *      tolerates ~30% loss; the cleared patch is ~11% of the symbol, so the code
 *      stays comfortably scannable.
 *   2. The modules animate in, which QRCode.toCanvas cannot do.
 *
 * The modules themselves stay near-black on white. Colouring them was tried and
 * measurably broke scanning: brand lime reads at luminance ~162 against white,
 * and a scanner locking onto the finder patterns rejects it. The brand lives in
 * the frame and the centre mark, where only the eye is judging.
 *
 * Modules paint in a short radial stagger from the centre outward, so the code
 * assembles rather than appearing. It runs once per room, which is exactly the
 * frequency that earns an entrance.
 */
import { onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import PortalMark from './PortalMark.vue'

const props = defineProps<{ value: string; label: string }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const revealed = ref(false)
const SIZE = 184
const QUIET = 2

let animation = 0

function draw(progress: number) {
  const el = canvas.value
  if (!el || !props.value) return
  const qr = QRCode.create(props.value, { errorCorrectionLevel: 'H' })
  const count = qr.modules.size
  const data = qr.modules.data
  const dpr = Math.min(window.devicePixelRatio || 1, 3)

  el.width = SIZE * dpr
  el.height = SIZE * dpr
  const ctx = el.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, SIZE, SIZE)

  const cell = SIZE / (count + QUIET * 2)
  const origin = cell * QUIET
  const mid = (count - 1) / 2
  // Radius the stagger sweeps out from the centre.
  const maxDist = Math.hypot(mid, mid)
  // Modules inside this radius are cleared for the logo.
  const clear = count * 0.115

  // The plate's own white, painted in: a transparent canvas and gaps between
  // modules both cost scanners contrast, and scannability outranks styling here.
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, SIZE, SIZE)

  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (!data[y * count + x]) continue
      const dx = x - mid
      const dy = y - mid
      if (Math.abs(dx) <= clear && Math.abs(dy) <= clear) continue

      // Each module has its own threshold, so the code grows outward.
      const dist = Math.hypot(dx, dy) / maxDist
      const local = (progress - dist * 0.55) / 0.45
      if (local <= 0) continue
      const t = Math.min(1, local)

      // Every module stays near-black. Scanners lock onto the finder patterns
      // by luminance, and brand lime measures ~162 against white — light enough
      // to break decoding outright. The brand lives in the frame and the centre
      // mark instead, where contrast is nobody's business but the eye's.
      ctx.fillStyle = '#0B0F12'
      ctx.globalAlpha = t
      // Snap each module to whole device pixels. Fractional cell widths leave
      // pale seams between modules, and at DPR 2 those seams cost enough
      // contrast to break decoding outright.
      const px = Math.round((origin + x * cell) * dpr) / dpr
      const py = Math.round((origin + y * cell) * dpr) / dpr
      const right = Math.round((origin + (x + 1) * cell) * dpr) / dpr
      const bottom = Math.round((origin + (y + 1) * cell) * dpr) / dpr
      ctx.fillRect(px, py, right - px, bottom - py)
    }
  }
  ctx.globalAlpha = 1
}

function animate() {
  cancelAnimationFrame(animation)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    draw(1)
    revealed.value = true
    return
  }
  const start = performance.now()
  const duration = 620
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration)
    // Strong ease-out: the code lands fast, then settles.
    draw(1 - Math.pow(1 - t, 3))
    if (t < 1) animation = requestAnimationFrame(step)
    else revealed.value = true
  }
  animation = requestAnimationFrame(step)
}

watch(() => props.value, () => { revealed.value = false; animate() })
onMounted(animate)
</script>

<template>
  <figure class="qr">
    <div class="plate" :class="{ revealed }">
      <canvas ref="canvas" :width="SIZE" :height="SIZE" role="img" :aria-label="label"></canvas>
      <!-- The mark sits in the cleared centre, on the plate's own white. -->
      <span class="badge" aria-hidden="true">
        <PortalMark :size="34" />
      </span>
    </div>
    <figcaption>{{ label }}</figcaption>
  </figure>
</template>

<style scoped>
.qr {
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  margin: 0;
}

/* The brand rides the frame, not the modules: a lime-to-coral edge reading
   origin on the left and destination on the right, same as everywhere else. */
.plate {
  position: relative;
  display: grid;
  place-items: center;
  padding: var(--space-3);
  background:
    linear-gradient(var(--soft-white), var(--soft-white)) padding-box,
    linear-gradient(115deg, var(--lime-flow), var(--coral-signal)) border-box;
  border: 2px solid transparent;
  border-radius: 12px;
  /* Offset and blur, so the plate sits on the surface rather than glowing. */
  box-shadow: 0 12px 34px -14px rgba(0, 0, 0, 0.75);
  opacity: 1;
  transform: scale(1);
  transition: opacity 320ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 320ms cubic-bezier(0.23, 1, 0.32, 1);

  /* The plate is already there when the modules start landing on it —
     paper first, ink second, rather than both materialising together. */
  @starting-style {
    opacity: 0;
    transform: scale(0.96);
  }
}

.plate canvas {
  display: block;
  width: 184px;
  height: 184px;
}

.badge {
  position: absolute;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--soft-white);
  opacity: 0;
  transform: scale(0.94);
  /* Arrives just after the modules have assembled around it. */
  transition: opacity 260ms cubic-bezier(0.23, 1, 0.32, 1) 240ms,
    transform 260ms cubic-bezier(0.23, 1, 0.32, 1) 240ms;
}

.plate.revealed .badge {
  opacity: 1;
  transform: scale(1);
}

.qr figcaption {
  color: var(--muted-gray);
  font-size: 12px;
  text-align: center;
  max-width: 190px;
}

@media (prefers-reduced-motion: reduce) {
  .plate,
  .badge {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
