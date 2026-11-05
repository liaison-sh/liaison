// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sender, against a FAKE transport. No live network call happens in a unit
// test, and none can: the HTTP hop is the injectable seam, so what is pinned
// here is the request this module BUILDS (host, auth header, body) and how it
// reads the answer back, which is all of the sender that can be wrong on a Mac
// with no APNs key and no FCM service account.
import { beforeEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import {
  classifyApnsResponse,
  classifyFcmResponse,
  type PushCredentials,
  PushSenderTestAccess,
  sendPush,
} from "~/modules/push/sender"
import { FakePushTransport } from "~/modules/push/transport-fake"

const APNS_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUb0uv3OqGawflNEa
44vN6HM1BtQeigQswWPnFyTwxcOhRANCAARgaihBMqP+jkRZDO9khtNjkb5STk7t
RCt9BYmiMv1q1T/yrylSx0lHCBHES+dGySDgmAV+LhW060oAsKZyvtnX
-----END PRIVATE KEY-----`

const FCM_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDEErj2euVgiHNp
BoPpZ6rKQSTS5rgxv6RarFHExj9reC4/8SPjnC/z+QGoJ+F2J7NIrjzfCXe1AfXz
XhnWYg711L4WQvrUjaI6Ya9ffJLf07+vPLP2fULilazNnOocVnkm+u54Av1jP2nB
/qA3+sWDLpHUIqnP8X68GWPnfa6PU0Z+lI+d//0+4eTv1olMpiCTm2p3mmGDYzn7
3e3Q8OUV04cdVylKYBl+u4jmVUGar1bZpszjExNAy0/CmMV2ZTiu6b+JwKouO5Su
S35JyLnWHTNYsbtxyVXDdt2BcOTJS4fDW7gC/Z52YoJdeKVvPo/9Rmx2d6IEm/+f
82YUqGyjAgMBAAECggEALEh0OMrZ2lsHAc3kZgcxVhuvZuiP6kB3rLjlgNUrhqiu
fWeHbQUd+XKgMqvLKoXd4ojjm5YGUL3AIDZ9DGO6MEBbrCh1gSL55EiitKSsgVvQ
G5JQrNduj0ExtYB+iWboVuruh/FY7Bzq1FMfOXVsPWv7qJcplhrbPj1XyHUkwx6s
48iNisAQEqqV1e5XVJN4JklMYV+VU1+fO78YA0j5xSx/6RWJMbVKs7FSO/Pcx1CN
UOpWISK9KzA7y2yXuq4o+/VARbFPJ3EYz3djqpmPcJ6NfoD/Us1QtOHN7HzTEVb4
+nn+AC7X9ja3GULEJTVu/gyUf6tT1kcE3am/U8H1AQKBgQDr5hSs/4oa+wEm6SrV
9j4kHZKwgryymkTBy8fA3IadnRJlLh0e/aiLrIbKOaAtXkAScwjFV+gmx+R0Yrbu
aWC7o879ikcaDNbZ4NLk/fEes3DQPlrDIwQ9JffqWmHLJnOysYcC2Pl7craTmpog
+5bgbxYeV1vIIbTepRnZ1RKHowKBgQDUx+G2O76N2+K9aWqjihslleBHIxbDhN3G
Df3Pcs+qKofZJ0Pk1VN7yDniA2q4tHov447D75IRr1UiNKmeQ82W7JLlttc/OefT
WAofCMQjoPcwOiELoVqOMhB+xAvdazhNJRTSmR3lXz1kNP8Gpy+MJKH6s2dfO7En
1ZxLvGTXAQKBgEkOEAkjelmwskKioylwAP6eSfdwBZAqRnDd8xa/NNFK+49qIIqg
c7oNzBCEmB50udL83RKAjtyzuwRwLcbXy6VQraHHWQ2wPDltbuKL4khnueBD70fP
aFinkYd6Rh7r4ZjNccpn95tLg09i6aidQbRvsqHi3AG2rpTk/ISBgCORAoGAG5tf
bpxryc4IqhieTF+jzAmZEsG7t1xqxcKU9rBnvyVLgOI2Td9buIiu8eMNmq9X1xTI
NiXEJuU/v3NjunQDnZxOJt3FKZ/isyoODh6+C/1bdPdlyDOEI0TdnQTkoTLDGEdC
X1ycY2Eq/vBdUkiow58RIQzb0aBWCNwPLkhgMQECgYAhUHdeICY8uRJdavLImD+5
myptc1eQ6/zqlHEQrxJeHRSrzPMI/R1r/+kcr2Orb/Oy0WVvq3/EnCVoZkUjDSMh
wb31RLNMFjsY1vg4f3v/s92kshxkVp464+9jrRe8ZYTbHjS6jYn63ehHBNs3+BBO
qvYMUbgUNybRcK99VOHEOw==
-----END PRIVATE KEY-----`

const credentials: PushCredentials = {
  apns: {
    keyId: "ABC1234567",
    teamId: "TEAM123456",
    bundleId: "com.liaison.app",
    key: APNS_P8,
  },
  fcm: {
    projectId: "liaison-test",
    clientEmail: "push@liaison-test.iam.gserviceaccount.com",
    privateKey: FCM_PRIVATE_KEY,
  },
}

const payload = {
  type: "mention" as const,
  threadId: "8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f",
  deepLink: "liaison://thread/8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f",
  badgeCount: 3,
  title: "Alice",
  body: "the quarterly numbers are in",
}

const iosToken = {
  id: "t1",
  platform: "ios" as const,
  token: "APNS-DEVICE-TOKEN",
  environment: "sandbox" as const,
}
const iosProductionToken = { ...iosToken, environment: "production" as const }
const androidToken = { id: "t2", platform: "android" as const, token: "FCM-DEVICE-TOKEN" }

describe("push sender", () => {
  beforeEach(() => {
    PushSenderTestAccess.resetDisabledNotice()
  })

  it("sends to the APNs sandbox endpoint with a JWT bearer for an ios token", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const result = await sendPush(iosToken, payload, { transport, credentials })
    expect(result.kind).toBe("sent")
    const [request] = transport.requests
    expect(request.url).toBe("https://api.sandbox.push.apple.com/3/device/APNS-DEVICE-TOKEN")
    // Three dot-separated base64url segments: a JWT, not a raw key.
    expect(request.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(request.headers["apns-topic"]).toBe("com.liaison.app")
    const body = JSON.parse(request.body) as { aps: { badge: number; alert: { title: string } } }
    expect(body.aps.badge).toBe(3)
    expect(body.aps.alert.title).toBe("Alice")
  })

  // S11: the host is a property of the TOKEN, not of the process. A build
  // installed from Xcode holds a sandbox token and a TestFlight build holds a
  // production one, and both talk to the same server at the same time.
  it("sandbox token hits sandbox host, production token hits production host", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({ status: 200, body: "" })
    await sendPush(iosToken, payload, { transport, credentials })
    await sendPush(iosProductionToken, payload, { transport, credentials })
    expect(transport.requests[0].url).toStartWith("https://api.sandbox.push.apple.com/")
    expect(transport.requests[1].url).toStartWith("https://api.push.apple.com/")
  })

  it("a token with no recorded environment goes to the production host", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const { environment: _omitted, ...legacy } = iosToken
    await sendPush(legacy, payload, { transport, credentials })
    expect(transport.requests[0].url).toStartWith("https://api.push.apple.com/")
  })

  it("BadDeviceToken on the first host is retried on the other and reports the host that took it", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 400, body: '{"reason":"BadDeviceToken"}' })
    transport.enqueue({ status: 200, body: "" })
    const result = await sendPush(iosProductionToken, payload, { transport, credentials })
    expect(result.kind).toBe("sent")
    expect(result.environment).toBe("sandbox")
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0].url).toStartWith("https://api.push.apple.com/")
    expect(transport.requests[1].url).toStartWith("https://api.sandbox.push.apple.com/")
  })

  it("both hosts rejecting the token is an invalid token", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 400, body: '{"reason":"BadDeviceToken"}' })
    transport.enqueue({ status: 400, body: '{"reason":"BadDeviceToken"}' })
    const result = await sendPush(iosToken, payload, { transport, credentials })
    expect(result.kind).toBe("invalid_token")
    expect(transport.requests).toHaveLength(2)
  })

  it("an Unregistered device is not retried on the other host", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 410, body: '{"reason":"Unregistered"}' })
    const result = await sendPush(iosToken, payload, { transport, credentials })
    expect(result.kind).toBe("invalid_token")
    expect(transport.requests).toHaveLength(1)
  })

  it("a send on the token's own host reports no environment change", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const result = await sendPush(iosToken, payload, { transport, credentials })
    expect(result.environment).toBeUndefined()
  })

  it("maps a collapseId to the apns-collapse-id header, else collapses on the conversation", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({ status: 200, body: "" })
    await sendPush(iosToken, { ...payload, collapseId: "thread-42" }, { transport, credentials })
    await sendPush(iosToken, payload, { transport, credentials })
    expect(transport.requests[0].headers["apns-collapse-id"]).toBe("thread-42")
    // A newer push of the same thread replaces the older banner.
    expect(transport.requests[1].headers["apns-collapse-id"]).toBe(`thread:${payload.threadId}`)
  })

  it("sends to the FCM v1 endpoint with an OAuth bearer for an android token", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }),
    })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ name: "projects/liaison-test/messages/1" }),
    })
    const result = await sendPush(androidToken, payload, { transport, credentials })
    expect(result.kind).toBe("sent")
    expect(transport.requests[0].url).toBe("https://oauth2.googleapis.com/token")
    const send = transport.requests[1]
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/liaison-test/messages:send")
    expect(send.headers.authorization).toBe("Bearer ya29.fake")
    const body = JSON.parse(send.body) as {
      message: { token: string; notification: { title: string } }
    }
    expect(body.message.token).toBe("FCM-DEVICE-TOKEN")
    expect(body.message.notification.title).toBe("Alice")
  })

  it("an APNs push to a multi server phone names its organisation in the subtitle and the data", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    await sendPush(
      { ...iosToken, multiServer: true },
      { ...payload, serverLabel: "Acme" },
      { transport, credentials },
    )
    const body = JSON.parse(transport.requests[0].body) as {
      aps: { alert: { title: string; subtitle?: string } }
      serverLabel?: string
    }
    expect(body.aps.alert.title).toBe("Alice")
    expect(body.aps.alert.subtitle).toBe("Acme")
    expect(body.serverLabel).toBe("Acme")
  })

  it("an FCM push to a multi server phone leads its title with the organisation, and a redacted one is titled by it", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    transport.enqueue({ status: 200, body: "{}" })
    const multi = { ...androidToken, multiServer: true }
    await sendPush(multi, { ...payload, serverLabel: "Acme" }, { transport, credentials })
    const { title: _t, body: _b, ...redacted } = payload
    await sendPush(multi, { ...redacted, serverLabel: "Acme" }, { transport, credentials })
    const sends = transport.requests.filter((r) => r.url.includes("messages:send"))
    const first = JSON.parse(sends[0].body) as {
      message: { notification: { title: string }; data: Record<string, string> }
    }
    const second = JSON.parse(sends[1].body) as { message: { notification: { title: string } } }
    expect(first.message.notification.title).toBe("Acme: Alice")
    expect(first.message.data.serverLabel).toBe("Acme")
    expect(second.message.notification.title).toBe("Acme")
  })

  it("a single server phone gets no organisation in the alert, only in the data", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    await sendPush(iosToken, { ...payload, serverLabel: "Acme" }, { transport, credentials })
    await sendPush(androidToken, { ...payload, serverLabel: "Acme" }, { transport, credentials })
    const apns = JSON.parse(transport.requests[0].body) as {
      aps: { alert: { subtitle?: string } }
      serverLabel?: string
    }
    expect(apns.aps.alert.subtitle).toBeUndefined()
    expect(apns.serverLabel).toBe("Acme")
    const send = transport.requests.find((r) => r.url.includes("messages:send"))
    const fcm = JSON.parse(send?.body ?? "{}") as {
      message: { notification: { title: string }; data: Record<string, string> }
    }
    expect(fcm.message.notification.title).toBe("Alice")
    expect(fcm.message.data.serverLabel).toBe("Acme")
  })

  it("a push with no organisation name keeps its title and has no subtitle", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    await sendPush(iosToken, payload, { transport, credentials })
    const body = JSON.parse(transport.requests[0].body) as {
      aps: { alert: { subtitle?: string } }
    }
    expect(body.aps.alert.subtitle).toBeUndefined()
  })

  it("classifies an APNs 410 as an invalid token", () => {
    expect(classifyApnsResponse({ status: 410, body: '{"reason":"Unregistered"}' }).kind).toBe(
      "invalid_token",
    )
    expect(classifyApnsResponse({ status: 400, body: '{"reason":"BadDeviceToken"}' }).kind).toBe(
      "invalid_token",
    )
    expect(classifyApnsResponse({ status: 503, body: "" }).kind).toBe("transient")
    expect(classifyApnsResponse({ status: 200, body: "" }).kind).toBe("sent")
  })

  // Apple's 410 names the last moment the token was valid. A row registered
  // after it is a fresh registration and must survive (fanout-consumer.ts).
  it("carries the APNs 410 timestamp as the moment the token stopped being valid", () => {
    const result = classifyApnsResponse({
      status: 410,
      body: '{"reason":"Unregistered","timestamp":1761580800000}',
    })
    expect(result.kind).toBe("invalid_token")
    expect(result.unregisteredAt?.toISOString()).toBe("2025-10-27T16:00:00.000Z")
    expect(
      classifyApnsResponse({ status: 400, body: '{"reason":"BadDeviceToken"}' }).unregisteredAt,
    ).toBeUndefined()
    expect(
      classifyApnsResponse({ status: 410, body: '{"reason":"Unregistered","timestamp":"x"}' })
        .unregisteredAt,
    ).toBeUndefined()
  })

  it("classifies an FCM UNREGISTERED as an invalid token", () => {
    const unregistered = JSON.stringify({
      error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
    })
    expect(classifyFcmResponse({ status: 404, body: unregistered }).kind).toBe("invalid_token")
    expect(classifyFcmResponse({ status: 500, body: "" }).kind).toBe("transient")
    expect(classifyFcmResponse({ status: 200, body: "{}" }).kind).toBe("sent")
  })

  // ONLY the provider's "this device is gone" verdict may unregister a device.
  // INVALID_ARGUMENT is what FCM answers for a malformed message, and a bare
  // 404 (no UNREGISTERED detail) is what it answers for a wrong project id, so
  // treating either as a dead token would delete EVERY Android row in the org
  // the first time a payload or FCM_PROJECT_ID was wrong. APNs has the same
  // trap: DeviceTokenNotForTopic means the topic is misconfigured, not that the
  // phone is gone.
  it("never unregisters a device for a malformed message or a misconfigured project", () => {
    const invalidArgument = JSON.stringify({ error: { status: "INVALID_ARGUMENT" } })
    expect(classifyFcmResponse({ status: 400, body: invalidArgument }).kind).toBe("permanent")
    const wrongProject = JSON.stringify({ error: { status: "NOT_FOUND" } })
    expect(classifyFcmResponse({ status: 404, body: wrongProject }).kind).toBe("permanent")
    expect(classifyFcmResponse({ status: 404, body: "" }).kind).toBe("permanent")
    expect(
      classifyApnsResponse({ status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' }).kind,
    ).toBe("permanent")
  })

  it("is a loud no-op, said once, when the APNs credentials are missing", async () => {
    const transport = new FakePushTransport()
    const notices: string[] = []
    const deps = { transport, credentials: {}, onDisabled: (m: string) => notices.push(m) }
    const first = await sendPush(iosToken, payload, deps)
    const second = await sendPush(iosToken, payload, deps)
    expect(first.kind).toBe("disabled")
    expect(second.kind).toBe("disabled")
    expect(transport.requests).toHaveLength(0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toBe(
      "push disabled: APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID",
    )
  })

  it("is a loud no-op, said once, when the FCM service account is missing", async () => {
    const transport = new FakePushTransport()
    const notices: string[] = []
    const deps = { transport, credentials: {}, onDisabled: (m: string) => notices.push(m) }
    expect((await sendPush(androidToken, payload, deps)).kind).toBe("disabled")
    expect((await sendPush(androidToken, payload, deps)).kind).toBe("disabled")
    expect(notices).toEqual(["push disabled: FCM_SERVICE_ACCOUNT_PATH, FCM_PROJECT_ID"])
  })

  it("shows a generic alert when the payload carries no title or body", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const redacted = {
      type: "mention" as const,
      threadId: payload.threadId,
      deepLink: payload.deepLink,
      badgeCount: 1,
    }
    await sendPush(iosToken, redacted, { transport, credentials })
    const body = JSON.parse(transport.requests[0].body) as {
      aps: { alert: { title: string; body: string } }
    }
    expect(body.aps.alert.body).toBe("New message")
    expect(transport.requests[0].body).not.toContain("quarterly")
  })

  // The tap on a phone set up for another server is ignored rather than
  // routed to a thread id that means nothing there: the payload names the
  // origin that sent it.
  it("names the sending server's origin in the APNs and FCM payloads", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    const deps = { transport, credentials, server: "https://acme.example.com/" }
    await sendPush(iosToken, payload, deps)
    await sendPush(androidToken, payload, deps)
    const apns = JSON.parse(transport.requests[0].body) as { server?: string }
    expect(apns.server).toBe("https://acme.example.com")
    // The FCM OAuth exchange may be cached from an earlier case, so the send is
    // found by its URL rather than by its position.
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as { message: { data: { server?: string } } }
    expect(fcm.message.data.server).toBe("https://acme.example.com")
  })

  // P4 (C9): a node session push names the session, never a thread. It
  // carries the id only, collapses per session, and groups on the lock screen
  // under a per-session thread-id.
  it("a node_session payload carries sessionId and no threadId, with the collapse id header and a session thread-id", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.s", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    const sessionId = "5b1f7c2e-1d2a-4c3b-8e9f-0a1b2c3d4e5f"
    const sessionPayload = {
      type: "node_session" as const,
      sessionId,
      deepLink: `liaison://session/${sessionId}`,
      badgeCount: 2,
      title: "Session needs you",
      body: "Fix the sum: a question",
      collapseId: sessionId,
    }
    const deps = { transport, credentials, server: "https://acme.example.com" }
    await sendPush(iosToken, sessionPayload, deps)
    await sendPush(androidToken, sessionPayload, deps)
    const apnsRequest = transport.requests[0]
    expect(apnsRequest.headers["apns-collapse-id"]).toBe(sessionId)
    const apns = JSON.parse(apnsRequest.body) as Record<string, unknown> & {
      aps: Record<string, unknown>
    }
    expect(apns.type).toBe("node_session")
    expect(apns.sessionId).toBe(sessionId)
    expect("threadId" in apns).toBe(false)
    expect(apns.deepLink).toBe(`liaison://session/${sessionId}`)
    expect(apns.aps["thread-id"]).toBe(`session:${sessionId}`)
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as {
      message: { data: Record<string, string> }
    }
    expect(fcm.message.data.sessionId).toBe(sessionId)
    expect("threadId" in fcm.message.data).toBe(false)
  })

  // P4 (S12): a throttled session push is silent: it replaces the banner (same
  // collapse id) without a sound, and lands passively.
  it("a silent payload has no sound on APNs, a passive interruption level, and a low FCM priority", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.q", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    const sessionId = "5b1f7c2e-1d2a-4c3b-8e9f-0a1b2c3d4e60"
    const quiet = {
      type: "node_session" as const,
      sessionId,
      deepLink: `liaison://session/${sessionId}`,
      badgeCount: 1,
      title: "Session needs you",
      body: "Fix the sum: a question",
      collapseId: sessionId,
      silent: true,
    }
    const deps = { transport, credentials, server: "https://acme.example.com" }
    await sendPush(iosToken, quiet, deps)
    await sendPush(androidToken, quiet, deps)
    const apns = JSON.parse(transport.requests[0].body) as { aps: Record<string, unknown> }
    expect("sound" in apns.aps).toBe(false)
    expect(apns.aps["interruption-level"]).toBe("passive")
    expect(apns.aps.alert).toEqual({ title: "Session needs you", body: "Fix the sum: a question" })
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as {
      message: { android: { notification: Record<string, unknown> } }
    }
    expect(fcm.message.android.notification.notification_priority).toBe("PRIORITY_LOW")
  })

  it("a thread payload is byte-identical to before", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    await sendPush(iosToken, payload, {
      transport,
      credentials,
      server: "https://acme.example.com",
    })
    expect(transport.requests[0].body).toBe(
      '{"aps":{"alert":{"title":"Alice","body":"the quarterly numbers are in"},"badge":3,' +
        '"sound":"default","thread-id":"8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f","mutable-content":1},' +
        '"type":"mention","threadId":"8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f",' +
        '"deepLink":"liaison://thread/8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f",' +
        '"server":"https://acme.example.com"}',
    )
  })

  it("carries the key the phone settles the notification by, in the APNs and FCM data (rule 5)", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    const deps = { transport, credentials, server: "https://acme.example.com" }
    const settle = "message/6f1e2d3c-4b5a-4968-8877-665544332211"
    await sendPush(iosToken, { ...payload, settle }, deps)
    await sendPush(androidToken, { ...payload, settle }, deps)
    const apns = JSON.parse(transport.requests[0].body) as { settle?: string }
    expect(apns.settle).toBe(settle)
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as { message: { data: { settle?: string } } }
    expect(fcm.message.data.settle).toBe(settle)
  })

  it("carries an attention item's route in the APNs and FCM payloads, and none when absent", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    transport.enqueue({ status: 200, body: "" })
    const deps = { transport, credentials, server: "https://acme.example.com" }
    const route = "attention/kernel/approval_request/8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f"
    const routed = {
      ...payload,
      type: "attention" as const,
      threadId: "",
      deepLink: `liaison://${route}`,
      route,
    }
    await sendPush(iosToken, routed, deps)
    await sendPush(androidToken, routed, deps)
    await sendPush(iosToken, payload, deps)
    const apns = JSON.parse(transport.requests[0].body) as { route?: string; deepLink?: string }
    expect(apns.route).toBe(route)
    expect(apns.deepLink).toBe(`liaison://${route}`)
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as { message: { data: { route?: string } } }
    expect(fcm.message.data.route).toBe(route)
    const plain = JSON.parse(transport.requests[transport.requests.length - 1].body) as {
      route?: string
    }
    expect("route" in plain).toBe(false)
  })

  it("defaults the payload's server to the origin of BASE_URL", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    await sendPush(iosToken, payload, { transport, credentials })
    const apns = JSON.parse(transport.requests[0].body) as { server?: string }
    expect(apns.server).toBe(new URL(env.BASE_URL).origin)
  })
  it("a thread-less item stacks and collapses by its route, a summary by its group, and FCM gets the same tag", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({ status: 200, body: "" })
    // FCM: the OAuth answer is used only when no token is cached yet (an
    // earlier case may have fetched one), so the send is found by its URL.
    transport.enqueue({
      status: 200,
      body: JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
    })
    transport.enqueue({ status: 200, body: "{}" })
    const route = "attention/kernel/approval_request/8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f"
    const routed = { ...payload, type: "attention" as const, threadId: "", route }
    const summary = {
      type: "attention" as const,
      deepLink: "liaison://attention",
      badgeCount: 9,
      title: "Ops Agent",
      body: "23 new messages in 23 tasks",
      collapseId: "burst:org-1",
      groupId: "burst:org-1",
    }
    await sendPush(iosToken, routed, { transport, credentials })
    await sendPush(iosToken, summary, { transport, credentials })
    await sendPush(androidToken, routed, { transport, credentials })
    const item = JSON.parse(transport.requests[0].body) as { aps: Record<string, unknown> }
    expect(item.aps["thread-id"]).toBe(`item:${route}`)
    const itemCollapse = transport.requests[0].headers["apns-collapse-id"]
    expect(itemCollapse).toStartWith("item:")
    expect(Buffer.byteLength(itemCollapse ?? "")).toBeLessThanOrEqual(64)
    const burst = JSON.parse(transport.requests[1].body) as { aps: Record<string, unknown> }
    expect(burst.aps["thread-id"]).toBe("burst:org-1")
    expect(transport.requests[1].headers["apns-collapse-id"]).toBe("burst:org-1")
    const fcmSend = transport.requests.find((r) => r.url.endsWith("/messages:send"))
    const fcm = JSON.parse(fcmSend?.body ?? "{}") as {
      message: { android: { notification: { tag?: string } } }
    }
    expect(fcm.message.android.notification.tag).toBe(itemCollapse)
  })
})
