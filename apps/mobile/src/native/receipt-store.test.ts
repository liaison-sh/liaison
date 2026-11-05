// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The JS face of the native receipt store (LiaisonNativePlugin.swift +
// NotificationService/ReceiptStore.swift): credentials in the shared keychain
// group keyed by server origin, the offline queue as one JSON file per receipt
// in the App Group container, and the debug-only forced register failure.

import { describe, expect, it } from "bun:test"
import { createNativeReceiptStore, type ReceiptStorePlugin } from "./receipt-store"

function fakePlugin() {
  const keychain = new Map<string, { credential: string; deviceId: string }>()
  const files = new Map<string, string>()
  let forced = 0
  let seq = 0
  const plugin: ReceiptStorePlugin = {
    receiptCredentialGet: async ({ origin }) => keychain.get(origin) ?? {},
    receiptCredentialSet: async ({ origin, credential, deviceId }) => {
      keychain.set(origin, { credential, deviceId })
    },
    receiptCredentialDelete: async ({ origin }) => {
      keychain.delete(origin)
    },
    receiptQueueList: async () => ({
      entries: [...files].map(([key, json]) => ({ key, json })),
    }),
    receiptQueueRemove: async ({ keys }) => {
      for (const key of keys) files.delete(key)
    },
    receiptQueueAppend: async ({ json }) => {
      files.set(`r-${++seq}.json`, json)
    },
    debugConsumeForcedRegisterFailure: async () => ({ fail: forced-- > 0 }),
  }
  return {
    plugin,
    keychain,
    files,
    force: (n: number) => {
      forced = n
    },
  }
}

describe("createNativeReceiptStore", () => {
  it("answers nothing and stores nothing where the plugin is not registered", async () => {
    const store = createNativeReceiptStore({ available: () => false, plugin: fakePlugin().plugin })
    await store.setCredential("https://a.example.com", { credential: "lnr_a", deviceId: "d" })
    expect(await store.getCredential("https://a.example.com")).toBeNull()
    expect(await store.listQueue()).toEqual([])
    expect(await store.forceRegisterFailure()).toBe(false)
  })

  it("keeps credentials per origin in the keychain", async () => {
    const fake = fakePlugin()
    const store = createNativeReceiptStore({ available: () => true, plugin: fake.plugin })
    await store.setCredential("https://a.example.com", { credential: "lnr_a", deviceId: "da" })
    expect(await store.getCredential("https://a.example.com")).toEqual({
      credential: "lnr_a",
      deviceId: "da",
    })
    expect(await store.getCredential("https://b.example.com")).toBeNull()
    await store.deleteCredential("https://a.example.com")
    expect(fake.keychain.size).toBe(0)
  })

  it("round-trips the queue in the NSE's file format and removes by key", async () => {
    const fake = fakePlugin()
    // Exactly what NotificationService writes (ReceiptStore.enqueue).
    fake.files.set(
      "nse-1.json",
      JSON.stringify({
        origin: "https://a.example.com",
        notificationId: "n1",
        outcome: "received",
        appState: "nse",
        queuedAt: 1791387013000,
      }),
    )
    const store = createNativeReceiptStore({ available: () => true, plugin: fake.plugin })
    await store.enqueue({
      origin: "https://a.example.com",
      notificationId: "n2",
      outcome: "shown",
      queuedAt: 5,
    })
    const listed = await store.listQueue()
    expect(listed.map((e) => e.receipt.notificationId)).toEqual(["n1", "n2"])
    expect(listed[0]?.receipt.appState).toBe("nse")
    await store.removeQueued([listed[0]!.key])
    expect([...fake.files.keys()]).toEqual(["r-1.json"])
  })

  it("removes a queue file it cannot read rather than tripping on it every launch", async () => {
    const fake = fakePlugin()
    fake.files.set("bad.json", "{not json")
    fake.files.set("wrong.json", JSON.stringify({ origin: 1, outcome: "maybe" }))
    const store = createNativeReceiptStore({ available: () => true, plugin: fake.plugin })
    expect(await store.listQueue()).toEqual([])
    expect(fake.files.size).toBe(0)
  })

  it("consumes the debug forced register failure once", async () => {
    const fake = fakePlugin()
    fake.force(1)
    const store = createNativeReceiptStore({ available: () => true, plugin: fake.plugin })
    expect(await store.forceRegisterFailure()).toBe(true)
    expect(await store.forceRegisterFailure()).toBe(false)
  })
})
