// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The devices API of Settings -> Notifications (S3, S6):
//   GET  /api/notifications/devices               -> NotificationDevice[]
//   POST /api/notifications/test                  -> { runId, devices: TestSendLine[] }
//   GET  /api/notifications/receipt-status?ids=   -> ReceiptStatus[] (the caller's own)
//
// `runNotificationTest` is the "Send me a test" loop: one test per device,
// then the receipts polled every 2 s for 30 s. A device that confirms
// `shown` or `suppressed` is final; `received` (an iOS extension saw it, the
// app has not said it was shown) keeps polling and stays `received` at the
// deadline; nothing by the deadline is `no_receipt`. A device the server could
// not reach is `not_delivered` from the start and never polled.
import type { useApi } from "~/modules/shell/ApiContext"

type Api = ReturnType<typeof useApi>

export type DeviceSurface = "ios" | "android" | "desktop" | "browser"

export interface NotificationDevice {
  deviceId: string
  surface: DeviceSurface
  detail: {
    environment?: string
    os?: string | null
    appVersion?: string | null
    reportedPermission?: string | null
    webPush?: boolean
    userAgent?: string | null
  }
  lastSeenAt: string
  lastDelivery: {
    notificationId: string
    channel: string
    surface: string | null
    result: string
    reason: string | null
    attemptedAt: string
  } | null
  lastReceipt: { notificationId: string; outcome: string; reason: string | null; at: string } | null
}

export interface TestSendLine {
  deviceId: string | null
  surface: string
  notificationId: string
  result: string
  reason: string | null
}

export interface ReceiptStatus {
  notificationId: string
  deviceId: string
  surface: string | null
  outcome: "received" | "shown" | "suppressed"
  reason: string | null
  at: string
}

export type TestLineStatus =
  | "pending"
  | "received"
  | "shown"
  | "suppressed"
  | "no_receipt"
  | "not_delivered"

export interface TestLine extends TestSendLine {
  status: TestLineStatus
  /** The receipt's reason (suppressed) or the delivery's (not delivered). */
  statusReason: string | null
}

export const TEST_TIMEOUT_MS = 30_000
export const TEST_POLL_MS = 2_000

export function fetchDevices(api: Api): Promise<NotificationDevice[]> {
  return api.get<NotificationDevice[]>("/notifications/devices")
}

const FINAL: ReadonlySet<TestLineStatus> = new Set([
  "shown",
  "suppressed",
  "no_receipt",
  "not_delivered",
])

export function isFinal(status: TestLineStatus): boolean {
  return FINAL.has(status)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send the test and follow it to the end. `onUpdate` gets a fresh array on
 * every change. Rejects only when the test itself could not be sent.
 */
export async function runNotificationTest(
  api: Api,
  onUpdate: (lines: TestLine[]) => void,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TestLine[]> {
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? TEST_POLL_MS
  const sent = await api.post<{ runId: string; devices: TestSendLine[] }>("/notifications/test")
  let lines: TestLine[] = (sent?.devices ?? []).map((d) => ({
    ...d,
    status: d.result === "accepted" ? "pending" : "not_delivered",
    statusReason: d.result === "accepted" ? null : (d.reason ?? d.result),
  }))
  onUpdate(lines)
  const start = Date.now()
  const open = () => lines.filter((l) => !isFinal(l.status))
  while (open().length > 0 && Date.now() - start < timeoutMs) {
    await sleep(intervalMs)
    const ids = open().map((l) => l.notificationId)
    let receipts: ReceiptStatus[] = []
    try {
      receipts = await api.get<ReceiptStatus[]>(
        `/notifications/receipt-status?ids=${ids.map(encodeURIComponent).join(",")}`,
      )
    } catch {
      receipts = []
    }
    const byId = new Map(receipts.map((r) => [r.notificationId, r]))
    let changed = false
    lines = lines.map((l) => {
      const r = byId.get(l.notificationId)
      if (!r || isFinal(l.status) || r.outcome === l.status) return l
      changed = true
      return { ...l, status: r.outcome, statusReason: r.reason }
    })
    if (changed) onUpdate(lines)
  }
  lines = lines.map((l) =>
    l.status === "pending" ? { ...l, status: "no_receipt" as const, statusReason: null } : l,
  )
  onUpdate(lines)
  return lines
}
