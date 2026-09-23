<script setup lang="ts">
/**
 * The transfer surface: pick a direction, stage a file, watch it move.
 * Owns no transfer logic — it emits intent and renders the state it is given.
 */
import type { TransferMode } from '../api'
import type { Copy } from '../copy'

defineProps<{
  copy: Copy
  direction: TransferMode
  remoteDirection: TransferMode
  selectedFile: File | null
  queue: File[]
  queuedBytes: number
  isTransferring: boolean
  isReceiving: boolean
  transferComplete: boolean
  transferPercent: number
  receivePercent: number
  activeTransferName: string
  incomingName: string
  canTransfer: boolean
  connection: 'connecting' | 'connected' | 'disconnected'
  peerModeMessage: string
  bothReceiving: boolean
  isDragOver: boolean
  fileLabel: string
}>()

defineEmits<{
  (event: 'setDirection', mode: TransferMode): void
  (event: 'selectFile', payload: Event): void
  (event: 'dragOver', payload: DragEvent): void
  (event: 'dragLeave'): void
  (event: 'drop', payload: DragEvent): void
  (event: 'send'): void
  (event: 'clear'): void
  (event: 'removeQueued', index: number): void
}>()

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <section class="dock" :aria-label="copy.transferPanel">
    <header class="dock-head">
      <div class="mode" role="group" :aria-label="`${copy.modeSend} / ${copy.modeReceive}`">
        <button
          type="button"
          :class="{ active: direction === 'send' }"
          :aria-pressed="direction === 'send'"
          :disabled="isTransferring"
          @click="$emit('setDirection', 'send')"
        >
          {{ copy.modeSend }}
        </button>
        <button
          type="button"
          :class="{ active: direction === 'receive' }"
          :aria-pressed="direction === 'receive'"
          :disabled="isTransferring"
          @click="$emit('setDirection', 'receive')"
        >
          {{ copy.modeReceive }}
        </button>
      </div>
      <p v-if="peerModeMessage" class="peer" :class="{ warn: bothReceiving }" aria-live="polite">
        {{ peerModeMessage }}
      </p>
    </header>

    <!-- Send: one surface that becomes the file list once files are staged,
         rather than a dropzone with a separate list stacked under it. -->
    <div
      v-if="direction === 'send'"
      class="stage-area"
      :class="{ filled: queue.length, over: isDragOver, locked: isTransferring }"
      @dragover="$emit('dragOver', $event)"
      @dragleave="$emit('dragLeave')"
      @drop="$emit('drop', $event)"
    >
      <label v-if="!queue.length" class="drop-invite">
        <input type="file" multiple :disabled="isTransferring" @change="$emit('selectFile', $event)" />
        <span class="glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" stroke-linecap="round" />
          </svg>
        </span>
        <span class="label">
          <strong>{{ copy.chooseFiles }}</strong>
          <small>{{ copy.dropHintMulti }}</small>
        </span>
      </label>

      <template v-else>
        <!-- #2 The queue itself: each file removable until the batch starts. -->
        <ul class="queue">
          <li v-for="(file, i) in queue" :key="file.name + file.size">
            <span class="q-name">{{ file.name }}</span>
            <span class="q-size tabular">{{ formatBytes(file.size) }}</span>
            <button
              v-if="!isTransferring"
              type="button"
              :aria-label="copy.removeFromQueue(file.name)"
              @click="$emit('removeQueued', i)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d="M7 7l10 10M17 7L7 17" stroke-linecap="round" />
              </svg>
            </button>
          </li>
        </ul>

        <footer class="stage-foot">
          <span class="summary tabular">{{ queue.length }} {{ copy.queued }} · {{ formatBytes(queuedBytes) }}</span>
          <span class="foot-actions">
            <label v-if="!isTransferring" class="more">
              <input type="file" multiple @change="$emit('selectFile', $event)" />
              {{ copy.addFiles }}
            </label>
            <button
              v-if="!isTransferring"
              type="button"
              class="clear-all"
              @click="$emit('clear')"
            >
              {{ copy.clearQueue }}
            </button>
          </span>
        </footer>
      </template>
    </div>

    <div v-else class="await">
      <span class="glyph coral" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 4v12m0 0l4.5-4.5M12 16l-4.5-4.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" stroke-linecap="round" />
        </svg>
      </span>
      <span class="label">
        <strong>{{ copy.waitingForFile }}</strong>
        <small>{{ copy.waitingForFileBody }}</small>
      </span>
    </div>

    <!-- Progress. Send and receive report separately: both can run at once. -->
    <div v-if="direction === 'send' && (isTransferring || transferComplete)" class="meter">
      <div class="meter-head">
        <span>{{ transferComplete ? copy.complete : `${copy.sending} ${activeTransferName}` }}</span>
        <strong class="tabular">{{ transferPercent }}%</strong>
      </div>
      <div
        class="track"
        role="progressbar"
        :aria-label="`${copy.sending} ${activeTransferName}`"
        :aria-valuenow="transferPercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="fill lime" :style="{ transform: `scaleX(${transferPercent / 100})` }"></div>
      </div>
    </div>

    <div v-if="isReceiving || (incomingName && !transferComplete)" class="meter">
      <div class="meter-head">
        <span>{{ isReceiving ? `${copy.receiving} ${incomingName}` : `${copy.received} ${incomingName}` }}</span>
        <strong class="tabular">{{ receivePercent }}%</strong>
      </div>
      <div
        class="track"
        role="progressbar"
        :aria-label="`${copy.receiving} ${incomingName}`"
        :aria-valuenow="receivePercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="fill coral" :style="{ transform: `scaleX(${receivePercent / 100})` }"></div>
      </div>
    </div>

    <button
      v-if="direction === 'send'"
      class="send"
      type="button"
      :disabled="!canTransfer"
      @click="$emit('send')"
    >
      {{
        connection === 'disconnected'
          ? copy.deviceDisconnected
          : isTransferring
            ? `${copy.sending}...`
            : transferComplete
              ? copy.sendAnother
              : queue.length > 1 ? copy.sendAll : copy.send
      }}
    </button>
  </section>
