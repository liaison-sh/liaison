// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Links out of Liaison (the Shopify admin) go through the host: a screen framed on
// its own origin has no popups, so a `target="_blank"` link or a `window.open`
// does nothing there. `app.openExternal` asks the host, which opens an https page
// of a host this app's manifest declares in a new tab (no opener, no referrer);
// in the page it opens the tab directly, as before.

import { app } from "@liaison/host"

/** Open an outside page; a refusal is logged, never thrown at a click handler. */
export function openOutside(href: string | null | undefined): void {
  if (!href) return
  void app.openExternal(href).catch((err: unknown) => {
    console.warn("shopify: the outside link was not opened", err)
  })
}

/** A click on an outside `<a href target="_blank">`: the host opens it instead. */
export function onOutsideLinkClick(event: MouseEvent, href: string): void {
  event.preventDefault()
  openOutside(href)
}

/** Whether this screen runs in a frame (no popups there; the host opens outside pages). */
export function screenFramed(): boolean {
  return (globalThis as { __liaisonHost?: { framed?: boolean } }).__liaisonHost?.framed === true
}
