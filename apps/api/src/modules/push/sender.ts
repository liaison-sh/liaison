// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One push, to one device token, through APNs or FCM.
//
// TWO THINGS ARE DELIBERATE HERE.
//
// The HTTP hop is an injected `PushTransport`, so the request BUILDER and the
// response CLASSIFIER (the two halves that can actually be wrong) are proven
// against a fake. There is no APNs key and no Firebase service account on the
// machine this was written on, and there may be none on the machine it first
// runs on either; a design that could only be tested with credentials would
// have shipped untested.
//
// A missing credential is a LOUD NO-OP, never a throw. The sender is called
// from a durable outbox consumer: a throw there leaves the event unprocessed
// and the outbox retries it forever, so an unconfigured deployment would wedge
// its own event pipeline over a notification nobody asked for. So the sender
// says once, at warn, exactly which env vars are missing, and returns
// `disabled` for every later call.
import { createHash, createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { FetchPushTransport } from "~/modules/push/transport"
import type {
  PushEnvironment,
  PushHostAttempt,
  PushHttpResponse,
  PushPayload,
  PushSendResult,
  PushTokenRow,
  PushTransport,
} from "~/modules/push/types"

const log = rootLogger.child({ module: "push-sender" })

/** What the OS shows when the payload carries no text, i.e. after redaction. */
export const GENERIC_PUSH_BODY = "New message"

export interface ApnsCredentials {
  keyId: string
  teamId: string
  bundleId: string
  /** The .p8 file's contents, already read. */
  key: string
}

export interface FcmCredentials {
  projectId: string
  clientEmail: string
  privateKey: string
}

export interface PushCredentials {
  apns?: ApnsCredentials
  fcm?: FcmCredentials
}

export interface SendPushDeps {
  transport?: PushTransport
  credentials?: PushCredentials
  /** Where the one-time "push disabled" notice goes. Defaults to the log. */
  onDisabled?: (message: string) => void
  now?: () => number
  /**
   * The origin this server is reached at, carried in every payload as
   * `server` so a phone set up for another server ignores the tap instead of
   * routing a thread id that means nothing there. Defaults to BASE_URL's.
   */
  server?: string
}

/** The origin of `raw`, or `raw` itself when it does not parse. */
function serverOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// Credentials, read from the environment BY NAME.
// ---------------------------------------------------------------------------

/** The env names each half needs, in the order the notice lists them. */
const APNS_ENV_NAMES = ["APNS_KEY_PATH", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"] as const
const FCM_ENV_NAMES = ["FCM_SERVICE_ACCOUNT_PATH", "FCM_PROJECT_ID"] as const

/** Every push credential name, resolved through the validated env snapshot. */
function readEnv(name: string): string | undefined {
  const values: Record<string, string | undefined> = {
    APNS_KEY_PATH: env.APNS_KEY_PATH,
    APNS_KEY_ID: env.APNS_KEY_ID,
    APNS_TEAM_ID: env.APNS_TEAM_ID,
    APNS_BUNDLE_ID: env.APNS_BUNDLE_ID,
    FCM_SERVICE_ACCOUNT_PATH: env.FCM_SERVICE_ACCOUNT_PATH,
    FCM_PROJECT_ID: env.FCM_PROJECT_ID,
  }
  const value = values[name]
  return value && value.trim() !== "" ? value.trim() : undefined
}

function loadApnsCredentials(): ApnsCredentials | { missing: string[] } {
  const missing = APNS_ENV_NAMES.filter((n) => readEnv(n) === undefined)
  if (missing.length > 0) return { missing: [...missing] }
  let key: string
  try {
    key = readFileSync(readEnv("APNS_KEY_PATH") as string, "utf8")
  } catch {
    // An unreadable key file is the same operational fact as an unset path:
    // nothing can be signed. It is reported under the name the operator set,
    // never as a stack trace out of a background consumer.
    return { missing: ["APNS_KEY_PATH"] }
  }
  return {
    keyId: readEnv("APNS_KEY_ID") as string,
    teamId: readEnv("APNS_TEAM_ID") as string,
    bundleId: readEnv("APNS_BUNDLE_ID") as string,
    key,
  }
}

function loadFcmCredentials(): FcmCredentials | { missing: string[] } {
  const missing = FCM_ENV_NAMES.filter((n) => readEnv(n) === undefined)
  if (missing.length > 0) return { missing: [...missing] }
  try {
    const raw = JSON.parse(readFileSync(readEnv("FCM_SERVICE_ACCOUNT_PATH") as string, "utf8")) as {
      client_email?: string
      private_key?: string
    }
    if (!raw.client_email || !raw.private_key) return { missing: ["FCM_SERVICE_ACCOUNT_PATH"] }
    return {
      projectId: readEnv("FCM_PROJECT_ID") as string,
      clientEmail: raw.client_email,
      privateKey: raw.private_key,
    }
  } catch {
    return { missing: ["FCM_SERVICE_ACCOUNT_PATH"] }
  }
}

/** The credentials the process was started with, resolved once. */
let cachedCredentials: PushCredentials | null = null

export function resolvePushCredentials(): PushCredentials {
  if (cachedCredentials) return cachedCredentials
  const apns = loadApnsCredentials()
  const fcm = loadFcmCredentials()
  cachedCredentials = {
    ...("missing" in apns ? {} : { apns }),
    ...("missing" in fcm ? {} : { fcm }),
  }
  return cachedCredentials
}

// ---------------------------------------------------------------------------
// The one-time notice.
// ---------------------------------------------------------------------------

const noticed = new Set<string>()

function noticeOnce(message: string, sink?: (m: string) => void): void {
  if (noticed.has(message)) return
  noticed.add(message)
  if (sink) sink(message)
  else log.warn({ reason: message }, message)
}

// ---------------------------------------------------------------------------
// JWTs.
// ---------------------------------------------------------------------------

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url")
}

function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: string,
  algorithm: "ES256" | "RS256",
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signer = createSign(algorithm === "ES256" ? "SHA256" : "RSA-SHA256")
  signer.update(signingInput)
  const signature = signer.sign(
    // ES256 in a JWT is the raw r||s pair, NOT the DER sequence node emits by
    // default. Apple rejects the DER form with a 403 InvalidProviderToken,
    // which reads like a bad key and is not one.
    algorithm === "ES256" ? { key: privateKey, dsaEncoding: "ieee-p1363" } : { key: privateKey },
  )
  return `${signingInput}.${base64url(signature)}`
}

