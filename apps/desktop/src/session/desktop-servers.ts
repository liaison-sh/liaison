// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SAVED SERVERS, published on the bridge for the page's own servers UI.
//
// apps/web draws the phone's servers group in Settings and the Servers
// switcher in the sidebar from this object (`DesktopBridge.servers`). The
// shell draws no Account menu on any OS (`account.rs`), so this is the only
// way to move between servers.
//
// Every member runs the shared handlers (`account-menu.ts`
// `defaultAccountHandlers`), and a removal is confirmed in the shell's own
// native dialog, which a page script cannot answer.

import type { DesktopServers } from "@liaison/web/lib/desktop-shell-contract"
import { defaultAccountHandlers } from "./account-menu"
import { switchServerWith } from "./server-switch"
import { askRemoveServer, listServers, setServerAddress } from "./sidecar-client"

/** The servers member of the bridge. `reload` is a test seam for sign out. */
export function buildDesktopServers(reload?: () => void): DesktopServers {
  const handlers = () => defaultAccountHandlers(reload)
  return {
    list: () => listServers(),
    async add(url: string): Promise<void> {
      await switchServerWith((outgoing) => setServerAddress(url, outgoing))
    },
    async switchTo(address: string): Promise<void> {
      await handlers().switchTo(address)
    },
    remove: (address: string) => askRemoveServer(address),
    signOut: () => handlers().signOut(),
    confirmsRemoval: true,
    beginAdd: () => handlers().add(),
  }
}
