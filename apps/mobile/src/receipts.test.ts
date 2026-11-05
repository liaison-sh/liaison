// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The decisions behind an iOS delivery receipt (spec-push A3, A7, S2, S3),
// pinned in TS because the Swift halves (the NSE and the plugin) only move
// bytes: which outcome a presented push gets, where a receipt goes and with
// which credential, what an offline receipt becomes, and how long a failed
// registration waits before it tries again.

import { describe, expect, it } from "bun:test"
import {
  createMemoryReceiptNative,
  createReceiptClient,
  presentationOutcome,
  RECEIPTS_PATH,
  REGISTER_BACKOFF_MAX_MS,
  receiptOrigin,
  registrationBackoffMs,
  storeRegistrationCredential,
} from "./receipts"

interface Call {
  url: string
  authorization: string | null
  body: Record<string, unknown>
}

const A = "https://a.example.com"
const B = "https://b.example.com:8443"
const N1 = "6f1d2c3b-0000-4000-8000-000000000001"
const N2 = "6f1d2c3b-0000-4000-8000-000000000002"

function recorder(statusFor: (url: string, body: Record<string, unknown>) => number | "offline") {
  const calls: Call[] = []
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    const status = statusFor(input, body)
    calls.push({
      url: input,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    })
    if (status === "offline") throw new TypeError("The Internet connection appears to be offline.")
    return new Response("{}", { status })
  }
  return { calls, fetchImpl }
}

describe("presentationOutcome (the app's final outcome, A3)", () => {
  it("is shown for a push about any conversation that is not on screen", () => {
    expect(presentationOutcome({ threadId: "t1" }, null)).toEqual({ outcome: "shown" })
    expect(presentationOutcome({ threadId: "t1" }, "t2")).toEqual({ outcome: "shown" })
  })

  it("is suppressed/on_screen for the conversation the user is reading", () => {
    expect(presentationOutcome({ threadId: "t1" }, "t1")).toEqual({
      outcome: "suppressed",
      reason: "on_screen",
    })
  })

  it("a session push whose session is on screen is suppressed, on_screen", () => {
    expect(presentationOutcome({ type: "node_session", sessionId: "s1" }, "s1")).toEqual({
      outcome: "suppressed",
      reason: "on_screen",
    })
    expect(presentationOutcome({ type: "node_session", sessionId: "s1" }, "s2")).toEqual({
      outcome: "shown",
    })
  })

  it("is shown for a payload that names no thread, even with one on screen", () => {
    expect(presentationOutcome({}, "t1")).toEqual({ outcome: "shown" })
  })
})

describe("registrationBackoffMs (S3)", () => {
  it("doubles from 2 s and stops growing at 5 minutes", () => {
    const schedule = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(registrationBackoffMs)
    expect(schedule).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ])
    expect(REGISTER_BACKOFF_MAX_MS).toBe(300_000)
  })

  it("puts the first retry well inside the 2 minute M5 window", () => {
    expect(registrationBackoffMs(1) + registrationBackoffMs(2)).toBeLessThan(120_000)
  })

  it("treats a nonsense attempt number as the first", () => {
    expect(registrationBackoffMs(0)).toBe(2_000)
    expect(registrationBackoffMs(Number.NaN)).toBe(2_000)
  })
})

describe("receiptOrigin", () => {
  it("is the payload's own server origin when it names one", () => {
    expect(receiptOrigin({ server: `${B}/` }, A)).toBe(B)
  })

  it("falls back to the bound server for a payload that names none", () => {
    expect(receiptOrigin({}, `${A}/`)).toBe(A)
  })

  it("is null for a payload whose server is not an http(s) origin", () => {
    expect(receiptOrigin({ server: "javascript:alert(1)" }, A)).toBeNull()
  })
})

describe("credential storage per server origin (A7)", () => {
  it("stores the registration answer's credential under the server's origin", async () => {
    const native = createMemoryReceiptNative()
    const stored = await storeRegistrationCredential(native, `${A}/`, {
      data: { id: "device-a", receiptCredential: "lnr_a" },
    })
    expect(stored).toBe(true)
    expect(await native.getCredential(A)).toEqual({ credential: "lnr_a", deviceId: "device-a" })
    expect(await native.getCredential(B)).toBeNull()
  })

  it("keeps one credential per server, so two servers never overwrite each other", async () => {
    const native = createMemoryReceiptNative()
    await storeRegistrationCredential(native, A, { data: { id: "da", receiptCredential: "lnr_a" } })
    await storeRegistrationCredential(native, B, { data: { id: "db", receiptCredential: "lnr_b" } })
    expect((await native.getCredential(A))?.credential).toBe("lnr_a")
    expect((await native.getCredential(B))?.credential).toBe("lnr_b")
  })

  it("stores nothing from an answer without a credential (a server before A7)", async () => {
    const native = createMemoryReceiptNative()
    expect(await storeRegistrationCredential(native, A, { data: { id: "da" } })).toBe(false)
    expect(await native.getCredential(A)).toBeNull()
  })
})