/** Apple's provider token is valid for an hour; refresh a little early. */
const APNS_TOKEN_TTL_MS = 50 * 60 * 1000
let apnsTokenCache: { token: string; expiresAt: number } | null = null

function apnsProviderToken(credentials: ApnsCredentials, nowMs: number): string {
  if (apnsTokenCache && apnsTokenCache.expiresAt > nowMs) return apnsTokenCache.token
  const token = signJwt(
    { alg: "ES256", kid: credentials.keyId },
    { iss: credentials.teamId, iat: Math.floor(nowMs / 1000) },
    credentials.key,
    "ES256",
  )
  apnsTokenCache = { token, expiresAt: nowMs + APNS_TOKEN_TTL_MS }
  return token
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
let fcmTokenCache: { token: string; expiresAt: number } | null = null

async function fcmAccessToken(
  credentials: FcmCredentials,
  transport: PushTransport,
  nowMs: number,
): Promise<string | null> {
  if (fcmTokenCache && fcmTokenCache.expiresAt > nowMs) return fcmTokenCache.token
  const iat = Math.floor(nowMs / 1000)
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    },
    credentials.privateKey,
    "RS256",
  )
  const response = await transport.request({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  })
  if (response.status !== 200) return null
  const parsed = JSON.parse(response.body) as { access_token?: string; expires_in?: number }
  if (!parsed.access_token) return null
  fcmTokenCache = {
    token: parsed.access_token,
    expiresAt: nowMs + Math.max(60, (parsed.expires_in ?? 3600) - 300) * 1000,
  }
  return fcmTokenCache.token
}

// ---------------------------------------------------------------------------
// Classifiers. Exported because they are the half a test can pin exactly.
// ---------------------------------------------------------------------------

/**
 * APNs reasons that mean "this device is gone", per Apple's status table, and
 * NOTHING ELSE. `invalid_token` is the one verdict the fanout answers by
 * DELETING the row, so this set is the blast radius of a classification
 * mistake: every reason that can also be produced by OUR misconfiguration has
 * to stay out of it. `DeviceTokenNotForTopic` is exactly that reason, a topic
 * that does not match the key, so a single wrong `APNS_TOPIC` would have
 * unregistered every iOS device in the org on the next fanout. A refusal we
 * caused is `permanent`: the message is not retried, the device is kept.
 */
const APNS_DEAD_REASONS = new Set(["Unregistered", "BadDeviceToken"])

