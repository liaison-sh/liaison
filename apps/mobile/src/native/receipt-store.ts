// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The receipt store's native half, through the app's own plugin
// (ios/App/App/LiaisonNativePlugin.swift, which calls the same ReceiptStore
// the Notification Service Extension uses):
//
// - credentials: the shared keychain access group
//   `$(AppIdentifierPrefix)sh.liaison.mobile.shared`, one generic password
//   item per server origin, readable by the extension after first unlock;
// - the offline queue: one JSON file per receipt in the App Group container
//   (`group.sh.liaison.mobile`/receipt-queue/), so the extension and the app
//   never rewrite each other's entries;
// - a debug-only switch that fails the next push registration POST (M5).
//
// Where the plugin is not registered (web, Android, tests) every read is empty
// and every write is dropped: no credential, so no receipt is ever posted.

import type { QueuedReceipt, ReceiptNative, StoredCredential } from "../receipts"
import { liaisonNativeAvailable, liaisonNativeProxy } from "./liaison-native"

/** The plugin methods, as LiaisonNativePlugin.swift declares them. */
export interface ReceiptStorePlugin {
  receiptCredentialGet: (options: {
    origin: string
  }) => Promise<{ credential?: string; deviceId?: string }>
  receiptCredentialSet: (options: {
    origin: string
    credential: string
    deviceId: string
  }) => Promise<void>
  receiptCredentialDelete: (options: { origin: string }) => Promise<void>
  receiptQueueList: () => Promise<{ entries: Array<{ key: string; json: string }> }>
  receiptQueueRemove: (options: { keys: string[] }) => Promise<void>
  receiptQueueAppend: (options: { json: string }) => Promise<void>
  debugConsumeForcedRegisterFailure: () => Promise<{ fail: boolean }>
}

export interface NativeReceiptStore extends ReceiptNative {
  /** True once per armed debug toggle; always false in a release build. */
  forceRegisterFailure: () => Promise<boolean>
}

const OUTCOMES = new Set(["received", "shown", "suppressed"])

function parseQueued(json: string): QueuedReceipt | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const r = raw as Record<string, unknown> | null
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.origin !== "string" ||
    typeof r.notificationId !== "string" ||
    typeof r.outcome !== "string" ||
    !OUTCOMES.has(r.outcome) ||
    typeof r.queuedAt !== "number"
  ) {
    return null
  }
  return {
    origin: r.origin,
    notificationId: r.notificationId,
    outcome: r.outcome as QueuedReceipt["outcome"],
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(typeof r.appState === "string" ? { appState: r.appState } : {}),
    queuedAt: r.queuedAt,
  }
}

export function createNativeReceiptStore(deps: {
  available: () => boolean
  plugin: ReceiptStorePlugin
}): NativeReceiptStore {
  const { plugin } = deps
  return {
    async getCredential(origin): Promise<StoredCredential | null> {
      if (!deps.available()) return null
      const { credential, deviceId } = await plugin.receiptCredentialGet({ origin })
      return typeof credential === "string" && credential && typeof deviceId === "string"
        ? { credential, deviceId }
        : null
    },
    async setCredential(origin, value) {
      if (!deps.available()) return
      await plugin.receiptCredentialSet({ origin, ...value })
    },
    async deleteCredential(origin) {
      if (!deps.available()) return
      await plugin.receiptCredentialDelete({ origin })
    },
    async listQueue() {
      if (!deps.available()) return []
      const { entries } = await plugin.receiptQueueList()
      const good: Array<{ key: string; receipt: QueuedReceipt }> = []
      const bad: string[] = []
      for (const entry of entries ?? []) {
        const receipt = parseQueued(entry.json)
        if (receipt === null) bad.push(entry.key)
        else good.push({ key: entry.key, receipt })
      }
      // An unreadable file would be listed, and skipped, on every launch.
      if (bad.length > 0) await plugin.receiptQueueRemove({ keys: bad }).catch(() => undefined)
      return good
    },
    async removeQueued(keys) {
      if (!deps.available() || keys.length === 0) return
      await plugin.receiptQueueRemove({ keys })
    },
    async enqueue(receipt) {
      if (!deps.available()) return
      await plugin.receiptQueueAppend({ json: JSON.stringify(receipt) })
    },
    async forceRegisterFailure() {
      if (!deps.available()) return false
      const { fail } = await plugin.debugConsumeForcedRegisterFailure().catch(() => ({
        fail: false,
      }))
      return fail === true
    },
  }
}

/** The app's store, over the LiaisonNative plugin. */
export const nativeReceiptStore: NativeReceiptStore = createNativeReceiptStore({
  available: liaisonNativeAvailable,
  plugin: liaisonNativeProxy<ReceiptStorePlugin>(),
})
