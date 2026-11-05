// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether a passkey can open the mailbox on THIS device, asked before one is
// ever offered. A passkey that cannot work is worse than no offer: the user
// goes through a system prompt and ends on an error.
//
// No, without asking the platform:
//   * the desktop shell (Tauri): its webview has no usable WebAuthn for this
//     origin, so the ceremony fails with a NotAllowedError that reads like a
//     cancel;
//   * the native mobile shell: same, the webview is not a browser.
// Otherwise it takes a browser that has WebAuthn at all, and when the browser
// can say (`getClientCapabilities`), one that reports the PRF extension.
// A browser that cannot say is given the benefit of the doubt: the ceremony
// itself still refuses a passkey without PRF, and no wrap row is made.

import { DESKTOP_BRIDGE_KEY } from "~/lib/desktop-shell-contract"
import { isNativeShell } from "~/lib/native-bridge"

interface PublicKeyCredentialStatic {
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>
}

/** True inside a shell whose webview cannot run a passkey ceremony. */
function insideShell(): boolean {
  if (isNativeShell()) return true
  const global = globalThis as Record<string, unknown>
  if (global[DESKTOP_BRIDGE_KEY] !== undefined && global[DESKTOP_BRIDGE_KEY] !== null) return true
  return global.__TAURI__ !== undefined || global.__TAURI_INTERNALS__ !== undefined
}

/**
 * Whether this device can create and use a passkey that opens the mailbox.
 * Never throws: anything the platform will not answer counts as no.
 */
export async function passkeysUsableHere(): Promise<boolean> {
  if (insideShell()) return false
  const pkc = (globalThis as Record<string, unknown>).PublicKeyCredential as
    | PublicKeyCredentialStatic
    | undefined
  if (!pkc) return false
  if (typeof globalThis.navigator?.credentials?.get !== "function") return false
  if (typeof pkc.getClientCapabilities !== "function") return true
  try {
    const capabilities = await pkc.getClientCapabilities()
    // Browsers that list extensions name PRF `extension:prf`. A browser that
    // can say and does not say yes is not asked to try.
    return capabilities["extension:prf"] === true
  } catch {
    return true
  }
}
