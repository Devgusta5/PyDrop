<script setup lang="ts">
/**
 * The PyDrop symbol: the shipped brand mark (two overlapping discs — this
 * device in lime, the other in coral — with an arrow cut from the negative
 * space where they meet), rendered from the final artwork rather than a
 * hand-drawn approximation.
 */
withDefaults(defineProps<{ size?: number; muted?: boolean }>(), {
  size: 28,
  muted: false,
})
</script>

<template>
  <img
    class="mark"
    :class="{ muted }"
    :width="size"
    :height="size"
    src="/pydrop-logo-final-symbol.png"
    alt=""
    aria-hidden="true"
  />
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
  object-fit: contain;
  transition: filter 200ms ease, opacity 200ms ease;
}

.mark.muted {
  filter: grayscale(1);
  opacity: 0.55;
}
</style>
