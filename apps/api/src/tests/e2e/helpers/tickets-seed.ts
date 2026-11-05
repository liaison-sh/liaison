// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tickets, inboxes, their connected accounts and API keys for api end-to-end
// scenarios. Every row is made by the seed engine's factories in the server
// under test (`POST /api/_test/seed`, test-support/seed/factories.ts): the
// scenario runs in another process, so a row the running server's services,
// caches and RLS must recognise is made there, never by raw SQL from here.
// Only reads stay here (schema names for a scenario's own SELECTs, and which
// user a bare org's rows are made by).
import type { WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed-factory"

export function ks(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

export function ts(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

export function bridgeAuditSchema(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_test_bridge_a"` : "app_test_bridge_a"
}

const MINUTE_MS = 60_000

/**
 * Who the services act for in `orgId`: undefined (the factory takes the org's
 * admin) unless the org has no users of its own, as the bare orgs cross-org
 * scenarios insert; then any user of the schema, the way the old fixtures
 * named a `created_by`. Read only.
 */
async function actingUserFor(env: WorkerEnv, orgId: string): Promise<string | undefined> {
  const own = (await env.db.sql.unsafe(
    `SELECT id FROM ${ks(env)}.users WHERE org_id = $1 LIMIT 1`,
    [orgId],
  )) as Array<{ id: string }>
  if (own[0]) return undefined
  const any = (await env.db.sql.unsafe(
    `SELECT id FROM ${ks(env)}.users ORDER BY created_at ASC LIMIT 1`,
  )) as Array<{ id: string }>
  if (!any[0]) throw new Error(`tickets seed: no users in the schema to act for org ${orgId}`)
  return any[0].id
}

/** Minutes between an ISO instant and now (0 for the future). */
function minutesAgo(iso: string): number {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / MINUTE_MS)
}

interface SeedTicketParams {
  orgId: string
  subject?: string
  /** open | awaiting_customer | awaiting_followup | closed (checked by the factory). */
  status?: string
  priority?: "low" | "normal" | "high" | "urgent"
  team?: string | null
  sensitivity?: "internal" | "confidential" | "restricted"
  contactId?: string | null
  assignedTo?: string | null
  sourceInboxId?: string | null
  externalRef?: string | null
  /** resolved | merged | spam | duplicate | no_response (checked by the factory). */
  closedReason?: string | null
  mergedIntoTicketId?: string | null
  /** Backdate the ticket and its SLA clock (`createTicket`'s `createdAt`). */
  createdMinutesAgo?: number
  /**
   * The customer's message: the ticket opens with it at this time (the ticket
   * and its SLA clock are created then). Omitted or null: no message at all.
   */
  lastInboundAt?: string | null
  /** The thread's latest message: the customer's, at this time, when `lastInboundAt` is not given. */
  lastMessageAt?: string | null
  /** An answer sent to the customer at this time (a later message of the thread). */
  lastOutboundAt?: string
  /** When the ticket was first answered. */
  firstResponseAt?: string
  /** Snoozed until then (`awaiting_followup`); a time in the past is a snooze come due. */
  followupAt?: string
  followupReason?: string
}

export interface SeededTicket {
  id: string
  handle: string
  replyToken: string
}

/** A ticket through `createTicket` (`tickets.ticket`), with the clock and thread the params name. */
export async function seedTicket(env: WorkerEnv, params: SeedTicketParams): Promise<SeededTicket> {
  const actingUserId = await actingUserFor(env, params.orgId)
  const subject = params.subject ?? "Seeded ticket"
  const inboundAt = params.lastInboundAt ?? params.lastMessageAt ?? null
  const createdMinutesAgo =
    params.createdMinutesAgo ?? (inboundAt ? minutesAgo(inboundAt) : undefined)
  const ticket = await seedFactory<{ id: string; handle: string }>(
    env,
    params.orgId,
    "tickets.ticket",
    {
      subject,
      ...(params.status && !params.followupAt ? { status: params.status } : {}),
      ...(params.priority ? { priority: params.priority } : {}),
      ...(params.closedReason ? { closedReason: params.closedReason } : {}),
      ...(params.team ? { team: params.team } : {}),
      ...(params.sensitivity ? { sensitivity: params.sensitivity } : {}),
      sourceInboxId: params.sourceInboxId ?? null,
      contactId: params.contactId ?? null,
      assignedTo: params.assignedTo ?? null,
      externalRef: params.externalRef ?? null,
      mergedIntoTicketId: params.mergedIntoTicketId ?? null,
      withInboundMessage: Boolean(inboundAt),
      ...(createdMinutesAgo !== undefined ? { createdMinutesAgo } : {}),
      ...(params.firstResponseAt
        ? { firstResponseMinutesAgo: minutesAgo(params.firstResponseAt) }
        : {}),
      ...(params.followupAt
        ? { followup: { at: params.followupAt, reason: params.followupReason ?? "follow up" } }
        : {}),
      ...(actingUserId ? { actingUserId } : {}),
    },
  )
  if (params.lastOutboundAt) {
    await seedFactory(env, params.orgId, "tickets.messages", {
      ticketId: ticket.id,
      messages: [
        {
          kind: "outbound",
          textBody: "Thanks, we are on it.",
          sentAtOffsetSeconds: (new Date(params.lastOutboundAt).getTime() - Date.now()) / 1000,
        },
      ],
      ...(actingUserId ? { actingUserId } : {}),
    })
  }
  // The reply address token is the ticket's own, read back (no factory hands it out).
  const [row] = (await env.db.sql.unsafe(
    `SELECT reply_token FROM ${ts(env)}.tickets WHERE id = $1`,
    [ticket.id],
  )) as Array<{ reply_token: string }>
  return { id: ticket.id, handle: ticket.handle, replyToken: row?.reply_token ?? "" }
}

/** A connected account with a placeholder (or the given) access token (`connections.mock`). */
export async function seedConnectedAccount(
  env: WorkerEnv,
  params: {
    orgId: string
    email: string
    /** Who connected it. Default: the org's first user (any user for a bare org). */
    createdBy?: string
    appName?: string
    accessToken?: string
  },
): Promise<{ id: string }> {
  const userId = params.createdBy ?? (await resolveOrgUserId(env, params.orgId))
  const identifier = params.email.toLowerCase()
  const { id } = await seedFactory<{ id: string }>(env, params.orgId, "connections.mock", {
    appName: params.appName ?? "tickets",
    connectionName: "gmail",
    ownerType: "org",
    userId,
    identifier,
    displayName: identifier,
    kind: {
      type: "oauth2",
      ...(params.accessToken ? { accessToken: params.accessToken } : {}),
    },
  })
  return { id }
}

/** The org's first user, else any user of the schema (bare orgs). Read only. */
async function resolveOrgUserId(env: WorkerEnv, orgId: string): Promise<string> {
  const rows = (await env.db.sql.unsafe(
    `SELECT id FROM ${ks(env)}.users
     ORDER BY (org_id = $1) DESC, created_at ASC
     LIMIT 1`,
    [orgId],
  )) as Array<{ id: string }>
  const userId = rows[0]?.id
  if (!userId) throw new Error(`seedConnectedAccount: no users in schema to own created_by`)
  return userId
}

export interface SeedTicketMessageInput {
  kind: "inbound" | "outbound" | "note"
  textBody: string
  htmlBody?: string
  fromEmail?: string | null
  fromName?: string | null
  subject?: string | null
  sentAtOffsetSeconds?: number
}

/** Later messages of a ticket's thread (`tickets.messages`, history), oldest first. */
export async function seedTicketMessages(
  env: WorkerEnv,
  params: { orgId: string; ticketId: string; messages: SeedTicketMessageInput[] },
): Promise<{ ids: string[] }> {
  const actingUserId = await actingUserFor(env, params.orgId)
  return seedFactory<{ ids: string[] }>(env, params.orgId, "tickets.messages", {
    ticketId: params.ticketId,
    messages: params.messages,
    ...(actingUserId ? { actingUserId } : {}),
  })
}

/** Time passing: the ticket's SLA deadline `secondsAgo` in the past (`tickets.clock`, history). */
export async function backdateSlaDeadline(
  env: WorkerEnv,
  params: { orgId: string; ticketId: string; secondsAgo: number },
): Promise<void> {
  await seedFactory(env, params.orgId, "tickets.clock", {
    ticketId: params.ticketId,
    slaDeadlineInSeconds: -params.secondsAgo,
  })
}

export interface SeedInboxParams {
  orgId: string
  connectedAccountId?: string
  name?: string
  emailAddress?: string
  defaultTeam?: string | null
  defaultSensitivity?: "internal" | "confidential" | "restricted"
  fromDisplayName?: string | null
  /** Make it the org's default inbox for new tickets, taking the flag over. */
  isDefaultForCreate?: boolean
  createdBy?: string
}

/**
 * A mailbox inbox (`tickets.inbox`) on `connectedAccountId`, or on a connected
 * account of its own address made first.
 */
export async function seedInbox(
  env: WorkerEnv,
  params: SeedInboxParams,
): Promise<{
  id: string
  emailAddress: string
  replyDomain: string
  connectedAccountId: string
}> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const emailAddress = (params.emailAddress ?? `support-${suffix}@org.test`).toLowerCase()
  const replyDomain = emailAddress.split("@")[1] ?? "org.test"
  const connectedAccountId =
    params.connectedAccountId ??
    (
      await seedConnectedAccount(env, {
        orgId: params.orgId,
        email: emailAddress,
        createdBy: params.createdBy,
        appName: "tickets",
      })
    ).id
  const actingUserId = params.isDefaultForCreate
    ? await actingUserFor(env, params.orgId)
    : undefined
  const { id } = await seedFactory<{ id: string }>(env, params.orgId, "tickets.inbox", {
    name: params.name ?? `Inbox ${suffix.slice(0, 6)}`,
    emailAddress,
    connectedAccountId,
    defaultTeam: params.defaultTeam ?? null,
    ...(params.defaultSensitivity ? { defaultSensitivity: params.defaultSensitivity } : {}),
    fromDisplayName: params.fromDisplayName ?? null,
    ...(params.isDefaultForCreate ? { isDefault: true, replaceDefault: true } : {}),
    ...(actingUserId ? { actingUserId } : {}),
  })
  return { id, emailAddress, replyDomain, connectedAccountId }
}

export interface SeedSmtpConnectedAccountParams {
  orgId: string
  email: string
  smtpHost: string
  smtpPort: number
  username?: string
  password?: string
  createdBy: string
  appName?: string
  connectionName?: string
}

/**
 * A credentials (SMTP/IMAP) connected account (`connections.mock`), sealed with
 * the server's own ENCRYPTION_KEY so the send path decrypts it.
 */
export async function seedSmtpConnectedAccount(
  env: WorkerEnv,
  params: SeedSmtpConnectedAccountParams,
): Promise<{ id: string }> {
  const identifier = params.email.toLowerCase()
  const { id } = await seedFactory<{ id: string }>(env, params.orgId, "connections.mock", {
    appName: params.appName ?? "tickets",
    connectionName: params.connectionName ?? "imap",
    ownerType: "org",
    userId: params.createdBy,
    identifier,
    displayName: identifier,
    kind: {
      type: "credentials",
      credentials: {
        email: params.email,
        smtpHost: params.smtpHost,
        smtpPort: String(params.smtpPort),
        username: params.username ?? params.email,
        password: params.password ?? "test-password",
      },
    },
  })
  return { id }
}

export interface SeedApiKeyParams {
  orgId: string
  createdBy?: string
  label?: string
  allowedOrigins?: string[]
  revoked?: boolean
}

/** A tickets API key through the settings page's admin operation (`tickets.apiKey`). */
export async function seedApiKey(
  env: WorkerEnv,
  params: SeedApiKeyParams,
): Promise<{ id: string; plaintext: string }> {
  return seedFactory<{ id: string; plaintext: string }>(env, params.orgId, "tickets.apiKey", {
    label: params.label ?? `key-${crypto.randomUUID().slice(0, 6)}`,
    ...(params.createdBy ? { createdBy: params.createdBy } : {}),
    ...(params.allowedOrigins ? { allowedOrigins: params.allowedOrigins } : {}),
    ...(params.revoked ? { revoked: true } : {}),
  })
}
