// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { BOOT_SCRIPT_NAME, injectBootScript, pinViewportScale } from "../scripts/boot-injection"

const APP_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>'

describe("boot script injection", () => {
  it("runs the mobile boot bundle before the web app's own entry", () => {
    const html = injectBootScript(APP_HTML)
    expect(html).toContain(`src="/${BOOT_SCRIPT_NAME}"`)
    expect(html.indexOf(BOOT_SCRIPT_NAME)).toBeLessThan(html.indexOf("/assets/index-abc.js"))
    // A classic script, not a module: a module is deferred and would run after
    // the app it is supposed to precede.
    expect(html).not.toContain(`type="module" src="/${BOOT_SCRIPT_NAME}"`)
  })

  // A RELATIVE src resolves against the route the page is on. A reload on
  // /settings/security (the sign out after "Delete my account") asked for
  // /settings/liaison-mobile-boot.js, got the SPA fallback instead, and the app
  // came up with no native bridge and no server address: the browser's sign-in
  // form, "Cannot reach the server" and "Create an account" (walk 2026-10-19,
  // #19). The boot bundle sits beside index.html at the root.
  it("loads the boot bundle from the root, whatever route the page reloads on", () => {
    const html = injectBootScript(APP_HTML)
    expect(html).toContain(`<script src="/${BOOT_SCRIPT_NAME}"></script>`)
    const src = html.match(/<script src="([^"]+)"><\/script>/)?.[1] ?? ""
    expect(new URL(src, "capacitor://localhost/settings/security").pathname).toBe(
      `/${BOOT_SCRIPT_NAME}`,
    )
  })

  it("is idempotent, so a re-sync does not stack script tags", () => {
    const once = injectBootScript(APP_HTML)
    expect(injectBootScript(once)).toBe(once)
  })

  it("refuses an index.html with no head rather than shipping an unwired app", () => {
    expect(() => injectBootScript("<html><body>nothing</body></html>")).toThrow()
  })
})

describe("the native viewport", () => {
  // The real index.html the app ships, not a fixture: a viewport tag edited
  // there must still come out pinned.
  const webHtml = readFileSync(resolve(__dirname, "..", "..", "web", "index.html"), "utf8")
  const content = (html: string) =>
    html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/i)?.[1] ?? ""

  it("carries maximum-scale=1, so a focused field cannot zoom a web view that cannot be pinched back", () => {
    const pinned = content(pinViewportScale(injectBootScript(webHtml)))
    expect(pinned).toContain("maximum-scale=1")
    expect(pinned).toContain("width=device-width")
    expect(pinned).toContain("initial-scale=1")
    expect(pinned).toContain("viewport-fit=cover")
  })

  it("leaves the browser's own index.html zoomable", () => {
    expect(content(webHtml)).not.toContain("maximum-scale")
  })

  it("is idempotent", () => {
    const once = pinViewportScale(webHtml)
    expect(pinViewportScale(once)).toBe(once)
  })

  it("refuses an index.html with no viewport meta", () => {
    expect(() => pinViewportScale("<html><head></head></html>")).toThrow()
  })
})
