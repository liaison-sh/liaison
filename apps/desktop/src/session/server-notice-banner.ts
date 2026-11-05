// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "NEW IN <SERVER>": the fallback for a notification from another saved server
// whose click nobody heard (a Windows toast opened later from the Action
// Center, a Linux desktop without actions, an unbundled macOS build). The shell
// keeps the latest unopened notification per server (desktop_notifications.rs
// `server_notices`); whenever the window comes forward, this asks for them and
// shows one banner per server. A click opens that server's latest notification
// exactly as a click on it would (the shell files the route for that server's
// page, the window switches there); the close button dismisses it.

import { invoke } from "../tauri"

export const NOTICES_COMMAND = "server_notices"
export const OPEN_NOTICE_COMMAND = "open_server_notice"
export const DISMISS_NOTICE_COMMAND = "dismiss_server_notice"
export const BANNER_ID = "liaison-server-notices"

export interface NoticeOffer {
  server: string
  label: string
}

export interface ServerNoticeDeps {
  doc?: Document
  view?: Pick<Window, "addEventListener" | "removeEventListener">
  /** The window's own switch (session/account-menu.ts). */
  switchTo: (address: string) => Promise<unknown>
}

/** The banner's words. No dash punctuation: a customer reads them. */
export function noticeText(label: string): string {
  return `New in ${label}`
}

function offersOf(value: unknown): NoticeOffer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const { server, label } = (entry ?? {}) as { server?: unknown; label?: unknown }
    return typeof server === "string" && typeof label === "string" ? [{ server, label }] : []
  })
}

/** Draws the banners for `offers`, replacing any drawn before. */
export function renderServerNotices(
  doc: Document,
  offers: NoticeOffer[],
  actions: { open: (server: string) => void; dismiss: (server: string) => void },
): void {
  doc.getElementById(BANNER_ID)?.remove()
  if (offers.length === 0) return
  const strip = doc.createElement("div")
  strip.id = BANNER_ID
  strip.setAttribute("role", "status")
  strip.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;flex-direction:column;gap:8px"
  for (const offer of offers) {
    const row = doc.createElement("div")
    row.style.cssText =
      "display:flex;align-items:center;gap:4px;border-radius:10px;background:#3f4a63;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)"
    const open = doc.createElement("button")
    open.type = "button"
    open.textContent = noticeText(offer.label)
    open.dataset.server = offer.server
    open.style.cssText =
      "border:0;background:none;color:inherit;font:inherit;padding:10px 4px 10px 14px;cursor:pointer"
    open.addEventListener("click", () => actions.open(offer.server))
    const close = doc.createElement("button")
    close.type = "button"
    close.textContent = "×"
    close.setAttribute("aria-label", "Dismiss")
    close.style.cssText =
      "border:0;background:none;color:inherit;font:inherit;padding:10px 12px;cursor:pointer"
    close.addEventListener("click", () => actions.dismiss(offer.server))
    row.append(open, close)
    strip.appendChild(row)
  }
  doc.documentElement.appendChild(strip)
}

/**
 * Asks for the unopened notices now and whenever the window comes forward.
 * Returns the uninstaller. Nothing here throws into the page.
 */
export function installServerNoticeBanner(deps: ServerNoticeDeps): () => void {
  const doc = deps.doc ?? document
  const view = deps.view ?? window
  let stopped = false
  const refresh = async (): Promise<void> => {
    let offers: NoticeOffer[] = []
    try {
      offers = offersOf(await invoke<unknown>(NOTICES_COMMAND))
    } catch {
      offers = []
    }
    if (stopped) return
    // Drawing is best effort: a refresh runs detached (focus, visibility, the
    // first ask), so a document that cannot take the banner yet must not
    // surface as an unhandled rejection in the page.
    try {
      draw(offers)
    } catch (err) {
      console.error("liaison: the server notices could not be drawn", err)
    }
  }
  const draw = (offers: NoticeOffer[]): void => {
    renderServerNotices(doc, offers, {
      open: (server) => {
        void (async () => {
          doc.getElementById(BANNER_ID)?.remove()
          const address = await invoke<string | null>(OPEN_NOTICE_COMMAND, { server }).catch(
            () => null,
          )
          if (typeof address === "string" && address.length > 0) {
            await deps.switchTo(address).catch(() => undefined)
          }
        })()
      },
      dismiss: (server) => {
        void invoke(DISMISS_NOTICE_COMMAND, { server })
          .catch(() => undefined)
          .then(() => refresh())
      },
    })
  }
  const onFocus = () => void refresh()
  const onVisible = () => {
    if (doc.visibilityState === "visible") void refresh()
  }
  view.addEventListener("focus", onFocus)
  doc.addEventListener("visibilitychange", onVisible)
  void refresh()
  return () => {
    stopped = true
    view.removeEventListener("focus", onFocus)
    doc.removeEventListener("visibilitychange", onVisible)
  }
}