export function classifyApnsResponse(response: PushHttpResponse): PushSendResult {
  if (response.status === 200) return { kind: "sent" }
  const reason = apnsReason(response)
  if (response.status === 410 || APNS_DEAD_REASONS.has(reason)) {
    const unregisteredAt = response.status === 410 ? apnsTimestamp(response) : null
    return {
      kind: "invalid_token",
      detail: reason || "410",
      ...(unregisteredAt ? { unregisteredAt } : {}),
    }
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "transient", detail: String(response.status) }
  }
  return { kind: "permanent", detail: reason || String(response.status) }
}

export function classifyFcmResponse(response: PushHttpResponse): PushSendResult {
  if (response.status >= 200 && response.status < 300) return { kind: "sent" }
  let errorCode = ""
  try {
    const parsed = JSON.parse(response.body) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> }
    }
    errorCode =
      parsed.error?.details?.find((d) => typeof d.errorCode === "string")?.errorCode ??
      parsed.error?.status ??
      ""
  } catch {
    errorCode = ""
  }
  // UNREGISTERED is the ONLY FCM verdict that means the device is gone, so it
  // is the only one that deletes the row. `INVALID_ARGUMENT` is what FCM
  // answers for a malformed message, and a bare 404 (no UNREGISTERED detail)
  // is what it answers for a wrong project id, i.e. both are OUR mistakes: one
  // bad payload or one wrong `FCM_PROJECT_ID` would otherwise unregister every
  // Android device in the org on a single fanout, and every phone would stay
  // silent until its owner reinstalled. They are `permanent` instead, the
  // vocabulary this module already has for "the provider refused this message
  // and will refuse it again": no retry, no deletion.
  if (errorCode === "UNREGISTERED") {
    return { kind: "invalid_token", detail: errorCode }
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "transient", detail: String(response.status) }
  }
  return { kind: "permanent", detail: errorCode || String(response.status) }
}

// ---------------------------------------------------------------------------
// The send.
// ---------------------------------------------------------------------------

function alert(payload: PushPayload): { title: string; body: string } {
  // No title and no body is the redacted case. The wording is a CONSTANT: it
  // is derived from nothing about the message, so it can leak nothing about it.
  return {
    title: payload.title ?? "Liaison",
    body: payload.body ?? GENERIC_PUSH_BODY,
  }
}

/** The organisation's name, trimmed, or null when the payload names none. */
function labelOf(payload: PushPayload): string | null {
  const label = payload.serverLabel?.trim()
  return label ? label : null
}

/**
 * The label the ALERT shows: only for a device that knows several servers.
 * The data always carries it (the app's own notice reads it).
 */
function alertLabelOf(token: PushTokenRow, payload: PushPayload): string | null {
  return token.multiServer === true ? labelOf(payload) : null
}

/**
 * The FCM title, which is the only line Android shows above the body: on a
 * phone that knows several servers the organisation's name leads it ("Acme:
 * Alice"), and a redacted push (whose title is the constant) is titled by the
 * organisation alone. A phone on one server gets the title as it is.
 */
export function fcmTitle(payload: PushPayload, label: string | null = labelOf(payload)): string {
  const { title } = alert(payload)
  if (label === null) return title
  if (payload.title === undefined) return label
  return `${label}: ${title}`
}

/**
 * The lock-screen stack a push joins (APNs `thread-id`): its conversation.
 * A thread push stacks by thread (a task's discussion is the task's thread),
 * a session push by session, a thread-less item by its route, a summary by
 * its group. The prefixes keep the namespaces apart.
 */
export function pushThreadId(payload: PushPayload): string {
  if (payload.threadId) return payload.threadId
  if (payload.sessionId) return `session:${payload.sessionId}`
  if (payload.groupId) return payload.groupId
  if (payload.route) return `item:${payload.route}`
  return "liaison"
}

/** APNs caps `apns-collapse-id` at 64 bytes. */
const COLLAPSE_ID_MAX = 64

/**
 * The push's collapse id: the payload's own when it sets one, else its
 * conversation, so a newer push about the same conversation replaces the
 * older banner instead of piling up (every message stays in the app).
 */
export function pushCollapseId(payload: PushPayload): string | undefined {
  if (payload.collapseId) return payload.collapseId
  const key = payload.threadId
    ? `thread:${payload.threadId}`
    : payload.route
      ? `item:${createHash("sha256").update(payload.route).digest("hex").slice(0, 40)}`
      : undefined
  return key && Buffer.byteLength(key) <= COLLAPSE_ID_MAX ? key : undefined
}

