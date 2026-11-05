// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION EVENTS CACHE FOLLOWS THE LOGIN (S58, batch-5 F3). Registered
// once from bootstrap, like the mailbox key wipe (mailbox/key-wipe.ts) and for
// the same reason: the cache must end with EVERY end of the login, not only
// the sign-out button.
//
// - Whose cache: the server the page talks to (the shell's address in the
//   desktop and mobile apps, the page's origin in a browser) and the signed-in
//   user. Nobody signed in, no cache. A server switch in the desktop app
//   restarts the page on the other server, which then opens its own database
//   and never the one it left.
// - A sign-out deletes it (the session teardown, session-store.ts), and so
//   does a refresh token the server refused (`onAuthCleared`), which ends the
//   login without a sign-out.
// - Another tab's sign-out (the auth broadcast) ends this tab's session too:
//   its queued writes are dropped, its cache deleted and its held transcripts
//   let go (`onLogoutBroadcast`, batch-5 F5).

import { serverAddressOverride } from "~/lib/env"
import { onAuthCleared, onLogoutBroadcast, userFromToken } from "~/modules/auth/auth-store"
import { clearDiskCache, setDiskCacheOwner } from "./session-disk-cache"
import { resetSessionData } from "./session-store"

/** The server this page talks to, as the cache names it. */
export function pageServer(): string {
  const shell = serverAddressOverride()
  if (shell) return shell
  try {
    return globalThis.location?.origin ?? ""
  } catch {
    return ""
  }
}

/** Wire the cache to the login. Returns the disconnect (tests). */
export function registerSessionCacheLifecycle(): () => void {
  setDiskCacheOwner(() => {
    const user = userFromToken()
    return user ? { server: pageServer(), userId: user.userId } : null
  })
  const offCleared = onAuthCleared(() => void clearDiskCache())
  const offBroadcast = onLogoutBroadcast(resetSessionData)
  return () => {
    offCleared()
    offBroadcast()
    setDiskCacheOwner(() => null)
  }
}
