// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PHONE MAIN PAGE'S CONTENT SECURITY POLICY, PINNED.
//
// The phone wraps apps/web's own index.html, so its policy is a meta tag the
// build writes into the synced copy (scripts/boot-injection.ts). This test
// pins that string byte for byte, like apps/desktop/src/csp-pin.test.ts does
// for the desktop webview: it asserts that what ships is what was reviewed. An
// intentional change edits the policy AND this literal, in one commit.
//
// It mirrors the desktop main page's policy without the Tauri schemes (ipc:,
// liaison-frame:) and without 'wasm-unsafe-eval' (the native build carries no
// WebAssembly; build-mobile.ts refuses any). `script-src 'self'` only: the
// boot bundle and the web build's assets, never an inline script and never a
// server origin. An installed app's UI runs in the sandboxed frame
// (`/app-frame.html`, same origin, hence `frame-src 'self'`) or not at all.
// `connect-src https: wss:` is the server the user binds at first launch,
// chosen at runtime; `http://localhost:*` / `ws://localhost:*` a local
// development server. The Capacitor bridge is a document-start script the
// native side installs, outside the page's policy.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  applyMobileCsp,
  injectBootScript,
  inlineScripts,
  MOBILE_CSP,
  pinViewportScale,
} from "../scripts/boot-injection"

const SHIPPED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; connect-src 'self' https: wss: http://localhost:* ws://localhost:*; frame-src 'self' blob: data:; object-src 'none'"

const webHtml = readFileSync(resolve(import.meta.dir, "..", "..", "web", "index.html"), "utf8")

/** The synced index.html exactly as build-mobile.ts writes it. */
function shipped() {
  return applyMobileCsp(pinViewportScale(injectBootScript(webHtml)))
}

describe("the phone main page's policy pin", () => {
  it("the policy is byte identical to the reviewed string", () => {
    expect(MOBILE_CSP).toBe(SHIPPED_CSP)
  })

  it("the synced index.html carries it as the first element of <head>", () => {
    const { html } = shipped()
    const meta = `<meta http-equiv="Content-Security-Policy" content="${SHIPPED_CSP}">`
    expect(html).toMatch(/<head[^>]*>/i)
    const headEnd =
      (html.match(/<head[^>]*>/i)?.index ?? 0) + (html.match(/<head[^>]*>/i)?.[0].length ?? 0)
    expect(html.slice(headEnd, headEnd + meta.length)).toBe(meta)
  })

  it("the synced index.html has no inline script left, the import map included", () => {
    expect(inlineScripts(webHtml).length).toBeGreaterThan(0)
    const { html } = shipped()
    expect(inlineScripts(html)).toEqual([])
    expect(html).not.toContain("importmap")
  })

  it("an inline script moves to a root file the page loads in its place, still before the app entry", () => {
    const { html, files } = shipped()
    expect(files.length).toBe(1)
    const [file] = files
    expect(file.content).toContain("liaison:theme")
    const tag = `<script src="/${file.name}"></script>`
    expect(html).toContain(tag)
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("/src/index.tsx"))
  })

  it("is idempotent, so a re-sync writes the same page", () => {
    const once = shipped()
    const twice = applyMobileCsp(once.html)
    expect(twice.html).toBe(once.html)
    expect(twice.files).toEqual([])
  })
})
