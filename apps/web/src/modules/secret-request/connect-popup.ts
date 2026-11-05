// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The window a connect card opens the provider's consent in, and the way back
// from a consent that ran in this tab.
//
// The popup is opened in the click itself, empty, before the server answers
// the provider's URL: a popup opened after an await is blocked by every
// browser. Its `opener` is cut before it navigates anywhere, so the provider's
// pages (or anything they lead to) cannot reach back into this window
// (reverse tabnabbing); the card learns the result from the server, never
// from the popup.

import { type ConnectFailureReason, connectFailureReason } from "@liaison/shared"

/** What the card does with the popup: send it on, watch it close, close it. */
export interface ConnectPopup {
  readonly closed: boolean
  close: () => void
  location: { href: string }
}

/** The consent popup: a window of its own, sized for a provider's sign-in page. */
const FEATURES = "popup,width=520,height=720"

/** Open the empty popup for one card, with no way back to this window, or null when blocked. */
export function openConnectPopup(requestId: string): ConnectPopup | null {
  const popup = window.open("about:blank", `liaison-connect-${requestId}`, FEATURES)
  if (popup) popup.opener = null
  return popup
}

/** The parameters a failed same-tab consent comes back with (connectCardReturnUrl). */
const RETURN_PARAMS = ["connect_request", "oauth_error", "oauth_error_description"] as const

/**
 * A same-tab consent that failed for this card: its reason, once. The
 * parameters are removed from the address so a reload does not show it again.
 */
export function takeConnectReturn(requestId: string): ConnectFailureReason | null {
  const url = new URL(window.location.href)
  if (url.searchParams.get("connect_request") !== requestId) return null
  const reason = connectFailureReason(url.searchParams.get("oauth_error"))
  for (const name of RETURN_PARAMS) url.searchParams.delete(name)
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  return reason
}