function apnsBody(payload: PushPayload, server: string, alertLabel: string | null): string {
  const label = labelOf(payload)
  return JSON.stringify({
    aps: {
      // The subtitle names the organisation, under the title, on the lock
      // screen and the banner alike, on a phone that knows several servers.
      alert: { ...alert(payload), ...(alertLabel ? { subtitle: alertLabel } : {}) },
      badge: payload.badgeCount,
      // A silent push (a throttled session push) replaces its banner quietly.
      ...(payload.silent ? { "interruption-level": "passive" } : { sound: "default" }),
      // Lock-screen grouping: a thread push groups by thread, a session push
      // by session (the prefix keeps the two namespaces apart).
      "thread-id": pushThreadId(payload),
      // A3: every alert goes through the Notification Service Extension,
      // text-less redacted ones included, so it can post its `received`.
      "mutable-content": 1,
    },
    type: payload.type,
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    deepLink: payload.deepLink,
    ...(payload.replyRootId ? { replyRootId: payload.replyRootId } : {}),
    ...(payload.route ? { route: payload.route } : {}),
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
    ...(payload.settle ? { settle: payload.settle } : {}),
    ...(label ? { serverLabel: label } : {}),
    server,
  })
}

function fcmBody(
  token: string,
  payload: PushPayload,
  server: string,
  alertLabel: string | null,
): string {
  const { body } = alert(payload)
  const label = labelOf(payload)
  return JSON.stringify({
    message: {
      token,
      notification: { title: fcmTitle(payload, alertLabel), body },
      // FCM data values must be strings, so the badge travels as one.
      data: {
        type: payload.type,
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        deepLink: payload.deepLink,
        ...(payload.replyRootId ? { replyRootId: payload.replyRootId } : {}),
        ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
        ...(payload.route ? { route: payload.route } : {}),
        ...(payload.messageId ? { messageId: payload.messageId } : {}),
        ...(payload.settle ? { settle: payload.settle } : {}),
        ...(label ? { serverLabel: label } : {}),
        badgeCount: String(payload.badgeCount),
        server,
      },
      android: {
        notification: {
          notification_count: payload.badgeCount,
          // Android's equivalent of the collapse id: the newer replaces the older.
          ...(pushCollapseId(payload) ? { tag: pushCollapseId(payload) } : {}),
          ...(payload.silent ? { notification_priority: "PRIORITY_LOW" } : {}),
        },
      },
    },
  })
}

/**
 * The APNs host is a property of the TOKEN (S11), not of the process: an Xcode
 * build holds a sandbox token and a TestFlight build a production one, and
 * both can be registered against the same server at once. A token with no
 * recorded environment is `production`.
 */
const APNS_HOSTS: Record<PushEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
}

function otherEnvironment(environment: PushEnvironment): PushEnvironment {
  return environment === "sandbox" ? "production" : "sandbox"
}

function apnsReason(response: PushHttpResponse): string {
  try {
    return (JSON.parse(response.body) as { reason?: string }).reason ?? ""
  } catch {
    return ""
  }
}

/**
 * The `timestamp` of an APNs 410 (milliseconds since the epoch): when APNs
 * last confirmed the token was no longer valid for the topic. Apple's rule is
 * to stop sending only if the token was not registered again after it.
 */
function apnsTimestamp(response: PushHttpResponse): Date | null {
  try {
    const value = (JSON.parse(response.body) as { timestamp?: unknown }).timestamp
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
    return new Date(value)
  } catch {
    return null
  }
}

async function sendApns(
  token: PushTokenRow,
  payload: PushPayload,
  credentials: ApnsCredentials,
  transport: PushTransport,
  nowMs: number,
  server: string,
): Promise<PushSendResult> {
  const collapseId = pushCollapseId(payload)
  return postApns(
    token,
    credentials,
    transport,
    nowMs,
    {
      "apns-priority": "10",
      ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
    },
    apnsBody(payload, server, alertLabelOf(token, payload)),
  )
}

/**
 * One APNs request on the token's recorded host, and on the other host when
 * the first answers BadDeviceToken. Every APNs send goes through it.
 */
