// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WEBVIEW'S CONTENT SECURITY POLICY, PINNED FROM THIS SIDE.
//
// `src-tauri/**` is frozen for the slice that moved the desktop UI into
// apps/web (A33), and the CSP is the one line in it that a rendering change
// could be tempted to widen: a component that needs an inline worker, a font
// from a CDN or an `eval` would be one edit away from a policy nobody reads
// again. So the shipped string is written out here, byte for byte, and this
// test reads the conf and compares. It asserts nothing about what the policy
// SHOULD be: it asserts that what ships is what was reviewed, and a single
// character changed on either side fails it.
//
// Widening it is not forbidden, it is deliberate: an intentional change edits
// the conf AND this literal, in one commit a reviewer can read.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// TIGHTENED (D11): `script-src` back to the web build's own policy
// (`'self'` plus 'wasm-unsafe-eval'). No inline script beyond the hashes Tauri
// pins for index.html, no script from any https host: an installed app's UI
// bundle no longer runs in the page on the server's word. Any app's UI runs in
// a sandboxed frame on the shell's own `liaison-frame:` scheme
// (src-tauri/src/app_frame.rs), which `frame-src` names, and which has no
// bridge and no network of its own.

// WIDENED DELIBERATELY (S13, A8): `script-src` names the shell's own
// `liaison-app:` scheme (`http://liaison-app.localhost` on Windows, where
// WebView2 has no custom schemes), and nothing remote: the scheme serves only
// first-party UI bundles the SHELL verified against the app-signing keys
// compiled into it, by their sha256, and 404s anything else
// (src-tauri/src/verified_apps.rs). Not `blob:`, not `https:`: the bytes that
// run are the bytes the shell checked, whatever the server sends later.

// WIDENED DELIBERATELY (mailbox KDF, 2fc7cd423): WebKit refuses WebAssembly
// under a script-src without 'wasm-unsafe-eval', and the blob crypto worker
// inherits the policy, so an Argon2id mailbox password could never open the
// mailbox in the desktop app. 'wasm-unsafe-eval' allows compiling WebAssembly
// only; string eval stays blocked.

// TIGHTENED: `base-uri 'self'` and `form-action 'self'`. Neither falls back to
// default-src, so without them an injected <base> or <form> could point relative
// script URLs or a submission at another origin.

/** The shipped policy, `src-tauri/tauri.conf.json` at `app.security.csp`. */
const SHIPPED_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' liaison-app: http://liaison-app.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; connect-src 'self' https: http://localhost:* ws: wss: ipc: http://ipc.localhost; frame-src 'self' blob: data: liaison-frame: http://liaison-frame.localhost; object-src 'none'"

const CONF_PATH = join(import.meta.dirname, "../src-tauri/tauri.conf.json")

describe("the desktop webview's policy pin", () => {
  it("the webview CSP is byte identical to the shipped string", () => {
    const conf = JSON.parse(readFileSync(CONF_PATH, "utf8")) as {
      app?: { security?: { csp?: unknown } }
    }
    expect(conf.app?.security?.csp).toBe(SHIPPED_CSP)
  })
})
