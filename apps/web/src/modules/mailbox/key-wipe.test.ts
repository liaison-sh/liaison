// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Logout wipes this device's mailbox key handles, whether or not the user ever
// opened Mail in that session.
//
// The wipe used to hang off `mailbox-store`, whose module scope is reached only
// through the lazily loaded mail surface. In a session where the user never
// opened the mail tab, nothing registered the teardown, so yesterday's
// persisted handles survived logout. A non-extractable handle still performs
// `deriveBits`, so anything able to run script on the origin afterwards could
// unseal that mailbox with no unlock secret at all.

import { beforeEach, describe, expect, it } from "vitest"
import { _resetRegistry, teardownSession } from "~/lib/session-lifecycle"
import { clearAuth } from "~/modules/auth/auth-store"
import { registerMailboxKeyWipe, wipeMailboxDeviceKeys } from "~/modules/mailbox/key-wipe"

function storeWith(ids: string[]) {
  const map = new Map<string, unknown>(ids.map((id) => [id, { fake: "handle" }]))
  return {
    map,
    backend: {
      async put(id: string, key: unknown) {
        map.set(id, key)
      },
      async get(id: string) {
        return map.get(id)
      },
      async delete(id: string) {
        map.delete(id)
      },
      async clear() {
        map.clear()
      },
    },
  }
}

describe("mailbox key wipe", () => {
  let unregister: (() => void) | null = null
  beforeEach(() => {
    _resetRegistry()
    unregister?.()
    unregister = null
  })

  it("clears the device key store", async () => {
    const store = storeWith(["mailbox:user:1:ecdh"])
    expect(store.map.size).toBe(1)
    // biome-ignore lint/suspicious/noExplicitAny: a memory stand-in for IndexedDB
    await wipeMailboxDeviceKeys(store.backend as any)
    expect(store.map.size).toBe(0)
  })

  it("runs on logout even when the mail surface was never opened", async () => {
    const store = storeWith(["mailbox:user:1:ecdh"])
    // biome-ignore lint/suspicious/noExplicitAny: a memory stand-in for IndexedDB
    unregister = registerMailboxKeyWipe(() => store.backend as any)
    teardownSession()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.map.size).toBe(0)
  })

  // The unlock lives as long as the login: a refresh token the server refused
  // (revoked, expired, password changed elsewhere) ends the login without a
  // sign-out, and the device's handles go with it.
  it("runs when the login ends without a sign-out", async () => {
    const store = storeWith(["mailbox-session:org:user:lease"])
    // biome-ignore lint/suspicious/noExplicitAny: a memory stand-in for IndexedDB
    unregister = registerMailboxKeyWipe(() => store.backend as any)
    clearAuth()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.map.size).toBe(0)
  })
})
