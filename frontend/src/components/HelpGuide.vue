<script setup lang="ts">
/**
 * Full how-to-use guide, for people who have never seen PyDrop before.
 * Pure presentation: the parent owns whether it's open.
 */
import type { Copy } from '../copy'

defineProps<{
  copy: Copy
}>()

defineEmits<{
  (event: 'close'): void
}>()
</script>

<template>
  <div class="scrim" @click="$emit('close')"></div>
  <div class="guide" role="dialog" aria-modal="true" :aria-label="copy.helpTitle">
    <header class="guide-head">
      <h2>{{ copy.helpTitle }}</h2>
      <button class="dismiss" type="button" :aria-label="copy.close" @click="$emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="guide-body">
      <section>
        <h3>{{ copy.helpStep1Title }}</h3>
        <p>{{ copy.helpStep1Body }}</p>
      </section>
      <section>
        <h3>{{ copy.helpStep2Title }}</h3>
        <p>{{ copy.helpStep2Body }}</p>
      </section>
      <section>
        <h3>{{ copy.helpStep3Title }}</h3>
        <p>{{ copy.helpStep3Body }}</p>
      </section>
      <section>
        <h3>{{ copy.helpNoteTitle }}</h3>
        <p>{{ copy.helpNoteBody }}</p>
      </section>
      <section>
        <h3>{{ copy.helpFaqTitle }}</h3>
        <dl>
          <div>
            <dt>{{ copy.helpFaqInstallQ }}</dt>
            <dd>{{ copy.helpFaqInstallA }}</dd>
          </div>
          <div>
            <dt>{{ copy.helpFaqSecurityQ }}</dt>
            <dd>{{ copy.helpFaqSecurityA }}</dd>
          </div>
          <div>
            <dt>{{ copy.helpFaqExpiryQ }}</dt>
            <dd>{{ copy.helpFaqExpiryA }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <button class="guide-close" type="button" @click="$emit('close')">{{ copy.close }}</button>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 39;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.guide {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  width: min(520px, calc(100% - var(--space-6)));
  max-height: calc(100dvh - var(--space-6));
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--graphite);
  border: 1px solid var(--quiet-border);
  border-radius: var(--radius);
  box-shadow: 0 24px 70px -12px rgba(0, 0, 0, 0.7);
}

.guide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.guide-head h2 {
  font-family: var(--font-brand);
  font-size: 20px;
  font-weight: 600;
}

.dismiss {
  position: relative;
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: none;
  border: 0;
  color: var(--muted-gray);
}

.dismiss::before {
  content: '';
  position: absolute;
  inset: -7px;
}

.dismiss:hover {
  color: var(--soft-white);
}

.dismiss svg {
  width: 15px;
  height: 15px;
}

.guide-body {
  overflow-y: auto;
  display: grid;
  gap: var(--space-4);
  padding-right: var(--space-1);
}

.guide-body h3 {
  font-family: var(--font-brand);
  font-size: 14px;
  font-weight: 600;
  color: var(--lime-flow);
  margin-bottom: var(--space-1);
}

.guide-body p {
  color: var(--muted-gray);
  font-size: 14px;
  line-height: 1.55;
}

.guide-body dl {
  display: grid;
  gap: var(--space-3);
}

.guide-body dt {
  color: var(--soft-white);
  font-size: 13px;
  font-weight: 600;
}

.guide-body dd {
  margin-top: 2px;
  color: var(--muted-gray);
  font-size: 13px;
  line-height: 1.5;
}

.guide-close {
  flex: none;
  min-height: 48px;
  padding: 0 var(--space-5);
  background: var(--lime-flow);
  border: 0;
  border-radius: var(--radius);
  color: var(--deep-space);
  font-size: 15px;
  font-weight: 600;
}

.guide-close:active {
  transform: scale(0.97);
}
</style>
