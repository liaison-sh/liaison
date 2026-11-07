// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE-TIME CONNECT LINKS: connecting a person's OWN account (their Gmail, their
// calendar) for them, without anyone clicking through Settings on their behalf.
//
// An admin (or the operator's CLI, `liaison connect <app>/<connection> --for
// <email>`) mints a link for one person. The link is a Liaison URL holding a
// random token; only the token's hash is stored, bound to the org, the person's
// user id and the app connection. Opening it NEVER signs anyone in: the person
// signs in the normal way, and the link then works only when the signed-in user
// IS the person it was minted for. Anyone else (the admin who minted it, a
// colleague it was forwarded to) is told to sign in as that person and open it
// again, and the link stays usable for the right person.
//
// Redeeming consumes the link atomically (GETDEL: a second redemption finds
// nothing) and starts the same browser-bound OAuth flow as the in-app Connect
// button: `ownerType: "user"`, `ownerId` = the signed-in user, and the state
// cookie binding the callback to this browser (lib/oauth-browser-binding.ts).
// The connection that lands is that person's personal connection. A link lives
// at most 30 minutes.
//
// No crypto changes here: a mailbox's mode (transparent or private) is the
// person's own pick, made on the link's page with the same preference route as
// Settings > Mail, and a private mailbox's password is set in that browser.

import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { getSystemEmailProvider } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { generateToken, hashToken } from "~/lib/crypto"
import { appsLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { getFrontendRedirectUrl } from "~/modules/apps/connections/service"
import { writeAuditLog } from "~/modules/audit/service"
import { getOrgEmailConfig, getOrgSenderTransport } from "~/modules/org/email-from"
import { hasScope } from "~/modules/permissions/permissions"

const log = appsLogger.child({ module: "connect-links" })

/** A link lives at most this long (and at least as long as an OAuth state). */
export const CONNECT_LINK_TTL_SECONDS = 30 * 60
/** The web page the link opens. */
export const CONNECT_LINK_PATH = "/connect/link"
const KEY_PREFIX = "connect:link"

/** What is stored under the token's hash. */
interface ConnectLinkRecord {
  orgId: string
  userId: string
  email: string
  appName: string
  connectionName: string
  /** Who minted it: a user id, or null for the operator's CLI. */
  mintedBy: string | null
  /** Epoch ms; the key's own expiry is the same instant. */
  expiresAt: number
}

/** The Redis key of a token (only its hash is ever stored). */
export function connectLinkKey(token: string): string {
  return `${KEY_PREFIX}:${connectLinkId(token)}`
}

/** A link's id: its token's hash, never the token. */
export function connectLinkId(token: string): string {
  return hashToken(token)
}

/**
 * Why a connect started from a link did not complete. The callback writes it
 * (app.ts) under the link's id, so whoever waits on the link (`liaison connect
 * --for`) stops with the reason instead of waiting until the link expires.
 */
export interface ConnectLinkRefusal {
  /** One of CONNECT_FAILURE_REASONS (@liaison/shared). */
  reason: string
  /** The sentence the person was shown. */
  message: string
}

const OUTCOME_PREFIX = "connect:link-outcome"
/** Kept as long as anyone may still wait on the link (its life + the OAuth state's). */
const OUTCOME_TTL_SECONDS = CONNECT_LINK_TTL_SECONDS + 15 * 60

export async function recordConnectLinkRefusal(
  linkId: string,
  refusal: ConnectLinkRefusal,
): Promise<void> {
  await redis.set(
    `${OUTCOME_PREFIX}:${linkId}`,
    JSON.stringify({ reason: refusal.reason, message: refusal.message.slice(0, 1000) }),
    "EX",
    OUTCOME_TTL_SECONDS,
  )
}

/** The refusal recorded for a link's token, if its connect was refused. */
export async function readConnectLinkRefusal(token: string): Promise<ConnectLinkRefusal | null> {
  const raw = await redis.get(`${OUTCOME_PREFIX}:${connectLinkId(token)}`)
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as Partial<ConnectLinkRefusal>
    return typeof r.reason === "string" && typeof r.message === "string"
      ? { reason: r.reason, message: r.message }
      : null
  } catch {
    return null
  }
}

