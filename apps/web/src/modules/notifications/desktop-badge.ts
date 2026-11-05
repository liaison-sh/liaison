// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP APP ICON'S BADGE: the page reads THE badge (app-badge-store.ts,
// rule 6: the same number as the phone, the tab title and Home) and hands it to the shell
// (`setUnreadBadge` on the desktop bridge), which puts it on the dock tile
// (macOS), the launcher entry (Linux) or a taskbar overlay (Windows). Zero
// clears it, and the first reading is sent even when it is zero, so a badge
// left from an earlier session comes down. In a browser, or a shell too old
// to offer the call, nothing happens: the tab badge (tab-badge.ts) is there.

import { createEffect, createRoot } from "solid-js"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { appBadgeCount } from "~/modules/notifications/app-badge-store"

let disposeRoot: (() => void) | null = null

/** Starts mirroring the count onto the app icon. Idempotent. */
export function startDesktopBadge(): void {
  if (disposeRoot) return
  const shell = getDesktopBridge()
  const setBadge = shell?.setUnreadBadge?.bind(shell)
  if (!setBadge) return
  let sent: number | null = null
  disposeRoot = createRoot((dispose) => {
    createEffect(() => {
      const count = appBadgeCount()
      if (count === sent) return
      sent = count
      try {
        void setBadge(count).catch(() => undefined)
      } catch {
        // A broken shell costs the badge, never the page.
      }
    })
    return dispose
  })
}

/** Test access to this module's private state. Production code never calls it. */
export const DesktopBadgeTestAccess = {
  reset(): void {
    disposeRoot?.()
    disposeRoot = null
  },
}
