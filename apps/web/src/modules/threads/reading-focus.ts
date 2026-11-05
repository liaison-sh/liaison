// SPDX-License-Identifier: FSL-1.1-ALv2
//
// IS THE USER LOOKING AT THIS WINDOW? The question every automatic read mark
// asks before it tells the server a conversation was read. A visible page is
// not enough: a desktop window left open on a conversation behind other apps,
// or on a Mac nobody is in front of, keeps its page `visible` (macOS reports
// an occluded window as visible). Marking read there took the unread pill off
// every other device of the reader, the phone in their hand included, before
// they had seen the message. The window has to have the focus as well.
//
// A phone app has no window focus to lose: in the foreground it is the
// screen, so visible is enough there.

import { isNativeShell } from "~/lib/native-bridge"
import { isDesktop } from "~/modules/desktop/desktop-store"

export function userIsLookingAtWindow(): boolean {
  if (typeof document === "undefined") return false
  if (document.visibilityState !== "visible") return false
  if (isNativeShell() && !isDesktop()) return true
  return typeof document.hasFocus !== "function" || document.hasFocus()
}
