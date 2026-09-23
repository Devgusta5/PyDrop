<script setup lang="ts">
/**
 * Live shared clipboard: a note both devices see and edit, synced as you type.
 * Owns no transfer logic — it emits intent and renders the state it is given.
 */
import type { Copy } from '../copy'

defineProps<{
  copy: Copy
  localText: string
  remoteText: string
  connection: 'connecting' | 'connected' | 'disconnected'
}>()

defineEmits<{
  (event: 'update', text: string): void
  (event: 'copyRemote'): void
}>()
</script>

<template>
  <section class="note" :aria-label="copy.noteTitle">
    <header class="note-head">
      <h3>{{ copy.noteTitle }}</h3>
      <span class="hint">{{ copy.noteHint }}</span>
    </header>

    <div class="note-grid">
      <div class="note-field">
        <label :for="'note-local'">{{ copy.noteYourText }}</label>
        <textarea
          id="note-local"
          :value="localText"
          :placeholder="copy.notePlaceholder"
          :disabled="connection !== 'connected'"
          @input="$emit('update', ($event.target as HTMLTextAreaElement).value)"
        />
      </div>

      <div class="note-field">
        <div class="note-field-head">
          <label :for="'note-remote'">{{ copy.noteTheirText }}</label>
          <button
            v-if="remoteText"
            class="btn ghost small"
            type="button"
            @click="$emit('copyRemote')"
          >
            {{ copy.copy }}
          </button>
        </div>
        <textarea id="note-remote" :value="remoteText" :placeholder="copy.noteWaiting" readonly />
      </div>
    </div>
  </section>
</template>

<style scoped>
.note {
  background: color-mix(in srgb, var(--graphite) 70%, transparent);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  padding: var(--space-4);
}

.note-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.note-head h3 {
  font-family: var(--font-brand);
  font-size: 14px;
  font-weight: 600;
}

.hint {
  color: var(--muted-gray);
  font-size: 11px;
}

.note-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.note-field {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.note-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.note-field label {
  color: var(--muted-gray);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

textarea {
  width: 100%;
  min-height: 120px;
  padding: var(--space-3);
  background: var(--deep-space);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  color: var(--soft-white);
  font-size: 14px;
  line-height: 1.5;
  resize: vertical;
}

textarea::placeholder {
  color: var(--muted-gray);
  opacity: 0.6;
}

textarea:focus-visible {
  border-color: var(--lime-flow);
}

textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

textarea[readonly] {
  color: var(--coral-signal);
}

@media (max-width: 620px) {
  .note-grid {
    grid-template-columns: 1fr;
  }
}
</style>
