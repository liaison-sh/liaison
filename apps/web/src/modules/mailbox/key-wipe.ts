// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The logout wipe for this device's mailbox key handles.
//
// It lives in its own module, registered from `startup.ts`, for one reason: the
// crypto session's own wipe runs from `mailbox-store`, and that module is only
// ever loaded through the lazily loaded mail surface. A session where the user
// never opened Mail registered no teardown at all, so handles persisted by an
// EARLIER session outlived the logout. A non-extractable handle still performs
// `deriveBits`: whatever can run script on this origin afterwards could unseal
// that mailbox without any unlock secret.
//
// It deletes RECORDS, not just in-memory state, and it is safe to run when
// there is nothing to wipe.

import {
  createIndexedDbKeyStore,
  type KeyStoreBackend,
  wipePersistedKeys,
} from "@liaison/mailbox-crypto/src/client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { onAuthCleared } from "~/modules/auth/auth-store"

export async function wipeMailboxDeviceKeys(store?: KeyStoreBackend): Promise<void> {
  try {
    await wipePersistedKeys(store ?? createIndexedDbKeyStore())
  } catch {
    // A browser with blocked site data has nothing to wipe. Logout must not
    // fail on it.
  }
}

/**
 * Register the wipe for this session. Called from `startup.ts`, which is
 * eagerly loaded, so the registration does not depend on which tabs the user
 * happened to open.
 */
export function registerMailboxKeyWipe(store?: () => KeyStoreBackend): () => void {
  const wipe = () => {
    void wipeMailboxDeviceKeys(store?.())
  }
  // A sign-out, and every other end of the login: a refresh token the server
  // refused (revoked, expired) clears the auth without a sign-out, and the
  // unlock lives exactly as long as the login does.
  const offTeardown = onSessionTeardown(wipe)
  const offCleared = onAuthCleared(wipe)
  return () => {
    offTeardown()
    offCleared()
  }
}