</template>

<style scoped>
.dock {
  background: color-mix(in srgb, var(--graphite) 94%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
  backdrop-filter: blur(12px);
}

.dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.mode {
  display: flex;
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  padding: 2px;
}

.mode button {
  background: transparent;
  border: 0;
  border-radius: 2px;
  color: var(--muted-gray);
  font-size: 13px;
  font-weight: 500;
  padding: var(--space-2) var(--space-4);
  min-height: 36px;
  transition: color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    transform 100ms var(--ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .mode button:hover:not(:disabled) {
    color: var(--soft-white);
  }
}

.mode button:active:not(:disabled) {
  transform: scale(0.96);
}

.mode button.active {
  background: var(--lime-flow);
  color: var(--deep-space);
  font-weight: 600;
}

/* Receive mode is the other device's color, so the switch teaches the vocabulary. */
.mode button.active:last-child {
  background: var(--coral-signal);
}

.mode button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.peer {
  color: var(--muted-gray);
  font-size: 12px;
}

/* This one asks the user to fix something, so it must not blend into the
   coral that merely means "the other device". */
.peer.warn {
  color: var(--error-red);
}

.stage-area,
.await {
  border-radius: var(--radius);
  border: 1px dashed var(--quiet-border);
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    transform 220ms var(--ease-out);
}

.await {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 72px;
  padding: var(--space-3);
  border-color: var(--coral-edge);
  background: var(--coral-wash);
}

/* Holding files it stops being an invitation and becomes a container. */
.stage-area.filled {
  border-style: solid;
  border-color: var(--lime-edge);
  background: var(--lime-wash);
}

/* Dragging a file over lifts the zone toward the cursor — the target
   acknowledges the file before it is dropped. */
.stage-area.over {
  border-style: solid;
  border-color: var(--lime-flow);
  background: var(--lime-wash);
  transform: scale(1.012);
}

.stage-area.over .glyph {
  transform: translateY(-2px) scale(1.06);
}

.stage-area.locked {
  opacity: 0.6;
}

.drop-invite {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 72px;
  padding: var(--space-3);
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .stage-area:not(.filled):hover {
    border-color: var(--lime-edge);
    background: var(--lime-wash);
  }
}

.stage-area.locked .drop-invite,
.stage-area.locked .more {
  cursor: not-allowed;
}

.drop-invite input,
.more input {
  display: none;
}

.stage-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.summary {
  color: var(--muted-gray);
  font-size: 12px;
}

.foot-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* Secondary to the send button: text, not another filled control. */
.more,
.clear-all {
  background: none;
  border: 0;
  padding: 0;
  color: var(--muted-gray);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color var(--duration-fast) var(--ease-out);
}

.more:hover {
  color: var(--lime-flow);
}

.clear-all:hover {
  color: var(--error-red);
}

.glyph {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--lime-flow);
  border: 1px solid currentColor;
  border-radius: 50%;
}

.glyph.coral {
  color: var(--coral-signal);
}

.glyph {
  transition: transform 220ms var(--ease-out);
}

.glyph svg {
  width: 19px;
  height: 19px;
}

.label {
  min-width: 0;
  flex: 1;
}

.label strong {
  display: block;
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label small {
  display: block;
  color: var(--muted-gray);
  font-size: 12px;
  margin-top: 2px;
}

.queue {
  list-style: none;
  margin: 0;
  padding: var(--space-2) var(--space-2) 0;
  display: grid;
  gap: 1px;
  max-height: 168px;
  overflow-y: auto;
}

/* Rows sit directly on the container: no second card inside the first. */
.queue li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: 3px;
  font-size: 13px;
}

.queue li + li {
  border-top: 1px solid color-mix(in srgb, var(--quiet-border) 60%, transparent);
}

.q-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.q-size {
  color: var(--muted-gray);
  font-size: 12px;
}

.queue button {
  position: relative;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 0;
  color: var(--muted-gray);
  border-radius: 3px;
}

/* Visual size stays compact in the dense row; the tap target still meets the
   44px minimum by extending into the row's padding rather than the layout. */
.queue button::before {
  content: '';
  position: absolute;
  inset: -9px;
}

.queue button:hover {
  color: var(--error-red);
}

.queue button svg {
  width: 14px;
  height: 14px;
}

/* Eases into the layout rather than snapping in, so the meter appearing
   mid-transfer does not read as a sudden jump on the page around it. */
.meter {
  display: grid;
  gap: var(--space-2);
  transition: opacity 200ms var(--ease-out);

  @starting-style {
    opacity: 0;
  }
}

.meter-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 13px;
  color: var(--muted-gray);
}

