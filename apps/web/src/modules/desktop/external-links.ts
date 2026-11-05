// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EXTERNAL LINKS OPEN IN THE USER'S OWN BROWSER.
//
// In a browser a `target=_blank` link and `window.open` open a new tab. In the
// desktop app the webview has no tabs and no new windows: both did nothing,
// and a link without a target navigated the app itself away. So on desktop
// every external link goes to the shell, which opens it in the system browser
// (or mail client) after checking it is an http, https or mailto URL with no
// credentials (`open_external_url`, sidecar.rs).
//
// Two halves:
//   - `openExternal(url)`, for code that opens a URL itself (`window.open`
//     callers): the shell on desktop, a `noopener` new tab in a browser;
//   - one delegated capture phase click listener on the document (and on a
//     mail body's same-origin iframe), which on desktop only turns a click on
//     an external `a[href]` into `openExternal`. Same-origin app links,
//     mentions and local path links (`local-path-links.ts`, `href="#"`) are
//     left to their own handlers. In a browser it does nothing at all.

import { canOpenExternalUrl, openExternalUrl } from "./desktop-store"

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"])
/** What a browser may open from code: the link schemes, plus a phone number. */
const BROWSER_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"])

function parse(url: string, base?: string): URL | null {
  try {
    return base ? new URL(url.trim(), base) : new URL(url.trim())
  } catch {
    return null
  }
}

/**
 * Opens `url` outside the app. Desktop: through the shell (a URL it refuses
 * opens nothing). Browser: a new tab without an
 * opener. False when nothing was opened.
 */
export async function openExternal(url: string): Promise<boolean> {
  const parsed = parse(url)
  if (!parsed) return false
  if (canOpenExternalUrl()) {
    if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return false
    return openExternalUrl(parsed.href)
  }
  if (!BROWSER_SCHEMES.has(parsed.protocol) || typeof window === "undefined") return false
  window.open(parsed.href, "_blank", "noopener,noreferrer")
  return true
}

/**
 * The external URL a click on `target` should open, or null when the click
 * is not on an external link. `appOrigin` is the app's own origin: a link to
 * it is in-app navigation, not an external page.
 */
export function externalLinkTarget(target: EventTarget | null, appOrigin: string): string | null {
  const element = target as Element | null
  if (!element || typeof element.closest !== "function") return null
  const anchor = element.closest("a[href]")
  if (!anchor) return null
  // A mention chip, or a link inside one, has its own click.
  if (anchor.closest("[data-mention-ref]")) return null
  // A download stays a download.
  if (anchor.hasAttribute("download")) return null
  const href = anchor.getAttribute("href")
  if (!href) return null
  const parsed = parse(href, appOrigin)
  if (!parsed || !EXTERNAL_SCHEMES.has(parsed.protocol)) return null
  if (parsed.protocol !== "mailto:" && parsed.origin === appOrigin) return null
  return parsed.href
}

/**
 * THE CLICK. Desktop only: a primary or middle click on an external link is
 * stopped and handed to the shell. Every modifier opens it the same way (the
 * webview has no tab or window for cmd, ctrl or shift to open it in), except
 * alt, which is left alone. True when the click was handled here.
 */
export function handleExternalLinkClick(event: MouseEvent, appOrigin: string): boolean {
  if (event.defaultPrevented || !canOpenExternalUrl()) return false
  if (event.button !== 0 && event.button !== 1) return false
  if (event.altKey) return false
  const url = externalLinkTarget(event.target, appOrigin)
  if (!url) return false
  event.preventDefault()
  void openExternal(url)
  return true
}

function appOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin
}

/**
 * Installs the listener on `doc` (the app's document by default, or a
 * same-origin iframe's) and answers its remover. The app's origin is read at
 * click time from the top window, so an iframe's `about:srcdoc` never counts
 * as the app.
 */
export function installExternalLinkHandler(doc: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    handleExternalLinkClick(event, appOrigin())
  }
  doc.addEventListener("click", onClick, true)
  doc.addEventListener("auxclick", onClick, true)
  return () => {
    doc.removeEventListener("click", onClick, true)
    doc.removeEventListener("auxclick", onClick, true)
  }
}

let installed: (() => void) | null = null

/** Web bootstrap: installs the document listener once. Inert in a browser. */
export function startExternalLinkRouting(): void {
  if (installed || typeof document === "undefined") return
  installed = installExternalLinkHandler(document)
}