const REDEEMED_PREFIX = "connect:link-redeemed"

/**
 * Where a link stands, read from the server's own record: `open` (not used
 * yet, until `expiresAt`), `redeemed` (its person started the connect, so a
 * connection may still land) or `expired` (gone without being used: nothing
 * can come of it any more). `liaison connect --for` stops on `expired`.
 */
export type ConnectLinkStatus =
  | { status: "open"; expiresAt: Date }
  | { status: "redeemed" }
  | { status: "expired" }

export async function readConnectLinkStatus(token: string): Promise<ConnectLinkStatus> {
  const record = parseRecord(await redis.get(connectLinkKey(token)))
  if (record && record.expiresAt > Date.now()) {
    return { status: "open", expiresAt: new Date(record.expiresAt) }
  }
  if (await redis.exists(`${REDEEMED_PREFIX}:${connectLinkId(token)}`)) {
    return { status: "redeemed" }
  }
  return { status: "expired" }
}

/** Where a refused link connect sends the browser: the link's page, saying why. */
export async function connectLinkRefusedUrl(
  orgId: string,
  refusal: ConnectLinkRefusal,
): Promise<string> {
  return getFrontendRedirectUrl(
    orgId,
    CONNECT_LINK_PATH,
    new URLSearchParams({
      oauth_error: refusal.reason,
      oauth_error_description: refusal.message,
    }),
  )
}

/** Who asks for a link: a signed-in person (with their scopes) or the privileged CLI. */
export type ConnectLinkMinter = { kind: "cli" } | { kind: "user"; userId: string; scopes: string[] }

export class ConnectLinkError extends Error {
  readonly status: 400 | 403 | 404
  constructor(
    readonly code:
      | "not_oauth"
      | "unknown_connection"
      | "user_not_found"
      | "not_allowed"
      | "invalid_ref",
    message: string,
  ) {
    super(message)
    this.name = "ConnectLinkError"
    this.status =
      code === "not_allowed"
        ? 403
        : code === "user_not_found" || code === "unknown_connection"
          ? 404
          : 400
  }
}

export interface MintedConnectLink {
  url: string
  token: string
  expiresAt: Date
  user: { id: string; email: string; name: string }
}

async function findUserByEmail(
  orgId: string,
  email: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const rows = await withPrivilegedDb(orgId, "connect-link-user", (tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name, status: users.status })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, email.trim().toLowerCase())))
      .limit(1),
  )
  const row = rows[0]
  return row && row.status === "active" ? { id: row.id, email: row.email, name: row.name } : null
}

/**
 * What a mint checks before anything is written: the connection is an OAuth
 * one here, the address is an active member, and sending it to someone else
 * takes the connection's admin scope. The member, or a ConnectLinkError.
 * Also the agent tool's stage-time preflight (nothing is minted there).
 */
export async function checkConnectLinkMint(input: {
  orgId: string
  email: string
  appName: string
  connectionName: string
  minter: ConnectLinkMinter
}): Promise<NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>> {
  const { orgId, appName, connectionName, minter } = input
  const config = connectionConfigRegistry.get([orgId, appName, connectionName])
  if (!config) {
    throw new ConnectLinkError(
      "unknown_connection",
      `No connection "${appName}/${connectionName}" here (is the app on?)`,
    )
  }
  if (config.type !== "oauth2") {
    throw new ConnectLinkError(
      "not_oauth",
      `${appName}/${connectionName} takes credentials, not a sign-in: it has no connect link`,
    )
  }
  const user = await findUserByEmail(orgId, input.email)
  if (!user) {
    throw new ConnectLinkError(
      "user_not_found",
      `No active member with the address ${input.email} in this organization`,
    )
  }
  if (
    minter.kind === "user" &&
    minter.userId !== user.id &&
    !hasScope(connectionAdminScope(orgId, appName, connectionName), minter.scopes)
  ) {
    throw new ConnectLinkError(
      "not_allowed",
      `Sending a connect link to someone else takes ${connectionAdminScope(orgId, appName, connectionName)}`,
    )
  }

  return user
}