.meter-head span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track {
  height: 2px;
  background: var(--quiet-border);
  overflow: hidden;
}

/* Transform rather than width: this updates on every chunk, and scaling
   stays on the compositor instead of forcing layout each time. */
.fill {
  height: 100%;
  width: 100%;
  transform-origin: left center;
  transition: transform var(--duration-base) var(--ease-out);
}

.fill.lime {
  background: var(--lime-flow);
}

.fill.coral {
  background: var(--coral-signal);
}

.meter-head strong {
  font-weight: 500;
}

.meter:has(.fill.lime) .meter-head strong {
  color: var(--lime-flow);
}

.meter:has(.fill.coral) .meter-head strong {
  color: var(--coral-signal);
}

.send {
  min-height: 48px;
  border: 0;
  border-radius: var(--radius);
  background: var(--lime-flow);
  color: var(--deep-space);
  font-weight: 600;
  transition: opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .send:hover:not(:disabled) {
    transform: translateY(-1px);
  }
}

.send:active:not(:disabled) {
  transform: scale(0.98);
  transition-duration: 100ms;
}

/* Disabled reads as an inert surface rather than a dimmed lime button, which
   muddied into olive against the dark ground. */
.send:disabled {
  background: var(--slate-charcoal);
  border: 1px solid var(--quiet-border);
  color: var(--muted-gray);
  cursor: not-allowed;
  transform: none;
}
</style>
