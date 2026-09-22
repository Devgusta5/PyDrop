<script setup lang="ts">
/**
 * The abstract connection visual: this device (lime) and the other device (coral),
 * with the portal between them. It reads the app state rather than owning any logic,
 * so the same component serves the home screen and the connected screen.
 */
import PortalMark from './PortalMark.vue'

const props = defineProps<{
  localLabel: string
  remoteLabel: string
  /** 'idle' = nobody yet, 'waiting' = room open, 'linked' = both present. */
  phase: 'idle' | 'waiting' | 'linked'
  /** 0..1 while a file is moving; -1 when nothing is in flight. */
  flow?: number
  /** Which way the file is travelling, when one is. */
  flowDirection?: 'send' | 'receive'
}>()

const travelling = () => (props.flow ?? -1) >= 0
</script>

<template>
  <div class="field" :class="[`phase-${phase}`, { 'is-travelling': travelling() }]">
    <!-- The connection path. Two lines: the link itself, and the active flow over it. -->
    <svg class="path" viewBox="0 0 400 160" fill="none" aria-hidden="true" preserveAspectRatio="none">
      <line class="link" x1="54" y1="112" x2="346" y2="48" />
      <line
        v-if="phase !== 'idle'"
        class="link-live"
        :class="flowDirection"
        x1="54"
        y1="112"
        x2="346"
        y2="48"
      />
    </svg>

    <div class="node node-local">
      <span class="dot"></span>
      <strong class="tabular">{{ localLabel }}</strong>
    </div>

    <div class="portal">
      <PortalMark :size="46" :muted="phase === 'idle'" />
    </div>

    <div class="node node-remote" :class="{ 'is-absent': phase !== 'linked' }">
      <span class="dot"></span>
      <strong class="tabular">{{ remoteLabel }}</strong>
    </div>

    <!-- The file itself, moving along the link while a transfer runs. -->
    <span
      v-if="travelling()"
      class="payload"
      :style="{ '--t': String(flowDirection === 'receive' ? 1 - (flow ?? 0) : (flow ?? 0)) }"
    ></span>
  </div>
</template>

<style scoped>
.field {
  position: relative;
  width: 100%;
  aspect-ratio: 400 / 160;
  min-height: 190px;
}

.path {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.link {
  stroke: var(--quiet-border);
  stroke-width: 1;
}

/* The live link is drawn on top and animates in when the room opens. */
.link-live {
  stroke: var(--lime-edge);
  stroke-width: 1;
  stroke-dasharray: 3 7;
  animation: drift 1.4s linear infinite;
}

.phase-linked .link-live {
  stroke: var(--coral-edge);
}

@keyframes drift {
  to {
    stroke-dashoffset: -20;
  }
}

.node {
  position: absolute;
  display: grid;
  justify-items: center;
  gap: var(--space-2);
}

.node-local {
  left: 8%;
  top: 60%;
  color: var(--lime-flow);
}

.node-remote {
  right: 6%;
  top: 16%;
  color: var(--coral-signal);
}

.dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: currentColor;
  /* Offset + blur, so the glow reads as light rather than a flat halo. */
  box-shadow: 0 2px 22px -2px currentColor;
}

.node-remote.is-absent {
  color: var(--muted-gray);
}

.node-remote.is-absent .dot {
  background: transparent;
  border: 1px dashed currentColor;
  box-shadow: none;
}

.node strong {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--muted-gray);
  white-space: nowrap;
}

.portal {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  opacity: 0.92;
}

.phase-idle .portal {
  opacity: 0.55;
}

/* The payload rides the same line the link draws, so the two always agree. */
.payload {
  position: absolute;
  left: calc(13.5% + (73% * var(--t)));
  top: calc(70% - (40% * var(--t)));
  width: 10px;
  height: 13px;
  border-radius: 1px;
  background: var(--soft-white);
  box-shadow: 0 0 18px 2px rgba(244, 247, 242, 0.5);
  transition: left var(--duration-base) linear, top var(--duration-base) linear;
}

@media (prefers-reduced-motion: reduce) {
  .link-live {
    animation: none;
  }
}

@media (max-width: 860px) {
  .field {
    /* On phones the field becomes a compact band rather than a shrunken square. */
    aspect-ratio: 400 / 120;
    min-height: 0;
  }

  .node strong {
    font-size: 9px;
  }
}
</style>