/**
 * Mint a one-time link for `email` to connect `<appName>/<connectionName>` as
 * their own. Only an admin of that connection (its admin scope) or the
 * privileged CLI may mint one for somebody else.
 */
export async function mintConnectLink(input: {
  orgId: string
  email: string
  appName: string
  connectionName: string
  minter: ConnectLinkMinter
  /** Tests shorten it; never longer than CONNECT_LINK_TTL_SECONDS. */
  ttlSeconds?: number
}): Promise<MintedConnectLink> {
  const { orgId, appName, connectionName, minter } = input
  const user = await checkConnectLinkMint(input)

  const ttl = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? CONNECT_LINK_TTL_SECONDS)),
    CONNECT_LINK_TTL_SECONDS,
  )
  const token = generateToken(32)
  const expiresAt = Date.now() + ttl * 1000
  const record: ConnectLinkRecord = {
    orgId,
    userId: user.id,
    email: user.email,
    appName,
    connectionName,
    mintedBy: minter.kind === "user" ? minter.userId : null,
    expiresAt,
  }
  await redis.set(connectLinkKey(token), JSON.stringify(record), "EX", ttl)
  await withPrivilegedDb(orgId, "connect-link-audit", (tx) =>
    writeAuditLog(tx, {
      orgId,
      actorId: minter.kind === "user" ? minter.userId : "system:cli",
      actorType: minter.kind === "user" ? "user" : "system",
      app: "kernel",
      entityType: "users",
      entityId: user.id,
      action: "connection.link.minted",
      metadata: { appName, connectionName, expiresAt: new Date(expiresAt).toISOString() },
    }),
  )
  const url = await getFrontendRedirectUrl(orgId, CONNECT_LINK_PATH, new URLSearchParams({ token }))
  return { url, token, expiresAt: new Date(expiresAt), user }
}

/** The signed-in person opening a link. */
export interface ConnectLinkSession {
  orgId: string
  userId: string
}

export type ConnectLinkView =
  | { status: "ok"; appName: string; connectionName: string; email: string; expiresAt: string }
  /** Somebody else is signed in: the link stays usable for its person. */
  | { status: "wrong_user"; email: string }
  /** Unknown, already used or expired: the same answer for all three. */
  | { status: "invalid" }

function parseRecord(raw: string | null): ConnectLinkRecord | null {
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as ConnectLinkRecord
    return typeof r.userId === "string" && typeof r.orgId === "string" ? r : null
  } catch {
    return null
  }
}

function view(record: ConnectLinkRecord | null, session: ConnectLinkSession, now: number) {
  if (!record || record.expiresAt <= now) return { status: "invalid" } as const
  // Another organization's session learns nothing about the link, not even
  // whose it is: the same answer as an unknown one.
  if (record.orgId !== session.orgId) return { status: "invalid" } as const
  if (record.userId !== session.userId) {
    return { status: "wrong_user", email: record.email } as const
  }
  return { status: "ok", record } as const
}

/** What the link's page shows before the person continues. Consumes nothing. */
export async function peekConnectLink(
  token: string,
  session: ConnectLinkSession,
  now: number = Date.now(),
): Promise<ConnectLinkView> {
  if (typeof token !== "string" || token.length < 16) return { status: "invalid" }
  const v = view(parseRecord(await redis.get(connectLinkKey(token))), session, now)
  if (v.status !== "ok") return v
  return {
    status: "ok",
    appName: v.record.appName,
    connectionName: v.record.connectionName,
    email: v.record.email,
    expiresAt: new Date(v.record.expiresAt).toISOString(),
  }
}

export type ClaimOutcome =
  | { status: "claimed"; claim: ConnectLinkClaim }
  | { status: "wrong_user"; email: string }
  | { status: "invalid" }

