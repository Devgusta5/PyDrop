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
}
