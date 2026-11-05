// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A FIRST-PARTY APP'S UI, VERIFIED BY THE DESKTOP SHELL, IN THE PAGE (S13, A9).
//
// The window's page holds the shell's bridge, so it runs a server-delivered
// bundle only when the SHELL vouches for the exact bytes: the server lists the
// app `signed: true`, the shell fetches its `ui.js` and signed statement from
// the bound server itself, verifies them against the keys compiled into it
// (apps/desktop/src-tauri/src/app_signing.rs) and serves the bytes it checked
// on `liaison-app:` by sha256, the one script source the window's policy adds.
// The page imports that URL and registers the app from the manifest the
// statement vouches for and nothing of the API's copy (routes, kind, settings,
// icon...): when the two disagree on what the app is or draws, the app runs in
// the frame instead.
//
// Desktop only. The phone frames every server UI (D7): its shell publishes no
// verifier, so `verifiedFirstPartyApp` answers null there, as it does in an
// older desktop shell and in a browser (which imports from its own origin).

import { canonicalJson } from "@liaison/shared"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"

/** The import every app UI goes through: one seam, so tests see what loads. */
export function importAppModule(url: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ url)
}

/** The scheme the desktop shell serves verified bundles on, in either URL form. */
export function isVerifiedAppUrl(url: string): boolean {
  return (
    /^liaison-app:\/\/localhost\/[0-9a-f]{64}\.js$/.test(url) ||
    /^http:\/\/liaison-app\.localhost\/[0-9a-f]{64}\.js$/.test(url)
  )
}

/** What decides an app's presence: these must agree between the API and the statement. */
const PRESENCE_KEYS = ["name", "version", "views"] as const

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null)
}

/**
 * What an in-page app registers from: the SIGNED manifest and nothing of the
 * server's (A9), with the two defaults the server's app list applies to every
 * manifest (`kind` "app", the publisher shown as `author`), so a verified app
 * reads the same as it would from the list.
 */
export function inPageManifest(signed: Record<string, unknown>): Record<string, unknown> {
  return {
    ...signed,
    kind: signed.kind ?? "app",
    author: signed.publisher ?? signed.author,
  }
}

export interface VerifiedLoad {
  url: string
  manifest: Record<string, unknown>
}

/**
 * The verified bundle URL and the manifest to register `name@version` from,
 * or null: no verifier (browser, phone, older shell), a refusal, or an API
 * manifest that disagrees with the signed one. Never throws.
 */
export async function verifiedFirstPartyApp(
  name: string,
  version: string,
  apiManifest: Record<string, unknown> | null,
): Promise<VerifiedLoad | null> {
  const bridge = getDesktopBridge()
  if (!bridge || typeof bridge.verifyFirstPartyApp !== "function") return null
  let verified: Awaited<ReturnType<NonNullable<typeof bridge.verifyFirstPartyApp>>>
  try {
    verified = await bridge.verifyFirstPartyApp(name, version)
  } catch {
    return null
  }
  if (!verified || !isVerifiedAppUrl(verified.url)) return null
  const signed = verified.manifest
  if (signed.name !== name || signed.version !== version) return null
  const api = apiManifest ?? {}
  const disagree = PRESENCE_KEYS.filter((key) => !sameJson(api[key], signed[key]))
  if (disagree.length > 0) {
    console.warn(
      `Manifest app "${name}": the server's manifest differs from the signed one (${disagree.join(", ")}): runs in the frame`,
    )
    return null
  }
  return { url: verified.url, manifest: inPageManifest(signed) }
}
