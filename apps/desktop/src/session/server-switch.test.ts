// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Moving the window between saved servers, the page's half: what is handed to
// the shell, in which order, and what the page holds afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { accessToken, noteSessionToken } from "./desktop-store"
import { SERVER_ADDRESS_GLOBAL, SERVER_ADDRESS_MIRROR_KEY } from "./server-global"
import {
  enterServer,
  MACHINE_KEYS,
  NODE_SETTLE_MS,
  reconcileStorageOwner,
  replaceServerStorage,
  resetServerSwitch,
  STORAGE_OWNER_KEY,
  snapshotServerStorage,
  switchServerWith,
} from "./server-switch"
import type { OutgoingPageStorage, SwitchedServer } from "./sidecar-client"
import { recallThreadFolder, rememberThreadFolder } from "./thread-folder-memory"

const A = "https://liaison.acme.example"
const B = "https://liaison.fabrikam.example"

/**
 * The shell's half, in memory: a saved list with a current entry and the
 * storage it parks per server, exactly as `account.rs` does it.
 */
function fakeShell(current: string) {
  const parked = new Map<string, Record<string, string>>()
  const shell = {
    current,
    parked,
    calls: [] as string[],
    switchTo(address: string) {
      return async (outgoing: OutgoingPageStorage): Promise<SwitchedServer> => {
        shell.calls.push(`switch:${address}`)
        if (outgoing.owner) parked.set(outgoing.owner, outgoing.storage)
        shell.current = address
        const storage = parked.get(address) ?? {}
        parked.delete(address)
        return { address, storage }
      }
    },
  }
  return shell
}

