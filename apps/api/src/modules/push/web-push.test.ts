// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Without VAPID keys the browser channel is a loud no-op: no send attempted,
// status 0, and exactly ONE warning per process however many sends follow.
// Every deployment that has not set VAPID_* yet runs this path.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createECDH, randomBytes } from "node:crypto"
import webpush from "web-push"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { _resetWebPushNotice, defaultWebPushSend } from "./web-push"

type VapidEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
const vapid = env as VapidEnv
const saved: VapidEnv = { ...vapid }
const target = { endpoint: "https://push.example.com/abc", keys: { p256dh: "p", auth: "a" } }

describe("defaultWebPushSend without VAPID keys", () => {
  beforeEach(() => {
    _resetWebPushNotice()
  })
  afterEach(() => {
    vapid.VAPID_PUBLIC_KEY = saved.VAPID_PUBLIC_KEY
    vapid.VAPID_PRIVATE_KEY = saved.VAPID_PRIVATE_KEY
    vapid.VAPID_SUBJECT = saved.VAPID_SUBJECT
  })

  for (const missing of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const) {
    it(`is a no-op with one warning when ${missing} is absent`, async () => {
      vapid.VAPID_PUBLIC_KEY = "pub"
      vapid.VAPID_PRIVATE_KEY = "priv"
      vapid.VAPID_SUBJECT = "mailto:ops@example.com"
      vapid[missing] = undefined
      const send = spyOn(webpush, "sendNotification")
      const warn = spyOn(rootLogger, "warn").mockImplementation((() => {}) as never)
      try {
        expect(await defaultWebPushSend(target, "{}")).toEqual({ status: 0 })
        expect(await defaultWebPushSend(target, "{}")).toEqual({ status: 0 })
        expect(await defaultWebPushSend(target, "{}")).toEqual({ status: 0 })
        expect(send).not.toHaveBeenCalled()
        const disabled = warn.mock.calls.filter((c) => String(c[0]).includes("web push disabled"))
        expect(disabled).toHaveLength(1)
      } finally {
        send.mockRestore()
        warn.mockRestore()
      }
    })
  }

  it("sends through the SSRF-guarded fetch with the VAPID headers and no redirects", async () => {
    const keys = webpush.generateVAPIDKeys()
    vapid.VAPID_PUBLIC_KEY = keys.publicKey
    vapid.VAPID_PRIVATE_KEY = keys.privateKey
    vapid.VAPID_SUBJECT = "mailto:ops@example.com"
    const ecdh = createECDH("prime256v1")
    ecdh.generateKeys()
    const subscription = {
      endpoint: "https://8.8.8.8/push/abc",
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    }
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    OutboundFetchTestAccess.setFetch((async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> })
      return new Response(null, { status: 201 })
    }) as typeof fetch)
    const direct = spyOn(webpush, "sendNotification")
    try {
      expect(await defaultWebPushSend(subscription, "{}")).toEqual({ status: 201 })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe("https://8.8.8.8/push/abc")
      expect(seen[0]?.headers.Authorization ?? seen[0]?.headers.authorization).toContain("vapid")
      // The library's own HTTP client (which has no outbound guard) is not used.
      expect(direct).not.toHaveBeenCalled()
    } finally {
      OutboundFetchTestAccess.setFetch(null)
      direct.mockRestore()
    }
  })

  // The endpoint is user-supplied: the server must never POST to an internal
  // address, a plain-http URL, or follow a redirect to one.
  for (const endpoint of [
    "http://push.example.com/abc",
    "https://127.0.0.1/abc",
    "https://169.254.169.254/latest/meta-data",
    "https://[64:ff9b::a00:1]/abc",
  ]) {
    it(`refuses to send to ${endpoint}`, async () => {
      const keys = webpush.generateVAPIDKeys()
      vapid.VAPID_PUBLIC_KEY = keys.publicKey
      vapid.VAPID_PRIVATE_KEY = keys.privateKey
      vapid.VAPID_SUBJECT = "mailto:ops@example.com"
      const ecdh = createECDH("prime256v1")
      ecdh.generateKeys()
      let fetched = 0
      OutboundFetchTestAccess.setFetch((async () => {
        fetched++
        return new Response(null, { status: 201 })
      }) as unknown as typeof fetch)
      try {
        const out = await defaultWebPushSend(
          {
            endpoint,
            keys: {
              p256dh: ecdh.getPublicKey().toString("base64url"),
              auth: randomBytes(16).toString("base64url"),
            },
          },
          "{}",
        )
        expect(out).toEqual({ status: 0 })
        expect(fetched).toBe(0)
      } finally {
        OutboundFetchTestAccess.setFetch(null)
      }
    })
  }
})