/** A consumed link: what to connect, and how to give it back if the start fails. */
export interface ConnectLinkClaim {
  /** The link's id (connectLinkId), carried by the OAuth state it starts. */
  linkId: string
  appName: string
  connectionName: string
  /** Puts the link back for the time it had left (a start that failed). */
  restore: () => Promise<void>
  /** Records the redemption once the flow started. */
  redeemed: () => Promise<void>
}

/**
 * Claim a link for the signed-in person: refused (and left usable) for anyone
 * else; consumed atomically (whoever deletes the key redeems it). The caller
 * then starts the personal, browser-bound flow for the SESSION's org and user
 * (they are the link's, checked here); a start that fails (no OAuth client yet)
 * calls `restore`, so the person can retry once an admin fixes it.
 */
export async function claimConnectLink(
  token: string,
  session: ConnectLinkSession,
  now: number = Date.now(),
): Promise<ClaimOutcome> {
  if (typeof token !== "string" || token.length < 16) return { status: "invalid" }
  const key = connectLinkKey(token)
  const peeked = view(parseRecord(await redis.get(key)), session, now)
  if (peeked.status !== "ok") return peeked
  const taken = view(parseRecord(await redis.getdel(key)), session, now)
  if (taken.status !== "ok") return { status: "invalid" }
  const record = taken.record
  // Marked redeemed in the same breath as the take, so whoever waits on the
  // link never reads the gap as an expiry (readConnectLinkStatus).
  const redeemedKey = `${REDEEMED_PREFIX}:${connectLinkId(token)}`
  await redis.set(redeemedKey, "1", "EX", OUTCOME_TTL_SECONDS)
  return {
    status: "claimed",
    claim: {
      linkId: connectLinkId(token),
      appName: record.appName,
      connectionName: record.connectionName,
      restore: async () => {
        const left = record.expiresAt - Date.now()
        if (left > 0) await redis.set(key, JSON.stringify(record), "PX", left)
        await redis.del(redeemedKey)
      },
      redeemed: () =>
        withPrivilegedDb(session.orgId, "connect-link-redeem-audit", (tx) =>
          writeAuditLog(tx, {
            orgId: session.orgId,
            actorId: session.userId,
            actorType: "user",
            app: "kernel",
            entityType: "users",
            entityId: session.userId,
            action: "connection.link.redeemed",
            metadata: { appName: record.appName, connectionName: record.connectionName },
          }),
        ).catch((err) => log.warn({ err }, "connect link redeem audit failed")),
    },
  }
}

/** A connection's name for people: the app's own label when it has one. */
function connectionLabel(appName: string, connectionName: string): string {
  return `${appName}/${connectionName}`
}

/** Email the person their link (the in-app agent's way of sending it). */
export async function emailConnectLink(input: {
  orgId: string
  link: MintedConnectLink
  appName: string
  connectionName: string
  senderName: string | null
}): Promise<void> {
  const { link } = input
  const what = connectionLabel(input.appName, input.connectionName)
  const minutes = Math.max(1, Math.round((link.expiresAt.getTime() - Date.now()) / 60_000))
  const subject = `Connect your account to Liaison (${what})`
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: "Connect",
    heading: "Connect your own account",
    paragraphs: [
      `${input.senderName ?? "Your Liaison admin"} asks you to connect your own account for ${what}. It stays yours: a personal connection only you and your agent use.`,
      `Open the link and sign in to Liaison as ${link.user.email}. It works only for you, once, for the next ${minutes} minutes.`,
    ],
    cta: { label: "Connect my account", href: link.url },
    footer: [
      "If you weren't expecting this, ignore it: nothing happens until you sign in and consent.",
    ],
  })
  const emailConfig = await getOrgEmailConfig(input.orgId)
  // Managed edition: the org's own verified sender, else "<Org> via Liaison",
  // as invitations (modules/users/invites.ts). Null elsewhere: unchanged.
  const orgSender = await getOrgSenderTransport(input.orgId)
  await (orgSender?.provider ?? getSystemEmailProvider()).send({
    to: link.user.email,
    from: orgSender?.from ?? emailConfig.from,
    replyTo: emailConfig.replyTo,
    subject,
    html,
    text,
    template: "connections.connect-link",
  })
}
