// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AppUIContext } from "./types"

interface IframeChannel {
  /**
   * Post a message to the host frame. Must be a `window.postMessage`-style
   * function; `targetOrigin` is passed to restrict delivery to the expected
   * host origin and prevent message interception by third-party frames.
   */
  postMessage: (msg: string, targetOrigin: string) => void
  /**
   * The allowed origin of the host frame — used as `targetOrigin` in
   * `postMessage` calls so messages are only delivered to the expected parent.
   * MUST be a concrete `scheme://host[:port]` origin; the wildcard `"*"`,
   * empty strings, and path-bearing values are rejected at bridge
   * construction (`createIframeBridge` throws). `"*"` is permitted only when
   * `globalThis.LIAISON_DEV === true` (local development).
   */
  targetOrigin: string
}

/**
 * A concrete, postMessage-safe origin is `scheme://host[:port]` with no path,
 * query, or fragment — e.g. `https://app.example.com` or `http://localhost:5173`.
 * The wildcard `"*"` (which broadcasts payloads to ANY origin and leaks them to
 * a malicious parent frame), the empty string, and anything path-bearing are
 * rejected. The lone exception is the explicit `LIAISON_DEV` global, set only in
 * local development, which permits `"*"`.
 */
function assertConcreteTargetOrigin(targetOrigin: string): void {
  // Dev escape hatch: an explicit global flag (never set in production bundles)
  // allows the permissive `"*"` wildcard for local cross-origin iframing.
  const devAllowed =
    typeof globalThis !== "undefined" &&
    (globalThis as { LIAISON_DEV?: boolean }).LIAISON_DEV === true
  if (targetOrigin === "*" && devAllowed) return

  if (typeof targetOrigin !== "string" || targetOrigin.length === 0) {
    throw new Error(
      "createIframeBridge: targetOrigin must be a concrete origin (scheme://host[:port]); got empty/invalid value",
    )
  }
  if (targetOrigin === "*") {
    throw new Error(
      'createIframeBridge: targetOrigin "*" broadcasts messages to any origin and is forbidden outside development (set globalThis.LIAISON_DEV = true to opt in locally)',
    )
  }
  // Must parse as a URL AND be origin-only (no path/query/fragment, no userinfo).
  let url: URL
  try {
    url = new URL(targetOrigin)
  } catch {
    throw new Error(
      `createIframeBridge: targetOrigin must be a concrete origin (scheme://host[:port]); got ${targetOrigin}`,
    )
  }
  const originOnly = `${url.protocol}//${url.host}`
  if (!url.host || originOnly !== targetOrigin) {
    throw new Error(
      `createIframeBridge: targetOrigin must be a bare origin (scheme://host[:port]) with no path/query/fragment; got ${targetOrigin}`,
    )
  }
}

export function createIframeBridge(channel: IframeChannel): AppUIContext {
  // Reject a wildcard/empty/non-origin targetOrigin up front: a caller-controlled
  // `"*"` would broadcast every postMessage payload cross-origin (interceptable
  // by a malicious parent frame). Fail loudly at bridge construction.
  assertConcreteTargetOrigin(channel.targetOrigin)

  function send(type: string, payload: unknown): void {
    channel.postMessage(JSON.stringify({ type, payload }), channel.targetOrigin)
  }

  return {
    openTab(type, entityId, label) {
      send("openTab", { tabType: type, entityId, label })
    },
    closeTab() {
      send("closeTab", {})
    },
    showToast(message, variant) {
      send("toast", { message, variant })
    },
  }
}