describe("moving the window to another server", () => {
  const reload = vi.fn()
  const endLocalSession = vi.fn(async () => {})

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    reload.mockClear()
    endLocalSession.mockClear()
    resetServerSwitch()
  })
  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    noteSessionToken(null)
  })

  it("keeps the machine's own keys out of what belongs to a server", () => {
    localStorage.setItem(SERVER_ADDRESS_MIRROR_KEY, A)
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    localStorage.setItem("liaison:tabs", "[1]")
    expect(snapshotServerStorage(localStorage)).toEqual({ "liaison:tabs": "[1]" })

    replaceServerStorage(localStorage, {
      "liaison:drafts": "x",
      [SERVER_ADDRESS_MIRROR_KEY]: "https://attacker.example",
    })
    expect(localStorage.getItem("liaison:tabs")).toBeNull()
    expect(localStorage.getItem("liaison:drafts")).toBe("x")
    expect(localStorage.getItem(SERVER_ADDRESS_MIRROR_KEY)).toBe(A)
    for (const key of MACHINE_KEYS) expect(key.startsWith("liaison")).toBe(true)
  })

  // THE ISOLATION RULE, on the page's side. The folder a conversation ran in,
  // the open tabs, the runtime picked: all of it belongs to the server it was
  // written for, and the next server's page never sees it.
  it("gives each server its own page storage and brings it back on the way back", async () => {
    const shell = fakeShell(A)
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    rememberThreadFolder("thread-on-a", "/Users/me/acme")
    localStorage.setItem("liaison:tabs", '["a-ticket"]')

    await switchServerWith(shell.switchTo(B), { reload, endLocalSession })
    expect(recallThreadFolder("thread-on-a")).toBeNull()
    expect(localStorage.getItem("liaison:tabs")).toBeNull()
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBe(B)
    expect(localStorage.getItem(SERVER_ADDRESS_MIRROR_KEY)).toBe(B)
    expect((globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]).toBe(B)

    localStorage.setItem("liaison:tabs", '["b-thread"]')
    await switchServerWith(shell.switchTo(A), { reload, endLocalSession })
    expect(recallThreadFolder("thread-on-a")).toBe("/Users/me/acme")
    expect(localStorage.getItem("liaison:tabs")).toBe('["a-ticket"]')
    expect(shell.parked.get(B)).toEqual({ "liaison:tabs": '["b-thread"]' })
    expect(reload).toHaveBeenCalledTimes(2)
  })

  // A LOCAL SESSION NEVER OUTLIVES ITS SERVER. The shell stops the sidecar in
  // its command; the window then releases the conversation's claim on the
  // server being left, with that server's own bearer, before forgetting it.
  it("stops the local session after the shell agreed and before the page moves", async () => {
    const order: string[] = []
    noteSessionToken("bearer-for-a")
    const shell = fakeShell(A)
    const command = async (outgoing: OutgoingPageStorage) => {
      order.push("shell")
      return shell.switchTo(B)(outgoing)
    }
    await switchServerWith(command, {
      reload: () => order.push("reload"),
      endLocalSession: async () => {
        order.push(`release with ${accessToken()}`)
      },
    })
    expect(order).toEqual(["shell", "release with bearer-for-a", "reload"])
    expect(accessToken()).toBeNull()
  })

  // D49 F9: the shell's switch ends the node's follows (host_exit); their
  // /result reaches the server being left, with its own bearer, before the
  // claim is released and the page moves.
  it("lets the node's follows post their end to the server being left before the page moves", async () => {
    const order: string[] = []
    noteSessionToken("bearer-for-a")
    const shell = fakeShell(A)
    await switchServerWith(
      async (outgoing: OutgoingPageStorage) => {
        order.push("shell")
        return shell.switchTo(B)(outgoing)
      },
      {
        reload: () => order.push("reload"),
        endLocalSession: async () => {
          order.push("release")
        },
        settleNodeJobs: async (ms) => {
          order.push(`follows settled within ${ms} ms with ${accessToken()}`)
        },
      },
    )
    expect(order).toEqual([
      "shell",
      `follows settled within ${NODE_SETTLE_MS} ms with bearer-for-a`,
      "release",
      "reload",
    ])
    expect(NODE_SETTLE_MS).toBeLessThanOrEqual(5_000)
  })

  // B2-1 (D52): the runner once stayed fully alive through the shell's command
  // and the settle, so a freed slot started the old server's queued job under
  // the new server's address. It is frozen BEFORE the shell moves.
  it("B2-1: freezes the node before the shell's command, and thaws it when the shell refuses", async () => {
    const order: string[] = []
    const shell = fakeShell(A)
    const node = {
      freezeNodeJobs: () => order.push("freeze"),
      thawNodeJobs: () => order.push("thaw"),
      settleNodeJobs: async () => {
        order.push("settle")
      },
    }
    await switchServerWith(
      async (outgoing: OutgoingPageStorage) => {
        order.push("shell")
        return shell.switchTo(B)(outgoing)
      },
      { reload: () => order.push("reload"), endLocalSession, ...node },
    )
    expect(order).toEqual(["freeze", "shell", "settle", "reload"])
    order.length = 0
    await expect(
      switchServerWith(
        async () => {
          order.push("shell")
          throw new Error("NotALiaisonServer")
        },
        { reload: () => order.push("reload"), endLocalSession, ...node },
      ),
    ).rejects.toThrow("NotALiaisonServer")
    expect(order).toEqual(["freeze", "shell", "thaw"])
  })

  it("changes nothing at all when the shell refuses", async () => {
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    localStorage.setItem("liaison:tabs", "[1]")
    noteSessionToken("bearer-for-a")
    await expect(
      switchServerWith(
        async () => {
          throw new Error("NotALiaisonServer")
        },
        { reload, endLocalSession },
      ),
    ).rejects.toThrow("NotALiaisonServer")
    expect(endLocalSession).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(localStorage.getItem("liaison:tabs")).toBe("[1]")
    expect(accessToken()).toBe("bearer-for-a")
  })

  it("drops a sign in that was in flight against the server being left", async () => {
    sessionStorage.setItem("liaison:desktop-oauth", "verifier-for-a")
    sessionStorage.setItem("liaison-desktop:launch-link-seen", "liaison://connect?server=x")
    await switchServerWith(fakeShell(A).switchTo(B), { reload, endLocalSession })
    expect(sessionStorage.getItem("liaison:desktop-oauth")).toBeNull()
    expect(sessionStorage.getItem("liaison-desktop:launch-link-seen")).not.toBeNull()
  })

  it("leaves the page on no server when the last one was removed", () => {
    localStorage.setItem(SERVER_ADDRESS_MIRROR_KEY, A)
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    localStorage.setItem("liaison:tabs", "[1]")
    enterServer({ address: null, storage: {} })
    expect(localStorage.getItem(SERVER_ADDRESS_MIRROR_KEY)).toBeNull()
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBeNull()
    expect(localStorage.getItem("liaison:tabs")).toBeNull()
  })

  it("runs one switch at a time", async () => {
    let release: (value: SwitchedServer) => void = () => {}
    const first = switchServerWith(
      () =>
        new Promise<SwitchedServer>((resolve) => {
          release = resolve
        }),
      { reload, endLocalSession },
    )
    await expect(
      switchServerWith(fakeShell(A).switchTo(B), { reload, endLocalSession }),
    ).rejects.toThrow("SwitchInProgress")
    release({ address: B, storage: {} })
    await first
  })
})

