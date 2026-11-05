// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DEBUG BUILDS ONLY, like the rest of `diagnostics.ts`: the report goes
// through `report_webview_diagnostic`, which the shell registers under
// `cfg(debug_assertions)` alone, so in a release build the line is a rejected
// invoke and nothing more.
//
// Why it exists: a driven walk judges the WINDOW, and a window that draws
// nothing says nothing about WHICH layer is blank. Since A33 the shell draws
// no pixels at all, so the layers that stack in this page are apps/web's own
// root and whatever screen it has put inside it: a blank window is a page
// that never mounted, a page that mounted with no children, or a screen that
// is on screen and invisible. Rects and computed styles separate those three
// cases; a child count separates "nothing rendered" from "rendered and not
// painted"; the error counter says whether something threw on the way.
//
// It is REPOINTED, not retired, and that is the point: now that the page
// draws everything, the in-window measurement is the only thing that can tell
// a white window from a white page.
//
// It is a SINK of numbers, printed once a few seconds after mount and once
// again later, because the host app paints after an awaited auth roundtrip
// and the first sample would otherwise accuse a page that had not started.

import { reportDiagnostic } from "./diagnostics"

/** When the probe samples the page, counted from the overlay's mount. */
export const DOM_PROBE_DELAYS_MS: readonly number[] = [3000, 10000]

/** Where apps/web mounts (`apps/web/src/index.tsx`). It is the page's root
 * AND the only root there is: the shell appends none of its own. */
const HOST_SELECTOR = "#app"
/** apps/web's login card (`apps/web/src/modules/auth/Login.tsx`), which is the
 * screen a first launch lands on and the one a walk most needs measured. */
const PANEL_SELECTOR = '[data-testid="auth-card"]'
/** How much of the host page's text is quoted. Enough to recognize a screen. */
const TEXT_HEAD = 80
/** How many of the panel's descendants are measured. A login card is a card
 * and four controls: enough to see every one of them. */
const PANEL_DESCENDANTS = 8

let errorCount = 0
let lastError = ""

function record(message: string): void {
  errorCount += 1
  lastError = message.replace(/\s+/g, " ").slice(0, 120)
}

function computed(element: Element, property: string): string {
  const view = element.ownerDocument.defaultView
  if (!view) return "?"
  return view.getComputedStyle(element).getPropertyValue(property) || "-"
}

function describeRoot(doc: Document): string {
  const root = doc.querySelector(HOST_SELECTOR)
  if (!root) return "root=absent"
  return [
    "root=present",
    `root.children=${root.childElementCount}`,
    `root.bg=${computed(root, "background-color")}`,
    `root.z=${computed(root, "z-index")}`,
    `root.pos=${computed(root, "position")}`,
    `root.pe=${computed(root, "pointer-events")}`,
  ].join(" ")
}

function describePanel(doc: Document): string {
  const panel = doc.querySelector(PANEL_SELECTOR)
  if (!panel) return "panel=absent"
  const rect = panel.getBoundingClientRect()
  return [
    "panel=present",
    `panel.children=${panel.childElementCount}`,
    `panel.rect=${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
    `panel.color=${computed(panel, "color")}`,
    `panel.bg=${computed(panel, "background-color")}`,
    `panel.vis=${computed(panel, "visibility")}`,
    `panel.opacity=${computed(panel, "opacity")}`,
    `panel.display=${computed(panel, "display")}`,
    describeChildren(panel),
  ].join(" ")
}

/** Each control the screen draws, so a laid out panel is told from a painted
 * one: a subtree with real rects and an ink colour over a window that shows
 * none of it is a compositing failure, not a render that did not happen. */
function describeChildren(panel: Element): string {
  const parts: string[] = []
  const walk = panel.querySelectorAll("*")
  for (let index = 0; index < walk.length && index < PANEL_DESCENDANTS; index += 1) {
    const node = walk[index]
    const rect = node.getBoundingClientRect()
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24)
    parts.push(
      `${node.tagName}|${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}|${computed(node, "color")}|${computed(node, "background-color")}|${text}`,
    )
  }
  return `panel.kids=[${parts.join(" ; ")}]`
}

function describeHost(doc: Document): string {
  const host = doc.querySelector(HOST_SELECTOR)
  if (!host) return "host=absent"
  const text = (host.textContent ?? "").replace(/\s+/g, " ").trim()
  return [
    `host=${HOST_SELECTOR}`,
    `host.children=${host.childElementCount}`,
    `host.text=${text.length}`,
    `host.head="${text.slice(0, TEXT_HEAD)}"`,
  ].join(" ")
}

/** One line naming every layer of the page, for a walk's log. */
export function describeDom(doc: Document): string {
  return [
    `readyState=${doc.readyState}`,
    `body.children=${doc.body?.childElementCount ?? 0}`,
    describeRoot(doc),
    describePanel(doc),
    describeHost(doc),
    `errors=${errorCount}`,
    `lastError="${lastError}"`,
  ].join(" ")
}

/**
 * Counts what the page throws from the moment the overlay mounts, and reports
 * the page's shape at each delay. Returns the uninstall so a test leaves no
 * timer behind.
 */
export function installDomProbe(doc: Document = document): () => void {
  const view = doc.defaultView ?? globalThis.window
  const onError = (event: Event): void => {
    const error = event as ErrorEvent
    record(String(error.message || error.error || "error"))
  }
  const onRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason
    record(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
  }
  view?.addEventListener("error", onError)
  view?.addEventListener("unhandledrejection", onRejection)

  const timers = DOM_PROBE_DELAYS_MS.map((delay) =>
    setTimeout(() => reportDiagnostic("dom", describeDom(doc)), delay),
  )

  return () => {
    for (const timer of timers) clearTimeout(timer)
    view?.removeEventListener("error", onError)
    view?.removeEventListener("unhandledrejection", onRejection)
  }
}

/** Test seam: forgets the errors counted so far. */
export function resetDomProbeErrors(): void {
  errorCount = 0
  lastError = ""
}