async function postApns(
  token: PushTokenRow,
  credentials: ApnsCredentials,
  transport: PushTransport,
  nowMs: number,
  headers: Record<string, string>,
  body: string,
): Promise<PushSendResult> {
  const post = (environment: PushEnvironment) =>
    transport.request({
      url: `${APNS_HOSTS[environment]}/3/device/${token.token}`,
      method: "POST",
      headers: {
        authorization: `bearer ${apnsProviderToken(credentials, nowMs)}`,
        "apns-topic": credentials.bundleId,
        "apns-push-type": "alert",
        ...headers,
        "content-type": "application/json",
      },
      body,
    })
  const recorded = token.environment ?? "production"
  const first = await post(recorded)
  const hosts: PushHostAttempt[] = [hostAttempt(recorded, first)]
  // BadDeviceToken is also what a host answers for a token issued by the
  // OTHER one, so a row whose recorded environment is wrong (an old client, a
  // device moved from Xcode to TestFlight) is tried once on the other host.
  // The device is dead only when both refuse it.
  if (apnsReason(first) !== "BadDeviceToken") return { ...classifyApnsResponse(first), hosts }
  const other = otherEnvironment(recorded)
  const secondResponse = await post(other)
  hosts.push(hostAttempt(other, secondResponse))
  const second = classifyApnsResponse(secondResponse)
  return second.kind === "sent" ? { ...second, environment: other, hosts } : { ...second, hosts }
}

function hostAttempt(environment: PushEnvironment, response: PushHttpResponse): PushHostAttempt {
  const reason = apnsReason(response)
  return { environment, status: response.status, ...(reason ? { reason } : {}) }
}

export async function sendPush(
  token: PushTokenRow,
  payload: PushPayload,
  deps: SendPushDeps = {},
): Promise<PushSendResult> {
  const transport = deps.transport ?? new FetchPushTransport()
  const credentials = deps.credentials ?? resolvePushCredentials()
  const nowMs = deps.now ? deps.now() : Date.now()
  const server = serverOrigin(deps.server ?? env.BASE_URL)

  if (token.platform === "ios") {
    if (!credentials.apns) {
      noticeOnce(`push disabled: ${APNS_ENV_NAMES.join(", ")}`, deps.onDisabled)
      return { kind: "disabled" }
    }
    return sendApns(token, payload, credentials.apns, transport, nowMs, server)
  }

  if (!credentials.fcm) {
    noticeOnce(`push disabled: ${FCM_ENV_NAMES.join(", ")}`, deps.onDisabled)
    return { kind: "disabled" }
  }
  const accessToken = await fcmAccessToken(credentials.fcm, transport, nowMs)
  if (!accessToken) return { kind: "transient", detail: "fcm oauth exchange failed" }
  const response = await transport.request({
    url: `https://fcm.googleapis.com/v1/projects/${credentials.fcm.projectId}/messages:send`,
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: fcmBody(token.token, payload, server, alertLabelOf(token, payload)),
  })
  const result = classifyFcmResponse(response)
  return {
    ...result,
    hosts: [{ status: response.status, ...(result.detail ? { reason: result.detail } : {}) }],
  }
}

/**
 * THE BADGE SYNC PUSH (rule 5, read once, read everywhere). After a read on
 * any device, the phone's icon takes the new count without waiting for the
 * next message: an APNs notification whose `aps` holds the badge and nothing
 * else. It shows no banner, plays no sound and wakes no extension (no
 * `mutable-content`), so it needs no new app build. Low priority (5): Apple
 * may batch it, which a badge can afford. iOS only: an Android launcher counts
 * the notifications it shows, so there is nothing to set there.
 */
export function apnsBadgeSyncBody(count: number): string {
  return JSON.stringify({ aps: { badge: Math.max(0, Math.trunc(count)) } })
}

export async function sendBadgeSync(
  token: PushTokenRow,
  count: number,
  deps: SendPushDeps = {},
): Promise<PushSendResult> {
  if (token.platform !== "ios") return { kind: "disabled" }
  const transport = deps.transport ?? new FetchPushTransport()
  const credentials = deps.credentials ?? resolvePushCredentials()
  if (!credentials.apns) {
    noticeOnce(`push disabled: ${APNS_ENV_NAMES.join(", ")}`, deps.onDisabled)
    return { kind: "disabled" }
  }
  const nowMs = deps.now ? deps.now() : Date.now()
  // `apns-expiration: 0`: delivered now or never. APNs stores one notification
  // per device for an offline phone, so a stored badge-only push would replace
  // a real alert waiting there; the next alert carries the badge anyway.
  return postApns(
    token,
    credentials.apns,
    transport,
    nowMs,
    { "apns-priority": "5", "apns-expiration": "0" },
    apnsBadgeSyncBody(count),
  )
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PushSenderTestAccess = {
  /** Test seam: forget which notices have been said, so a case can see the first. */
  resetDisabledNotice(): void {
    noticed.clear()
    cachedCredentials = null
  },
}
