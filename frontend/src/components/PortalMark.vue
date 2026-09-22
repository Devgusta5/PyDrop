<script setup lang="ts">
/**
 * The PyDrop symbol: two overlapping discs — this device (lime) and the other
 * (coral) — with an arrow cut from the negative space where they meet.
 *
 * Authored as SVG rather than using the PNG so it stays crisp at any size and can
 * be dimmed when the connection is idle. A mask carves the arrow so the shape is
 * genuine negative space against whatever sits behind it.
 */
withDefaults(defineProps<{ size?: number; muted?: boolean }>(), {
  size: 28,
  muted: false,
})

// Unique per instance: several marks can share a page.
const uid = `pm-${Math.random().toString(36).slice(2, 9)}`
</script>

<template>
  <svg
    class="mark"
    :class="{ muted }"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <mask :id="uid">
        <rect x="0" y="0" width="64" height="64" fill="white" />
        <!-- The passage: shaft + head, carved out of both discs. -->
        <path
          d="M13.5 28h17.9v-6.4a1.8 1.8 0 0 1 3-1.3l11.4 10.4a1.8 1.8 0 0 1 0 2.6L34.4 43.7a1.8 1.8 0 0 1-3-1.3V36H13.5a1.8 1.8 0 0 1-1.8-1.8v-4.4A1.8 1.8 0 0 1 13.5 28Z"
          fill="black"
        />
      </mask>
    </defs>

    <!-- Centres 22 apart with r=17: the discs overlap by a third, so both forms
         stay legible and the overlap reads as the shared passage. -->
    <g :mask="`url(#${uid})`">
      <circle class="origin" cx="21" cy="32" r="17" />
      <circle class="destination" cx="43" cy="32" r="17" />
    </g>
  </svg>
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
}

.origin {
  fill: var(--lime-flow);
}

/* Coral sits over lime in the overlap, matching the shipped symbol's stacking. */
.destination {
  fill: var(--coral-signal);
  opacity: 0.92;
}

.mark.muted .origin,
.mark.muted .destination {
  fill: var(--muted-gray);
  opacity: 0.55;
}
</style>
