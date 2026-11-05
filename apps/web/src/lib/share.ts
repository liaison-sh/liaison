// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handing something to whatever else the device can send it with.
//
// THREE ROUTES, IN ONE ORDER. The native shell's share sheet is the best of
// them: it reaches the messaging apps, the notes app and AirDrop, which is
// what a person on a phone means by "send this to someone". A browser that
// implements `navigator.share` (every mobile browser, and Safari on the
// desktop) is the same thing one layer up. Everything left is a desktop
// browser, where the honest answer is the clipboard, and the caller says so.
//
// A CANCEL IS NOT A FAILURE. Opening the sheet and deciding against it rejects
// with an `AbortError`, and falling through to the clipboard there would copy
// a link the user had just declined to send. So a cancel ends the attempt.
import { serverAddressOverride } from "~/lib/env"
import { nativeBridge, type SharePayload } from "~/lib/native-bridge"

export type { SharePayload }

export type ShareOutcome =
  /** Handed to the platform's share sheet. */
  | "shared"
  /** No sheet anywhere: the link is on the clipboard instead. */
  | "copied"
  /** The user dismissed the sheet. Nothing happened, on purpose. */
  | "cancelled"
  /** Nothing on this page can share or copy. */
  | "unavailable"

function bridgeShare(): ((payload: SharePayload) => Promise<void>) | null {
  const bridge = nativeBridge()
  const fn = bridge?.share
  return typeof fn === "function" ? fn.bind(bridge) : null
}

function webShare(): ((data: ShareData) => Promise<void>) | null {
  if (typeof navigator === "undefined") return null
  const fn = (navigator as Navigator).share
  return typeof fn === "function" ? fn.bind(navigator) : null
}

/** Whether anything on this page can share or, failing that, copy. */
export function canShare(): boolean {
  if (bridgeShare() !== null || webShare() !== null) return true
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function"
}

function wasCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

/** The one line the clipboard fallback leaves behind: the link, or the text. */
export function shareFallbackText(payload: SharePayload): string {
  return payload.url ?? payload.text ?? payload.title ?? ""
}

export async function share(payload: SharePayload): Promise<ShareOutcome> {
  const native = bridgeShare()
  if (native !== null) {
    try {
      await native(payload)
      return "shared"
    } catch (error) {
      if (wasCancelled(error)) return "cancelled"
      // A shell whose plugin is missing falls through to the web routes: on
      // Android the Capacitor share can reject where `navigator.share` works.
    }
  }

  const web = webShare()
  if (web !== null) {
    try {
      await web({ title: payload.title, text: payload.text, url: payload.url })
      return "shared"
    } catch (error) {
      if (wasCancelled(error)) return "cancelled"
    }
  }

  const text = shareFallbackText(payload)
  if (text !== "" && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return "copied"
    } catch {
      // A clipboard refused by permissions, which is a desktop browser thing.
    }
  }
  return "unavailable"
}

/**
 * The absolute address of an in-app path, for a link that has to survive
 * leaving the app.
 *
 * `window.location.origin` is NOT it inside a native shell: the page is served
 * from `capacitor://localhost`, so a link built from it names a scheme only
 * this handset's app understands and nothing else can open. The deployment's
 * own origin is what the shell published (lib/env.ts), and it is also the host
 * the universal-link association is registered against, so the link reopens
 * the app on a device that has it and the web app on one that does not.
 */
export function appLink(routePath: string): string {
  const origin =
    serverAddressOverride() ?? (typeof window === "undefined" ? "" : window.location.origin)
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`
  return `${origin}${path}`
}
