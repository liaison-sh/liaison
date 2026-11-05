// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cloudflare Turnstile, invisible, for the demo's public forms.
//
// LOADED ONLY WHEN THE SERVER NAMES A SITE KEY (the public branding read on a
// demo deployment). No key, no script: every other deployment, and a demo box
// without Turnstile, never fetches anything from Cloudflare, and the CSP only
// allows its origin in exactly that case.
//
// ONE TOKEN PER ACTION, fresh each time. Each form asks `token(action)` at
// submit; the widget is reset and re-executed, so a token is never reused
// across forms or attempts (the server refuses a duplicate anyway).
import { type Component, onCleanup } from "solid-js"
import { demoDoorSettings } from "~/modules/demo/demo-store"

export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

export type TurnstileAction = "demo_start" | "demo_code" | "demo_verify"

interface TurnstileRenderOptions {
  sitekey: string
  action: string
  execution: "execute"
  appearance: "interaction-only"
  callback: (token: string) => void
  "error-callback": () => void
  "expired-callback": () => void
}

interface TurnstileApi {
  render(el: HTMLElement, opts: TurnstileRenderOptions): string
  execute(widgetId: string): void
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi | null> | null = null

/** Load the Turnstile script once per page. Resolves null when it cannot load. */
function loadTurnstile(): Promise<TurnstileApi | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve) => {
    const script = document.createElement("script")
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.defer = true
    script.dataset.testid = "turnstile-script"
    script.onload = () => resolve(window.turnstile ?? null)
    script.onerror = () => {
      scriptPromise = null
      resolve(null)
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/** What a form holds: a mount point and a way to ask for a fresh token. */
export interface TurnstileController {
  /** A fresh token for `action`, or "" when Turnstile is not configured or failed. */
  token(action: TurnstileAction): Promise<string>
  /** The invisible mount point; render it once inside the form. */
  Widget: Component
}

/** A per-form Turnstile. Call inside a component; it cleans up with it. */
export function createTurnstile(): TurnstileController {
  let el: HTMLDivElement | undefined
  let widgetId: string | null = null
  let api: TurnstileApi | null = null

  onCleanup(() => {
    if (api && widgetId) api.remove(widgetId)
  })

  async function token(action: TurnstileAction): Promise<string> {
    const siteKey = demoDoorSettings()?.turnstileSiteKey
    if (!siteKey || !el) return ""
    api = await loadTurnstile()
    if (!api) return ""
    const loaded = api
    if (widgetId) {
      loaded.remove(widgetId)
      widgetId = null
    }
    return new Promise<string>((resolve) => {
      const mount = el
      if (!mount) {
        resolve("")
        return
      }
      widgetId = loaded.render(mount, {
        sitekey: siteKey,
        action,
        execution: "execute",
        appearance: "interaction-only",
        callback: (t) => resolve(t),
        "error-callback": () => resolve(""),
        "expired-callback": () => resolve(""),
      })
      loaded.execute(widgetId)
    })
  }

  const Widget: Component = () => (
    <div
      data-testid="demo-turnstile"
      ref={(node) => {
        el = node
      }}
    />
  )

  return { token, Widget }
}

/** @internal - test isolation only */
export function _resetTurnstileLoader(): void {
  scriptPromise = null
}
