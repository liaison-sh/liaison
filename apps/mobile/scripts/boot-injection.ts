// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How apps/mobile's own boot code gets to run inside a bundle it does not own.
//
// apps/web is wrapped UNMODIFIED: there is no import hook in it for a native
// shell to hang things off, and adding one would make the web app carry mobile
// code. So the boot bundle is injected into the COPY `cap sync` just made,
// after the sync and before anything is shipped: the source tree is untouched,
// the synced artifact carries one extra classic script, and it runs before the
// app's own deferred module entry.
//
// This is the Capacitor equivalent of what the desktop shell does with its
// overlay (`initialization_script`, apps/desktop/src-tauri).

import { createHash } from "node:crypto"

/** The boot bundle's file name inside the synced assets. */
export const BOOT_SCRIPT_NAME = "liaison-mobile-boot.js"

// ROOT-ABSOLUTE. The bundle sits beside index.html, and a relative src resolves
// against the route the page is (re)loaded on: a reload on /settings/security
// asked for /settings/liaison-mobile-boot.js, got the SPA fallback, and the app
// came up with no native bridge and no server address.
const TAG = `<script src="/${BOOT_SCRIPT_NAME}"></script>`

/**
 * `html` with the boot script as the first thing in `<head>`. Idempotent: a
 * re-sync rewrites the same file, and a stack of identical script tags is the
 * kind of thing nobody notices until one of them runs twice.
 */
export function injectBootScript(html: string): string {
  if (html.includes(TAG)) return html
  const head = html.match(/<head[^>]*>/i)
  if (!head) {
    throw new Error("the synced index.html has no <head> to inject the mobile boot script into")
  }
  const at = (head.index ?? 0) + head[0].length
  return html.slice(0, at) + TAG + html.slice(at)
}

/**
 * The viewport the NATIVE app runs under: the web app's own, plus
 * `maximum-scale=1`.
 *
 * iOS zooms the page when a field under 16px takes focus, and inside the
 * Capacitor web view that zoom is permanent: Capacitor disables the pinch
 * gesture as soon as any zoom begins (`scrollViewWillBeginZooming` in
 * WebViewDelegationHandler.swift), so nothing can bring the page back to 1:1
 * and every screen stays enlarged, cut off on the right and under the tab bar.
 * A web view that cannot be pinched loses nothing by also refusing the focus
 * zoom. Only the SYNCED copy carries it: a browser keeps pinch zoom.
 */
export function pinViewportScale(html: string): string {
  const meta = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["'][^>]*>/i)
  if (!meta) {
    throw new Error("the synced index.html has no viewport meta to pin the native scale on")
  }
  const parts = meta[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^(maximum-scale|user-scalable)\s*=/i.test(part))
  parts.push("maximum-scale=1")
  const pinned = meta[0].replace(meta[1], parts.join(", "))
  return html.replace(meta[0], pinned)
}

/**
 * The phone main page's Content Security Policy, written into the synced
 * index.html as its first `<head>` element (pinned by src/csp-pin.test.ts).
 * The desktop main page's policy minus the Tauri schemes and WebAssembly:
 * scripts from the app's own assets only, never inline, never from a server.
 */
export const MOBILE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
].join("; ")

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${MOBILE_CSP}">`

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi

/** The bodies of the page's inline (src-less) scripts, import maps included. */
export function inlineScripts(html: string): string[] {
  const bodies: string[] = []
  for (const m of html.matchAll(SCRIPT_TAG)) {
    if (!/\bsrc\s*=/i.test(m[1] ?? "")) bodies.push(m[2] ?? "")
  }
  return bodies
}

/** A script `applyMobileCsp` moved out of the page, to write beside index.html. */
export interface ExtractedScript {
  name: string
  content: string
}

/**
 * `html` under the phone's policy: the CSP meta first in `<head>`, every
 * inline script moved to a root file the page loads in the same place (so a
 * pre-paint script still runs before the first paint), and the import map
 * dropped. The import map serves only installed apps' UI bundles imported into
 * the page, which a shell never does (an installed app's UI runs in the frame,
 * whose document carries its own). Idempotent.
 */
export function applyMobileCsp(html: string): { html: string; files: ExtractedScript[] } {
  const files: ExtractedScript[] = []
  let out = html.replace(SCRIPT_TAG, (tag, attrs: string, body: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return tag
    if (/\btype\s*=\s*["']?importmap/i.test(attrs)) return ""
    const name = `liaison-inline-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.js`
    files.push({ name, content: body })
    const type = /\btype\s*=\s*["']?module/i.test(attrs) ? ' type="module"' : ""
    return `<script${type} src="/${name}"></script>`
  })
  out = out.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "")
  const head = out.match(/<head[^>]*>/i)
  if (!head) throw new Error("the synced index.html has no <head> to carry the phone's policy")
  const at = (head.index ?? 0) + head[0].length
  return { html: out.slice(0, at) + CSP_META + out.slice(at), files }
}
