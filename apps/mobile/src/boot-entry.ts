// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The boot bundle's ENTRY, and the only file that starts anything by being
// loaded. main.ts holds the sequence; this file runs it.
//
// The split is not decoration. A module that boots the app as a side effect of
// being imported also boots it inside every test that imports the sequence to
// test it: the app renders into the test's DOM and calls the network, and the
// failure lands in whichever unrelated test file happened to run next.

import { attachRefreshBridge, LOGOUT_PATH } from "./auth/refresh-bridge"
import { createBootRestart } from "./boot/boot-restart"
import { publishMirroredServerAddress } from "./boot/server-global"
import { publishNativeBridge } from "./bridge/native-bridge"
import { deepLinkQueue } from "./deep-link"
import {
  accessTokenStore,
  boundDeviceId,
  capacitorPush,
  capacitorUrlListener,
  confirmedServerOrigin,
  domReady,
  onOtherServerLink,
  preferencesRefreshStore,
  preferencesStorage,
  refreshPushRegistration,
  runSessionEndHandlers,
  serverList,
  serverOriginSettled,
  startBoot,
} from "./main"
import { installNativeShelf } from "./native/shelf"
import { createFirstLaunch } from "./onboarding/server-address"
import { createNativeServers, reconcilePageStorage } from "./servers/server-list"

if (typeof document !== "undefined") {
  // BEFORE THE WRAPPED APP'S MODULE ENTRY, same rule as the server address
  // below: the web app reads the bridge while it boots, and a member added
  // after that read is a member it never sees (bridge/native-bridge.ts).
  installNativeShelf(globalThis)

  // FIRST LINE, NO AWAIT BEFORE IT. The wrapped app's module entry runs the
  // moment this script yields, and it reads the server address global while
  // building its first request; the Preferences read below cannot answer that
  // early, so the synchronous mirror does (boot/server-global.ts).
  publishMirroredServerAddress(globalThis)

  // The BOOT restart (an unbound start, a stale mirror, another server's page
  // storage) goes back to the route the page started on, captured now, before
  // the app's modules run: by restart time the unbound app has already bounced
  // itself to /login, and a plain reload kept the user there with a live
  // session (boot/boot-restart.ts).
  const reload = createBootRestart(globalThis.location)
  // A server change starts the page at a given route (servers/server-list.ts);
  // `replace` so the route left behind is not a Back step into the old server.
  const restart = (path?: string) => {
    if (path === undefined) globalThis.location.reload()
    else globalThis.location.replace(path)
  }

  void startBoot({
    queue: deepLinkQueue,
    addUrlListener: capacitorUrlListener,
    whenAppReady: domReady,
    firstLaunch: createFirstLaunch({ storage: preferencesStorage, document }),
    attachBridge: () =>
      attachRefreshBridge(globalThis as never, {
        // The CONFIRMED origin, not the published one: the global may still
        // hold the synchronous boot hint, which page script can write, and the
        // refresh token is never presented to a hint (main.ts).
        serverOrigin: confirmedServerOrigin,
        store: preferencesRefreshStore,
        // The bearer the push client waits for. Taken from the answers the
        // app is already getting, never minted a second time.
        accessTokens: accessTokenStore,
        // The app refreshes in its first tick; Preferences answer later.
        serverOriginSettled,
        // Sign-out, with the bearer still live: the push registration is
        // revoked here or never (main.ts).
        onSessionEnd: runSessionEndHandlers,
        // The logout names this device, so its receipt credential is revoked.
        deviceId: boundDeviceId,
      }),
    reload,
    startPush: capacitorPush,
    migrate: () => serverList.migrate(),
    reconcileStorage: (address) =>
      reconcilePageStorage(address, serverList, globalThis.localStorage ?? null, reload),
  })

  // THE SAVED SERVERS, for the settings screen (apps/web reads them off the
  // native bridge and renders nothing in a browser). Every move between them
  // swaps the page's own storage and KEEPS this phone's push registration on
  // the server being left, so every signed-in server keeps notifying it
  // (servers/server-list.ts).
  const nativeServers = createNativeServers({
    list: serverList,
    pageStorage: globalThis.localStorage ?? null,
    sessionStorage: globalThis.sessionStorage ?? null,
    endSession: runSessionEndHandlers,
    // The page's own sign out, through the refresh bridge: it presents the
    // token, revokes the push row and forgets the token for this server only.
    signOut: async () => {
      const origin = confirmedServerOrigin()
      if (origin) {
        await globalThis.fetch(`${origin}${LOGOUT_PATH}`, { method: "POST" }).catch(() => undefined)
      }
      accessTokenStore.set(null)
      try {
        globalThis.localStorage?.removeItem("liaison:session")
      } catch {
        // The next refresh has no token, which ends the session anyway.
      }
    },
    reload: restart,
    // An added or removed server changes whether pushes name their organisation.
    serversChanged: refreshPushRegistration,
  })
  publishNativeBridge(globalThis, { servers: nativeServers })
  // A tap on a notification from another saved server opens that server.
  onOtherServerLink((server, link) => nativeServers.openOn(server, link))
}