describe("a window that died half way through a switch", () => {
  const reload = vi.fn()
  beforeEach(() => {
    localStorage.clear()
    reload.mockClear()
  })

  it("adopts the current server when the storage predates the marker", async () => {
    localStorage.setItem("liaison:tabs", "[1]")
    const switchTo = vi.fn()
    await expect(reconcileStorageOwner(A, switchTo, { reload })).resolves.toBe("adopted")
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBe(A)
    expect(localStorage.getItem("liaison:tabs")).toBe("[1]")
    expect(switchTo).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("hands the previous server its storage back and takes the current one's", async () => {
    const shell = fakeShell(B)
    shell.parked.set(B, { "liaison:tabs": '["b"]' })
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    localStorage.setItem("liaison:tabs", '["a"]')
    const result = await reconcileStorageOwner(
      B,
      (address, outgoing) => shell.switchTo(address)(outgoing),
      { reload },
    )
    expect(result).toBe("repaired")
    expect(shell.parked.get(A)).toEqual({ "liaison:tabs": '["a"]' })
    expect(localStorage.getItem("liaison:tabs")).toBe('["b"]')
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBe(B)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  // S58 (batch-5 F3): a server gone from the list takes its cached session transcripts.
  it("clears the storage of a server gone from the list, and deletes its cached session events", async () => {
    const { sessionCacheDbName } = await import("@liaison/web/modules/sessions/session-cache-db")
    const deleted: string[] = []
    const g = globalThis as Record<string, unknown>
    const had = g.indexedDB
    g.indexedDB = {
      databases: async () => [
        { name: sessionCacheDbName(A, "u1") },
        { name: sessionCacheDbName(B, "u1") },
      ],
      deleteDatabase: (name: string) => {
        deleted.push(name)
        const req: { onsuccess?: () => void } = {}
        queueMicrotask(() => req.onsuccess?.())
        return req
      },
    }
    try {
      localStorage.setItem(STORAGE_OWNER_KEY, A)
      localStorage.setItem("liaison:tabs", '["a"]')
      await expect(reconcileStorageOwner(null, vi.fn(), { reload })).resolves.toBe("cleared")
      expect(localStorage.getItem("liaison:tabs")).toBeNull()
      expect(deleted).toEqual([sessionCacheDbName(A, "u1")])
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      g.indexedDB = had
    }
  })

  it("does nothing when the storage is already the current server's", async () => {
    localStorage.setItem(STORAGE_OWNER_KEY, A)
    await expect(reconcileStorageOwner(A, vi.fn(), { reload })).resolves.toBe("unchanged")
    expect(reload).not.toHaveBeenCalled()
  })
})
