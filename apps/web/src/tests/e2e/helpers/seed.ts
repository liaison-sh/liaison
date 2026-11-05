// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Browser tests' client for the seed engine: `POST /api/_test/seed` runs one
// named factory (apps/api/test-support/seed/factories.ts) in the server under
// test, through the same product services every seed tier uses. A spec that
// needs a row mid-test asks for it here, never by a raw insert.
import { api, type WorkerEnv } from "@liaison/test-helpers"

/** Run the factory `name` on `orgId` (undefined for one that makes an org); its typed result, or a thrown error naming the factory. */
export async function seedFactory<T>(
  env: Pick<WorkerEnv, "serverUrl">,
  orgId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await api(env.serverUrl, "/api/_test/seed", {
    method: "POST",
    body: { factory: name, orgId, args },
  })
  if (res.status !== 200) {
    throw new Error(`seed ${name} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return (res.body as { data: T }).data
}

// ── roles ───────────────────────────────────────────────────────────────────

/**
 * Give a person a new role carrying `scopes` and the dimension grants (the
 * role editor's services, as the org's admin). The standard tier's QA people
 * hold kernel and mail scopes only: seeing tickets takes
 * `tickets:tickets:read` plus dimension grants.
 */
export async function grantTicketsScopes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  scopes: string[] = ["tickets:tickets:read", "tickets:tickets:write"],
  dimensions: Record<string, string[]> = { team: ["*"], sensitivity: ["restricted"] },
): Promise<void> {
  await seedFactory(env, orgId, "roles.grantScopes", { userId, scopes, dimensions })
}

// ── tickets ─────────────────────────────────────────────────────────────────

export interface SeededTicket {
  id: string
  handle: string
  subject: string
}

/** A customer's ticket (`createTicket`), with their first "hello world" message five minutes ago. */
export function seedTicket(
  env: WorkerEnv,
  orgId: string,
  opts: {
    subject: string
    status?: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
    priority?: "low" | "normal" | "high" | "urgent"
    sourceInboxId?: string | null
    contactId?: string | null
    /** False: no customer message (the spec writes its own). */
    lastInbound?: boolean
    closedReason?: "resolved" | "merged" | "spam" | "duplicate" | "no_response"
    /** Merge the new ticket into this one (`mergeTickets`). */
    mergedIntoTicketId?: string | null
    externalRef?: string | null
  },
): Promise<SeededTicket> {
  const { lastInbound, ...rest } = opts
  return seedFactory(env, orgId, "tickets.ticket", {
    ...rest,
    ...(lastInbound === false ? { withInboundMessage: false } : {}),
  })
}

/** A mailbox inbox at `emailAddress`; `isDefault` makes it the org's default for new tickets if it has none. */
export function seedInbox(
  env: WorkerEnv,
  orgId: string,
  opts: { name: string; emailAddress: string; isDefault?: boolean },
): Promise<{ id: string; name: string }> {
  return seedFactory(env, orgId, "tickets.inbox", {
    name: opts.name,
    emailAddress: opts.emailAddress,
    ...(opts.isDefault ? { isDefault: true } : {}),
  })
}

export interface SeedTicketMessage {
  kind: "inbound" | "outbound" | "note"
  textBody: string
  htmlBody?: string
  fromEmail?: string | null
  fromName?: string | null
  /** Seconds offset from now (negative = past). Older messages render higher. */
  sentAtOffsetSeconds?: number
}

/** Append messages to a ticket (oldest first): realistic 4-6 message threads for visual goldens. */
export async function seedTicketMessages(
  env: WorkerEnv,
  orgId: string,
  ticketId: string,
  messages: SeedTicketMessage[],
): Promise<void> {
  await seedFactory(env, orgId, "tickets.messages", { ticketId, messages })
}

/** An outbound reply on a ticket, as sent: the "approved + sent" state without the gated send. */
export async function seedOutboundMessage(
  env: WorkerEnv,
  orgId: string,
  ticketId: string,
  opts: { textBody: string; htmlBody?: string; fromEmail?: string; fromName?: string },
): Promise<void> {
  await seedFactory(env, orgId, "tickets.messages", {
    ticketId,
    messages: [{ kind: "outbound", sentAtOffsetSeconds: 0, ...opts }],
  })
}

/** A tickets API key created by `createdBy` (default: the org's admin). */
export function seedApiKey(
  env: WorkerEnv,
  orgId: string,
  opts: { label?: string; createdBy?: string } = {},
): Promise<{ id: string; plaintext: string }> {
  return seedFactory(env, orgId, "tickets.apiKey", {
    label: opts.label ?? "e2e key",
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
  })
}

// ── people and roles ────────────────────────────────────────────────────────

export interface RoleWithScopesSpec {
  name: string
  scopes: string[]
  dimensions?: Record<string, string[]>
}

export interface RolelessUserSpec {
  name: string
  email: string
}

/** An active person in the org who holds no role, for empty-state visuals. */
export function seedRolelessUser(
  env: WorkerEnv,
  orgId: string,
  spec: RolelessUserSpec,
): Promise<{ id: string; name: string; email: string }> {
  return seedFactory(env, orgId, "people.roleless", { name: spec.name, email: spec.email })
}

/** A role with exactly these scopes and dimension grants; its id. */
export async function seedRoleWithScopes(
  env: WorkerEnv,
  orgId: string,
  spec: RoleWithScopesSpec,
): Promise<string> {
  const { roleId } = await seedFactory<{ roleId: string }>(env, orgId, "roles.create", {
    name: spec.name,
    scopes: spec.scopes,
    dimensions: spec.dimensions ?? {},
  })
  return roleId
}

/** Give a person a role (their permission version moves with it). */
export async function assignRoleToUser(
  env: WorkerEnv,
  orgId: string,
  roleId: string,
  userId: string,
): Promise<void> {
  await seedFactory(env, orgId, "roles.assign", { roleId, userId })
}

/** Set the person's own grant of one dimension to exactly `values` (the per-person role editor). */
export async function grantUserDimension(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  dimensionKey: string,
  values: string[],
): Promise<void> {
  await seedFactory(env, orgId, "people.grantDimension", {
    userId,
    dimension: dimensionKey,
    values,
  })
}

/** Take the person's own grant of one dimension away. */
export async function revokeUserDimension(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  dimensionKey: string,
): Promise<void> {
  await seedFactory(env, orgId, "people.revokeDimension", { userId, dimension: dimensionKey })
}

// ── threads ─────────────────────────────────────────────────────────────────

/** `count` threads the actor starts that reference (app, entityType, entityId); their ids. */
export async function seedReferences(
  env: WorkerEnv,
  opts: {
    orgId: string
    actorId: string
    app: string
    entityType: string
    entityId: string
    count: number
    handlePrefix?: string
  },
): Promise<string[]> {
  const { threadIds } = await seedFactory<{ threadIds: string[] }>(
    env,
    opts.orgId,
    "threads.referencing",
    {
      userId: opts.actorId,
      app: opts.app,
      entityType: opts.entityType,
      entityId: opts.entityId,
      count: opts.count,
      ...(opts.handlePrefix ? { titlePrefix: opts.handlePrefix } : {}),
    },
  )
  return threadIds
}

// ── connections ─────────────────────────────────────────────────────────────

/** The person's Google Drive connection, with placeholder tokens the server can decrypt. */
export async function seedDriveConnection(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<{ id: string; identifier: string }> {
  const { id, identifier } = await seedFactory<{ id: string; identifier: string }>(
    env,
    orgId,
    "connections.mock",
    {
      // `drive` is the OAuth connection key in google-drive/app.manifest.json.
      appName: "google-drive",
      connectionName: "drive",
      ownerType: "user",
      userId,
      identifier: "e2e-fake-drive@example.com",
      displayName: "E2E Drive",
      kind: { type: "oauth2", providerAccountId: "e2e-fake-account-id" },
    },
  )
  return { id, identifier }
}

/** The org's GitLab connection (`{token, group}` credentials), created by `createdByUserId`. */
export async function seedGitlabConnection(
  env: WorkerEnv,
  orgId: string,
  createdByUserId: string,
  opts: { token?: string; group?: string } = {},
): Promise<{ id: string; group: string }> {
  const token = opts.token ?? "glpat-e2e-fake-gitlab-token-000"
  const group = opts.group ?? "acme"
  const { id } = await seedFactory<{ id: string }>(env, orgId, "connections.mock", {
    appName: "gitlab",
    connectionName: "gitlab",
    ownerType: "org",
    userId: createdByUserId,
    identifier: group,
    displayName: "E2E GitLab",
    kind: { type: "credentials", credentials: { token, group } },
  })
  return { id, group }
}