describe("posting a receipt", () => {
  it("posts to the origin's receipt path with that origin's credential and device", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    await native.setCredential(B, { credential: "lnr_b", deviceId: "db" })
    const { calls, fetchImpl } = recorder(() => 200)
    const receipts = createReceiptClient({ native, fetchImpl })

    expect(
      await receipts.post(B, { notificationId: N1, outcome: "shown", appState: "foreground" }),
    ).toBe("sent")
    expect(calls).toEqual([
      {
        url: `${B}${RECEIPTS_PATH}`,
        authorization: "Bearer lnr_b",
        body: { notificationId: N1, outcome: "shown", appState: "foreground", deviceId: "db" },
      },
    ])
  })

  it("queues the receipt when the phone is offline", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    const { fetchImpl } = recorder(() => "offline")
    const receipts = createReceiptClient({ native, fetchImpl, now: () => 1_000 })
    expect(
      await receipts.post(A, { notificationId: N1, outcome: "suppressed", reason: "on_screen" }),
    ).toBe("queued")
    const queued = await native.listQueue()
    expect(queued.map((q) => q.receipt)).toEqual([
      {
        origin: A,
        notificationId: N1,
        outcome: "suppressed",
        reason: "on_screen",
        queuedAt: 1_000,
      },
    ])
  })

  it("queues on a server error, drops on a refusal that will never change", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    const { fetchImpl } = recorder((_url, body) => (body.notificationId === N1 ? 503 : 404))
    const receipts = createReceiptClient({ native, fetchImpl })
    expect(await receipts.post(A, { notificationId: N1, outcome: "shown" })).toBe("queued")
    expect(await receipts.post(A, { notificationId: N2, outcome: "shown" })).toBe("dropped")
    expect((await native.listQueue()).map((q) => q.receipt.notificationId)).toEqual([N1])
  })

  it("sends nothing for a server it holds no credential for", async () => {
    const native = createMemoryReceiptNative()
    const { calls, fetchImpl } = recorder(() => 200)
    const receipts = createReceiptClient({ native, fetchImpl })
    expect(await receipts.post(A, { notificationId: N1, outcome: "shown" })).toBe("no-credential")
    expect(calls).toEqual([])
    expect(await native.listQueue()).toEqual([])
  })
})

describe("flushing the App Group queue (launch and foreground)", () => {
  it("sends every queued receipt with its own server's credential and removes the sent ones", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    await native.setCredential(B, { credential: "lnr_b", deviceId: "db" })
    // What the NSE leaves behind when it had no network: `received`.
    await native.enqueue({ origin: A, notificationId: N1, outcome: "received", queuedAt: 1 })
    await native.enqueue({ origin: B, notificationId: N2, outcome: "received", queuedAt: 2 })
    const { calls, fetchImpl } = recorder(() => 200)
    const result = await createReceiptClient({ native, fetchImpl, now: () => 10 }).flush()

    expect(result).toEqual({ sent: 2, kept: 0, dropped: 0 })
    expect(calls.map((c) => [c.url, c.authorization, c.body.notificationId])).toEqual([
      [`${A}${RECEIPTS_PATH}`, "Bearer lnr_a", N1],
      [`${B}${RECEIPTS_PATH}`, "Bearer lnr_b", N2],
    ])
    expect(await native.listQueue()).toEqual([])
  })

  it("keeps what still cannot be sent, drops what never will", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    await native.enqueue({ origin: A, notificationId: N1, outcome: "received", queuedAt: 1 })
    // The server revoked the credential (sign-out): 401, never retried.
    await native.enqueue({ origin: A, notificationId: N2, outcome: "received", queuedAt: 1 })
    // Signed out of B entirely: its credential is gone from the keychain.
    await native.enqueue({ origin: B, notificationId: N1, outcome: "received", queuedAt: 1 })
    const { fetchImpl } = recorder((_url, body) => (body.notificationId === N1 ? "offline" : 401))
    const result = await createReceiptClient({ native, fetchImpl, now: () => 10 }).flush()

    expect(result).toEqual({ sent: 0, kept: 1, dropped: 2 })
    expect(
      (await native.listQueue()).map((q) => [q.receipt.origin, q.receipt.notificationId]),
    ).toEqual([[A, N1]])
  })

  it("drops a receipt older than a day instead of retrying it forever", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    await native.enqueue({ origin: A, notificationId: N1, outcome: "received", queuedAt: 0 })
    const { calls, fetchImpl } = recorder(() => 200)
    const day = 24 * 60 * 60 * 1000
    const result = await createReceiptClient({ native, fetchImpl, now: () => day + 1 }).flush()
    expect(result).toEqual({ sent: 0, kept: 0, dropped: 1 })
    expect(calls).toEqual([])
  })

  it("flushes the queue once even when launch and foreground ask at the same time", async () => {
    const native = createMemoryReceiptNative()
    await native.setCredential(A, { credential: "lnr_a", deviceId: "da" })
    await native.enqueue({ origin: A, notificationId: N1, outcome: "received", queuedAt: 1 })
    const { calls, fetchImpl } = recorder(() => 200)
    const receipts = createReceiptClient({ native, fetchImpl, now: () => 10 })
    await Promise.all([receipts.flush(), receipts.flush()])
    expect(calls).toHaveLength(1)
  })
})
