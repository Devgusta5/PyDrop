import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')

// App-shell caching only. Registered after load so it never competes with the
// first paint or with opening a room.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unavailable service worker must never break the app itself.
    })
  })

  // A new worker calls skipWaiting/claim, so it takes over this page while the
  // page is still running the previous build's JS. Reload once so the two match
  // — without this, a stale shell can survive every visit until data is cleared.
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}
