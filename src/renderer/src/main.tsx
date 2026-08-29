import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

/**
 * The same UI runs in two places: this window, where the preload has already put
 * `window.api` there, and a browser on a phone, where nothing has (`main/phone.ts`).
 *
 * App is imported dynamically for one reason - three of its modules read `window.api` at
 * module scope (`const api = window.api`), so the object has to exist before the import
 * is evaluated, not before the first render. A static import would be hoisted above this.
 */
async function start(): Promise<void> {
  const desk = !!window.api
  if (!window.api) {
    const { installBrowserApi } = await import('./browserApi')
    await installBrowserApi()
  }
  /**
   * The app owns the title strip on macOS (`titleBarStyle: 'hiddenInset'`), so the
   * sidebar's first row has to keep clear of the traffic lights floating over it. That is
   * a fact about THIS WINDOW, not about the machine looking at it: an iPad reports "Mac"
   * in its user agent and a phone client has no traffic lights to avoid, so the class is
   * gated on the preload having been there - `window.api` before `installBrowserApi`.
   */
  if (desk && navigator.userAgent.includes('Mac')) {
    document.documentElement.classList.add('mac-chrome')
  }
  const { default: App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void start()
