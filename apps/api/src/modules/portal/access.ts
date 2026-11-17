// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Staff's side of the client portal: invite a client, open or close what their
// company sees, end a company's access, remove one person, reset a second factor,
// read the access log. A client holds no scope and cannot write these tables, so
// the writes are privileged; every one names the org, the company and the row it
// acts on, after the caller's own reads (under their RLS) said they may.
//
// Ending access is one transaction over kernel rows only: the company's clients
// deactivated with `auth_version + 1`, their sessions deleted, the open client
// actions of the company withdrawn (`access_ended`), every open share closed and
// `companies.portal_ended_at` set, then one event. Apps follow from the event.
// `portal.company_id()` answers nothing for an ended company, so every portal read
// and decide refuses on the next statement.
import { createHash } from "node:crypto"
import { type PortalSettings, portalSettingsSchema } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { orgAppBaseUrl } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { writeClientActionEvent } from "~/modules/client-actions/events"
import { resolveContact } from "~/modules/contacts/service"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { createExternalUser } from "~/modules/users/external-user"

const log = rootLogger.child({ module: "portal-access" })
const K = () => sql.raw(schemaRef("kernel"))

/** Invitations one org may send in an hour; the next is refused until the hour turns. */
export const PORTAL_INVITES_PER_HOUR = 50

export const PORTAL_SHARE_KINDS = [
  "project_progress",
  "project_reports",
  "project_hours",
  "invoices",
  "requests",
  "agreement",
  "change_request",
  "file",
  "ticket",
] as const
export type PortalShareKind = (typeof PORTAL_SHARE_KINDS)[number]
const COMPANY_WIDE: ReadonlySet<PortalShareKind> = new Set(["invoices", "requests"])

export class PortalAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

interface CompanyRow {
  id: string
  name: string
  closed_at: string | null
  portal_ended_at: string | null
}

/** The company as the caller reads it (their RLS); 404 when they cannot. */
export async function readCompany(db: RlsClient, companyId: string): Promise<CompanyRow> {
  const [c] = extractRows<CompanyRow>(
    await db.execute(
      sql`SELECT id, name, closed_at, portal_ended_at FROM ${K()}.companies WHERE id = ${companyId}`,
    ),
  )
  if (!c) throw new PortalAccessError("not_found", `No company ${companyId}.`, 404)
  return c
}

// ── Invite ────────────────────────────────────────────────────────────────

export interface InviteInput {
  orgId: string
  actorId: string
  /** The caller's own transaction: the contact and the company are read as they see them. */
  db: RlsClient
  companyId: string
  contactId?: string
  email?: string
  name?: string
  title?: string
}

export interface InviteResult {
  userId: string
  contactId: string
  email: string
  name: string
  company: string
  mailed: boolean
}

/** Takes one invitation from the org's hour; false past the budget. */
async function takeInvite(orgId: string): Promise<boolean> {
  const key = `portal:invite:hour:${orgId}`
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, 60 * 60)
  return n <= PORTAL_INVITES_PER_HOUR
}

export async function invitePortalPerson(input: InviteInput): Promise<InviteResult> {
  if (env.LIAISON_DEMO_MODE) {
    throw new PortalAccessError(
      "NO_MAIL_ON_DEMO",
      "Nobody was invited: this demo sends no mail, so a client could never sign in.",
      403,
    )
  }
  const company = await readCompany(input.db, input.companyId)
  if (company.closed_at || company.portal_ended_at) {
    throw new PortalAccessError(
      "PORTAL_ACCESS_ENDED",
      `Nobody was invited: ${company.name}'s portal access is ended or the company is closed. Next: give access again first.`,
    )
  }

  // The contact, read as the caller sees it; an address finds or makes the org's contact.
  type ContactRow = {
    id: string
    email: string | null
    name: string | null
    company_id: string | null
  }
  const readContact = async (id: string): Promise<ContactRow | undefined> =>
    extractRows<ContactRow>(
      await input.db.execute(
        sql`SELECT id, lower(email) AS email, name, company_id FROM ${K()}.contacts WHERE id = ${id}`,
      ),
    )[0]
  const given = input.contactId ? await readContact(input.contactId) : undefined
  if (input.contactId && !given) {
    throw new PortalAccessError("not_found", `No contact ${input.contactId}.`, 404)
  }
  const email = (given?.email ?? input.email ?? "").trim().toLowerCase()
  const name = (input.name ?? given?.name ?? email).trim()
  if (!email) {
    throw new PortalAccessError(
      "EMAIL_REQUIRED",
      "Nobody was invited: this contact has no email address. Next: add their address first.",
      422,
    )
  }
  // Who already holds the address in this org: a member, or a client of a company.
  const [holder] = await withPrivilegedDb(input.orgId, "portal-invite-holder", async (tx) =>
    extractRows<{ user_type: string; company_id: string | null }>(
      await tx.execute(
        sql`SELECT user_type, company_id FROM ${K()}.users
             WHERE org_id = ${input.orgId} AND lower(email) = ${email} LIMIT 1`,
      ),
    ),
  )
  if (holder?.user_type === "member") {
    throw new PortalAccessError(
      "PORTAL_EMAIL_IS_STAFF",
      `Nobody was invited: ${email} belongs to a member of this organisation, who never signs in to the portal.`,
    )
  }
  if (holder && holder.company_id !== input.companyId) {
    throw new PortalAccessError(
      "PORTAL_EMAIL_IN_USE",
      `Nobody was invited: ${email} already has portal access for another company. One address reaches one company's portal; links sent for a document still reach them.`,
    )
  }
  if (holder) {
    throw new PortalAccessError(
      "EMAIL_IS_PORTAL_USER",
      `Nobody was invited: ${email} already has access to ${company.name}'s portal.`,
    )
  }
  if (!(await takeInvite(input.orgId))) {
    throw new PortalAccessError(
      "PORTAL_INVITE_LIMIT",
      `Nobody was invited: this organisation sent ${PORTAL_INVITES_PER_HOUR} invitations in the last hour. Next: try again within the hour.`,
      429,
    )
  }
  const contact =
    given ??
    (await resolveContact(
      input.db,
      input.orgId,
      input.actorId,
      { email, name },
      { audience: "org" },
    ).then((r) => (r.contact ? readContact(r.contact.id) : undefined)))
  if (!contact) throw new PortalAccessError("not_found", `No contact for ${email}.`, 404)
  if (contact.company_id && contact.company_id !== input.companyId) {
    throw new PortalAccessError(
      "CONTACT_NOT_THIS_COMPANY",
      `Nobody was invited: contact ${contact.id} is a contact of another company, not ${company.name}.`,
    )
  }
  if (!contact.company_id) {
    await input.db.execute(
      sql`UPDATE ${K()}.contacts SET company_id = ${input.companyId} WHERE id = ${contact.id}`,
    )
  }
  const contactId = contact.id

  const out = await withPrivilegedDb(input.orgId, "portal-invite", async (tx) => {
    const made = await createExternalUser(tx, {
      orgId: input.orgId,
      companyId: input.companyId,
      email,
      name,
      invitedBy: input.actorId,
    })
    if (!made.ok) {
      throw new PortalAccessError(
        made.code === "email_is_member" ? "PORTAL_EMAIL_IS_STAFF" : "PORTAL_EMAIL_IN_USE",
        `Nobody was invited: ${email} already has an account here.`,
      )
    }
    await tx.execute(sql`
      INSERT INTO ${K()}.portal_people (user_id, org_id, company_id, contact_id, title, invited_by_user_id)
      VALUES (${made.userId}, ${input.orgId}, ${input.companyId}, ${contactId}, ${input.title ?? null}, ${input.actorId})`)
    await tx.queueEvent({
      app: "kernel",
      entity: "portal_user",
      action: "invited",
      orgId: input.orgId,
      actorId: input.actorId,
      actorType: "user",
      entityId: made.userId,
      data: { companyId: input.companyId, contactId },
    })
    return { userId: made.userId, contactId }
  })

  const mailed = await sendInviteMail(input.orgId, email, company.name).then(
    () => true,
    (err) => {
      log.error({ err, orgId: input.orgId, userId: out.userId }, "portal invitation mail failed")
      return false
    },
  )
  return { ...out, email, name, company: company.name, mailed }
}

/** One system mail pointing at the portal's sign-in page; it holds no secret. */
async function sendInviteMail(orgId: string, email: string, companyName: string): Promise<void> {
  const [org] = extractRows<{ name: string; slug: string }>(
    await withPrivilegedDb(orgId, "portal-invite-org", (tx) =>
      tx.execute(sql`SELECT name, slug FROM ${K()}.organizations WHERE id = ${orgId}`),
    ),
  )
  if (!org) return
  const base = await orgAppBaseUrl(orgId)
  const link = `${base}/portal/sign-in?org=${encodeURIComponent(org.slug)}`
  const subject = `${org.name} invites you to your client portal`
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: org.name,
    heading: `Your portal for ${companyName}`,
    paragraphs: [
      `${org.name} opened a client portal for ${companyName}. Sign in with this address: a link comes by mail each time, no password.`,
    ],
    cta: { label: "Open the portal", href: link },
    footer: ["If you did not expect this, you can ignore it."],
  })
  const cfg = await getOrgEmailConfig(orgId)
  await sendSystemEmailObserved({
    to: email,
    from: cfg.from,
    replyTo: cfg.replyTo,
    subject,
    html,
    text,
    template: "portal.invite",
  })
}

// ── Shares ────────────────────────────────────────────────────────────────

export interface ShareInput {
  orgId: string
  actorId: string
  db: RlsClient
  companyId: string
  kind: PortalShareKind
  objectId?: string | null
  open: boolean
  onlyUserIds?: string[] | null
}

export interface ShareResult {
  id: string | null
  kind: PortalShareKind
  objectId: string | null
  open: boolean
  changed: boolean
  company: string
}

/**
 * Parent checks of a file a person shares, as the caller reads it: the same parents
 * `portal.file_allowed` accepts, belonging to this company and not restricted. A key
 * that names no check, or a table the org does not have, refuses.
 */
const FILE_PARENT_CHECKS: Record<
  string,
  { table: string; check: (entityId: string, companyId: string) => ReturnType<typeof sql> }
> = {
  "kernel:company": {
    table: "kernel.companies",
    check: (e, c) => sql`SELECT ${e} = ${c}::text AS ok`,
  },
  "tickets:ticket": {
    table: "app_tickets.tickets",
    check: (e, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_tickets"))}.tickets t
           WHERE t.id::text = ${e} AND t.company_id = ${c} AND t.sensitivity <> 'restricted') AS ok`,
  },
  "tickets:message": {
    table: "app_tickets.messages",
    check: (e, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_tickets"))}.messages m
           JOIN ${sql.raw(schemaRef("app_tickets"))}.tickets t ON t.id = m.ticket_id AND t.org_id = m.org_id
           WHERE m.id::text = ${e} AND t.company_id = ${c} AND t.sensitivity <> 'restricted') AS ok`,
  },
  "projects:project": {
    table: "app_projects.projects",
    check: (e, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_projects"))}.projects p
           WHERE p.id::text = ${e} AND p.company_id = ${c}) AS ok`,
  },
  "projects:task": {
    table: "app_projects.tasks",
    check: (e, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_projects"))}.tasks t
           JOIN ${sql.raw(schemaRef("app_projects"))}.projects p ON p.id = t.project_id AND p.org_id = t.org_id
           WHERE t.id::text = ${e} AND p.company_id = ${c}) AS ok`,
  },
}

/** Object checks for the kinds that name one, as the caller reads it. */
const OBJECT_CHECKS: Partial<
  Record<
    PortalShareKind,
    { table: string; check: (id: string, c: string) => ReturnType<typeof sql> }
  >
> = {
  ticket: {
    table: "app_tickets.tickets",
    check: (id, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_tickets"))}.tickets t
           WHERE t.id = ${id} AND t.company_id = ${c} AND t.sensitivity = 'internal') AS ok`,
  },
  project_progress: {
    table: "app_projects.projects",
    check: (id, c) =>
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.raw(schemaRef("app_projects"))}.projects p
           WHERE p.id = ${id} AND p.company_id = ${c}) AS ok`,
  },
}
OBJECT_CHECKS.project_reports = OBJECT_CHECKS.project_progress
OBJECT_CHECKS.project_hours = OBJECT_CHECKS.project_progress

async function tableExists(db: RlsClient, qualified: string): Promise<boolean> {
  const [schema, table] = qualified.split(".")
  const ref = `${schemaRef(schema ?? "")}.${table}`
  const [r] = extractRows<{ ok: boolean }>(
    await db.execute(sql`SELECT to_regclass(${ref}) IS NOT NULL AS ok`),
  )
  return r?.ok === true
}

async function runCheck(
  db: RlsClient,
  entry: { table: string; check: (a: string, b: string) => ReturnType<typeof sql> } | undefined,
  a: string,
  b: string,
): Promise<boolean> {
  if (!entry || !(await tableExists(db, entry.table))) return false
  const [r] = extractRows<{ ok: boolean }>(await db.execute(entry.check(a, b)))
  return r?.ok === true
}

function notThisCompany(company: string): PortalAccessError {
  return new PortalAccessError(
    "SHARE_NOT_THIS_COMPANY",
    `Nothing was shared: that item is not ${company}'s, is restricted, or is not one you can read.`,
  )
}

/** Refuses a share whose object is not this company's, as the caller reads it (S799l). */
async function assertShareable(input: ShareInput, company: CompanyRow): Promise<void> {
  const id = input.objectId
  if (!id) return
  if (input.kind === "file") {
    const [f] = extractRows<{ app: string; entity_type: string; entity_id: string | null }>(
      await input.db.execute(
        sql`SELECT app, entity_type, entity_id FROM ${K()}.files WHERE id = ${id}`,
      ),
    )
    if (!f?.entity_id) throw notThisCompany(company.name)
    const ok = await runCheck(
      input.db,
      FILE_PARENT_CHECKS[`${f.app}:${f.entity_type}`],
      f.entity_id,
      input.companyId,
    )
    if (!ok) throw notThisCompany(company.name)
    return
  }
  const entry = OBJECT_CHECKS[input.kind]
  if (entry) {
    if (!(await runCheck(input.db, entry, id, input.companyId))) throw notThisCompany(company.name)
  }
}

export async function setPortalShare(input: ShareInput): Promise<ShareResult> {
  const company = await readCompany(input.db, input.companyId)
  const wide = COMPANY_WIDE.has(input.kind)
  if (wide !== !input.objectId) {
    throw new PortalAccessError(
      "SHARE_OBJECT_REQUIRED",
      wide
        ? `Nothing changed: "${input.kind}" is shared for the whole company and names no object.`
        : `Nothing changed: "${input.kind}" needs the id of the one item it opens.`,
      422,
    )
  }
  const objectId = input.objectId ?? null
  if (!input.open) {
    const closed = await withPrivilegedDb(input.orgId, "portal-share-close", async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(sql`
          UPDATE ${K()}.portal_shares SET closed_at = now(), closed_by_user_id = ${input.actorId}
           WHERE org_id = ${input.orgId} AND company_id = ${input.companyId} AND kind = ${input.kind}
             AND object_id IS NOT DISTINCT FROM ${objectId}::uuid AND closed_at IS NULL
          RETURNING id`),
      ),
    )
    return {
      id: closed[0]?.id ?? null,
      kind: input.kind,
      objectId,
      open: false,
      changed: closed.length > 0,
      company: company.name,
    }
  }
  if (company.closed_at || company.portal_ended_at) {
    throw new PortalAccessError(
      "PORTAL_ACCESS_ENDED",
      `Nothing was shared: ${company.name}'s portal access is ended or the company is closed.`,
    )
  }
  await assertShareable(input, company)
  const only = input.onlyUserIds && input.onlyUserIds.length > 0 ? input.onlyUserIds : null
  return withPrivilegedDb(input.orgId, "portal-share-open", async (tx) => {
    if (only) {
      // Named people must be this company's open portal people.
      const ok = extractRows<{ n: number }>(
        await tx.execute(sql`
          SELECT count(*)::int AS n FROM ${K()}.portal_people
           WHERE org_id = ${input.orgId} AND company_id = ${input.companyId} AND removed_at IS NULL
             AND user_id = ANY(${`{${only.join(",")}}`}::uuid[])`),
      )[0]
      if ((ok?.n ?? 0) !== new Set(only).size) {
        throw new PortalAccessError(
          "SHARE_NOT_THIS_COMPANY",
          `Nothing was shared: a named person is not on ${company.name}'s portal.`,
        )
      }
    }
    const [row] = extractRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO ${K()}.portal_shares (org_id, company_id, kind, object_id, shared_by_user_id, only_user_ids)
        VALUES (${input.orgId}, ${input.companyId}, ${input.kind}, ${objectId}::uuid, ${input.actorId},
                ${only ? `{${only.join(",")}}` : null}::uuid[])
        ON CONFLICT DO NOTHING
        RETURNING id`),
    )
    if (row)
      return {
        id: row.id,
        kind: input.kind,
        objectId,
        open: true,
        changed: true,
        company: company.name,
      }
    const [open] = extractRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id FROM ${K()}.portal_shares
         WHERE org_id = ${input.orgId} AND company_id = ${input.companyId} AND kind = ${input.kind}
           AND object_id IS NOT DISTINCT FROM ${objectId}::uuid AND closed_at IS NULL`),
    )
    return {
      id: open?.id ?? null,
      kind: input.kind,
      objectId,
      open: true,
      changed: false,
      company: company.name,
    }
  })
}

// ── End access, give it again ───────────────────────────────────────────

export interface EndAccessResult {
  company: string
  signedOut: number
  cancelledLinks: number
  closedShares: number
  alreadyEnded: boolean
}

/** Ends a company's portal access in one transaction (kernel rows only). */
export async function endPortalAccess(input: {
  orgId: string
  actorId: string
  db: RlsClient
  companyId: string
  reason?: string | null
}): Promise<EndAccessResult> {
  const company = await readCompany(input.db, input.companyId)
  const ended = await withPrivilegedDb(input.orgId, "portal-end-access", async (tx) => {
    const [lock] = extractRows<{ portal_ended_at: string | null }>(
      await tx.execute(sql`
        SELECT portal_ended_at FROM ${K()}.companies
         WHERE id = ${input.companyId} AND org_id = ${input.orgId} FOR UPDATE`),
    )
    if (!lock) throw new PortalAccessError("not_found", `No company ${input.companyId}.`, 404)
    const people = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.users SET status = 'deactivated', auth_version = auth_version + 1
         WHERE org_id = ${input.orgId} AND company_id = ${input.companyId}
           AND user_type = 'external' AND status <> 'deactivated'
        RETURNING id`),
    )
    const sessions = extractRows<{ id: string }>(
      await tx.execute(sql`
        DELETE FROM ${K()}.sessions s USING ${K()}.users u
         WHERE s.user_id = u.id AND u.org_id = ${input.orgId}
           AND u.company_id = ${input.companyId} AND u.user_type = 'external'
        RETURNING s.id`),
    )
    const actions = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET revoked_at = now(), revoked_by = ${input.actorId}, revoke_reason = 'access_ended'
         WHERE org_id = ${input.orgId} AND company_id = ${input.companyId}
           AND decided_at IS NULL AND revoked_at IS NULL
        RETURNING id`),
    )
    for (const a of actions) {
      await writeClientActionEvent(tx, {
        orgId: input.orgId,
        actionId: a.id,
        event: "revoked",
        actorKind: "staff",
        actorUserId: input.actorId,
        meta: { reason: "access_ended" },
      })
    }
    const shares = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.portal_shares SET closed_at = now(), closed_by_user_id = ${input.actorId}
         WHERE org_id = ${input.orgId} AND company_id = ${input.companyId} AND closed_at IS NULL
        RETURNING id`),
    )
    await tx.execute(sql`
      UPDATE ${K()}.companies
         SET portal_ended_at = COALESCE(portal_ended_at, now()), portal_ended_by = COALESCE(portal_ended_by, ${input.actorId}::uuid)
       WHERE id = ${input.companyId} AND org_id = ${input.orgId}`)
    await tx.queueEvent({
      app: "kernel",
      entity: "portal_user",
      action: "access_ended",
      orgId: input.orgId,
      actorId: input.actorId,
      actorType: "user",
      entityId: input.companyId,
      data: {
        companyId: input.companyId,
        userIds: people.map((p) => p.id),
        reason: input.reason ?? null,
      },
    })
    return {
      userIds: people.map((p) => p.id),
      sessionIds: sessions.map((s) => s.id),
      cancelledLinks: actions.length,
      closedShares: shares.length,
      alreadyEnded: lock.portal_ended_at !== null,
    }
  })
  // Every process caches auth state for 15 s: tell them now, and end the access tokens.
  for (const id of ended.userIds) invalidateAuthCache(id)
  revokeSessions(ended.sessionIds, "portal-access-ended")
  return {
    company: company.name,
    signedOut: ended.userIds.length,
    cancelledLinks: ended.cancelledLinks,
    closedShares: ended.closedShares,
    alreadyEnded: ended.alreadyEnded,
  }
}

/**
 * Gives a company its portal again: its people not removed may sign in anew. No share is
 * reopened, no link or session comes back: a person opens what the company should see.
 */
export async function restorePortalAccess(input: {
  orgId: string
  actorId: string
  db: RlsClient
  companyId: string
}): Promise<{ company: string; people: number }> {
  const company = await readCompany(input.db, input.companyId)
  const people = await withPrivilegedDb(input.orgId, "portal-restore-access", async (tx) => {
    await tx.execute(sql`
      UPDATE ${K()}.companies SET portal_ended_at = NULL, portal_ended_by = NULL
       WHERE id = ${input.companyId} AND org_id = ${input.orgId}`)
    return extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.users u SET status = 'active', auth_version = u.auth_version + 1
          FROM ${K()}.portal_people p
         WHERE p.user_id = u.id AND p.org_id = ${input.orgId} AND p.company_id = ${input.companyId}
           AND p.removed_at IS NULL AND u.user_type = 'external' AND u.status = 'deactivated'
        RETURNING u.id`),
    )
  })
  for (const p of people) invalidateAuthCache(p.id)
  return { company: company.name, people: people.length }
}

// ── One person ────────────────────────────────────────────────────────────

export interface PortalPersonRow {
  user_id: string
  company_id: string
  contact_id: string
  name: string
  email: string
  last_sign_in_at: string | null
}

/** A portal person of the org the caller may administer (their RLS on portal_people). */
export async function readPortalPerson(db: RlsClient, userId: string): Promise<PortalPersonRow> {
  const [p] = extractRows<PortalPersonRow>(
    await db.execute(sql`
      SELECT p.user_id, p.company_id, p.contact_id, u.name, u.email, p.last_sign_in_at
        FROM ${K()}.portal_people p JOIN ${K()}.users u ON u.id = p.user_id
       WHERE p.user_id = ${userId} AND p.removed_at IS NULL`),
  )
  if (!p) throw new PortalAccessError("not_found", `No portal person ${userId}.`, 404)
  return p
}

/**
 * Removes one person from their company's portal: signed out, deactivated, their open links
 * withdrawn. Nothing they read or signed is deleted. Erasure is a separate step (eraseUser).
 */
export async function removePortalPerson(input: {
  orgId: string
  actorId: string
  db: RlsClient
  userId: string
}): Promise<{ person: PortalPersonRow; signedOut: number; cancelledLinks: number }> {
  const person = await readPortalPerson(input.db, input.userId)
  const out = await withPrivilegedDb(input.orgId, "portal-remove-person", (tx) =>
    removePersonRows(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      userId: input.userId,
      email: person.email,
      companyId: person.company_id,
    }),
  )
  afterRemoval([input.userId], out.sessionIds)
  return { person, signedOut: out.sessionIds.length, cancelledLinks: out.cancelledLinks }
}

/** Ends access on every process: the auth cache now, the access tokens of the ended sessions. */
function afterRemoval(userIds: string[], sessionIds: string[]): void {
  for (const id of userIds) invalidateAuthCache(id)
  revokeSessions(sessionIds, "portal-person-removed")
}

/** One person's portal rows ended in the caller's privileged transaction. */
async function removePersonRows(
  tx: PrivilegedDb,
  p: { orgId: string; actorId: string | null; userId: string; email: string; companyId: string },
): Promise<{ sessionIds: string[]; cancelledLinks: number }> {
  await tx.execute(sql`
    UPDATE ${K()}.portal_people SET removed_at = now()
     WHERE user_id = ${p.userId} AND org_id = ${p.orgId} AND removed_at IS NULL`)
  await tx.execute(sql`
    UPDATE ${K()}.users SET status = 'deactivated', auth_version = auth_version + 1
     WHERE id = ${p.userId} AND org_id = ${p.orgId} AND user_type = 'external'`)
  const sessions = extractRows<{ id: string }>(
    await tx.execute(sql`DELETE FROM ${K()}.sessions WHERE user_id = ${p.userId} RETURNING id`),
  )
  // Their open links for this company's documents; a link for another company still reaches them.
  const actions = extractRows<{ id: string }>(
    await tx.execute(sql`
      UPDATE ${K()}.client_actions
         SET revoked_at = now(), revoked_by = ${p.actorId}, revoke_reason = 'access_ended'
       WHERE org_id = ${p.orgId} AND decided_at IS NULL AND revoked_at IS NULL
         AND (signer_user_id = ${p.userId}
              OR (invited_email = ${p.email.toLowerCase()} AND company_id = ${p.companyId}))
      RETURNING id`),
  )
  for (const a of actions) {
    await writeClientActionEvent(tx, {
      orgId: p.orgId,
      actionId: a.id,
      event: "revoked",
      actorKind: p.actorId ? "staff" : "system",
      actorUserId: p.actorId,
      meta: { reason: "access_ended" },
    })
  }
  return { sessionIds: sessions.map((s) => s.id), cancelledLinks: actions.length }
}

/**
 * A contact deleted, or moved to another company: the portal person made from it loses
 * access in the same transaction, and carries nothing to the new company. Called by the
 * contacts service on its privileged handle. Returns how many people it removed.
 */
export async function endPortalForContact(
  tx: PrivilegedDb,
  input: {
    orgId: string
    contactId: string
    actorId: string | null
    /** The contact's company now; undefined when the contact is deleted. */
    companyId?: string | null
  },
): Promise<number> {
  const people = extractRows<{ user_id: string; email: string; company_id: string }>(
    await tx.execute(sql`
      SELECT p.user_id, u.email, p.company_id FROM ${K()}.portal_people p
        JOIN ${K()}.users u ON u.id = p.user_id
       WHERE p.org_id = ${input.orgId} AND p.contact_id = ${input.contactId} AND p.removed_at IS NULL
         AND (${input.companyId === undefined}::boolean
              OR p.company_id IS DISTINCT FROM ${input.companyId ?? null}::uuid)`),
  )
  const sessionIds: string[] = []
  for (const person of people) {
    const out = await removePersonRows(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      userId: person.user_id,
      email: person.email,
      companyId: person.company_id,
    })
    sessionIds.push(...out.sessionIds)
  }
  if (people.length > 0)
    afterRemoval(
      people.map((p) => p.user_id),
      sessionIds,
    )
  return people.length
}

/** Clears a portal person's second factor; they set one up again at their next sign-in. */
export async function resetPortalTotp(input: {
  orgId: string
  actorId: string
  db: RlsClient
  userId: string
}): Promise<PortalPersonRow> {
  const person = await readPortalPerson(input.db, input.userId)
  await withPrivilegedDb(input.orgId, "portal-totp-reset", (tx) =>
    tx.execute(sql`
      UPDATE ${K()}.users SET totp_secret = NULL, totp_enabled = false, totp_last_used_at = NULL,
             auth_version = auth_version + 1
       WHERE id = ${input.userId} AND org_id = ${input.orgId} AND user_type = 'external'`),
  )
  invalidateAuthCache(input.userId)
  void sendSystemEmailObserved({
    to: person.email,
    ...(await getOrgEmailConfig(input.orgId)),
    subject: "Your portal's second step was reset",
    ...renderBrandedEmail({
      subject: "Your portal's second step was reset",
      heading: "Your second step was reset",
      paragraphs: [
        "A member of the team reset your authenticator for the client portal. At your next sign-in you set one up again. If you did not ask for this, reply to this mail.",
      ],
    }),
    template: "portal.totp-reset",
  }).catch((err) =>
    log.error({ err, userId: input.userId }, "portal second-factor reset mail failed"),
  )
  return person
}

export async function setPortalRequireTotp(input: {
  orgId: string
  db: RlsClient
  companyId: string
  required: boolean
}): Promise<{ company: string; required: boolean }> {
  const company = await readCompany(input.db, input.companyId)
  await withPrivilegedDb(input.orgId, "portal-require-totp", (tx) =>
    tx.execute(sql`
      UPDATE ${K()}.companies SET portal_require_totp = ${input.required}
       WHERE id = ${input.companyId} AND org_id = ${input.orgId}`),
  )
  return { company: company.name, required: input.required }
}

// ── Access log ────────────────────────────────────────────────────────────

export interface AccessLogRow {
  id: string
  at: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  device: unknown
}

/**
 * The company's portal access log as the caller reads it: the audit rows of app `portal`
 * stamped with the company (`metadata.companyId`) when they were written. The audit table's own policy answers none of them without
 * `kernel:portal:logs`.
 */
export async function readPortalAccessLog(input: {
  db: RlsClient
  companyId: string
  before?: string | null
  limit?: number
}): Promise<AccessLogRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  return extractRows<AccessLogRow>(
    await input.db.execute(sql`
      SELECT a.id, a."timestamp" AS at, a.actor_id AS user_id, a.action, a.entity_type, a.entity_id,
             a.metadata -> 'device' AS device
        FROM ${K()}.audit_log a
       WHERE a.app = 'portal' AND a.metadata ->> 'companyId' = ${input.companyId}
         AND (${input.before ?? null}::timestamptz IS NULL OR a."timestamp" < ${input.before ?? null}::timestamptz)
       ORDER BY a."timestamp" DESC
       LIMIT ${limit}`),
  )
}

/** A short stable digest for log lines, never the address itself. */
export function emailDigest(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12)
}

/**
 * What an erasure keeps of a portal person: every request they signed, accepted or
 * approved (the legal record of an agreement or a quote). Invoices are their company's.
 */
export async function keptForPerson(
  orgId: string,
  userId: string,
): Promise<Array<{ id: string; decision: string; target_type: string; target_id: string }>> {
  return withPrivilegedDb(orgId, "portal-erase-kept", async (tx) =>
    extractRows<{ id: string; decision: string; target_type: string; target_id: string }>(
      await tx.execute(sql`
        SELECT a.id, a.decision, a.target_type, a.target_id FROM ${K()}.client_actions a
          JOIN ${K()}.users u ON u.id = ${userId} AND u.org_id = a.org_id
         WHERE a.org_id = ${orgId} AND a.decision IN ('signed', 'accepted', 'approved')
           AND (a.decided_user_id = u.id OR a.invited_email = lower(u.email))
         ORDER BY a.decided_at`),
    ),
  )
}

// ── Org settings: the notice and the log's length ─────────────────────────

/** The portal's org settings as stored, or the empty object. */
export async function readPortalSettings(orgId: string): Promise<PortalSettings> {
  const [row] = extractRows<{ portal: unknown }>(
    await withPrivilegedDb(orgId, "portal-settings-read", (tx) =>
      tx.execute(
        sql`SELECT settings -> 'portal' AS portal FROM ${K()}.organizations WHERE id = ${orgId}`,
      ),
    ),
  )
  const parsed = portalSettingsSchema.safeParse(row?.portal ?? {})
  return parsed.success ? parsed.data : {}
}

/**
 * Changes the portal's org settings. A new notice text raises its version, so every
 * portal person reads it again at their next sign-in. A log length other than 12
 * months needs a reason, kept beside it.
 */
export async function setPortalSettings(
  orgId: string,
  patch: { notice?: string | null; logRetentionMonths?: number; logRetentionReason?: string },
): Promise<PortalSettings> {
  const current = await readPortalSettings(orgId)
  const noticeChanged =
    patch.notice !== undefined && (patch.notice || null) !== (current.notice ?? null)
  const next = {
    ...current,
    ...(patch.logRetentionMonths !== undefined
      ? {
          logRetentionMonths: patch.logRetentionMonths,
          logRetentionReason: patch.logRetentionReason,
        }
      : {}),
    ...(patch.notice !== undefined ? { notice: patch.notice || null } : {}),
    ...(noticeChanged ? { noticeVersion: (current.noticeVersion ?? 0) + 1 } : {}),
  }
  const parsed = portalSettingsSchema.safeParse(next)
  if (!parsed.success) {
    throw new PortalAccessError(
      "PORTAL_SETTINGS_INVALID",
      `Nothing changed: ${parsed.error.issues[0]?.message ?? "the settings are not valid"}.`,
      422,
    )
  }
  await withPrivilegedDb(orgId, "portal-settings-write", (tx) =>
    tx.execute(sql`
      UPDATE ${K()}.organizations
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{portal}', ${JSON.stringify(parsed.data)}::jsonb)
       WHERE id = ${orgId}`),
  )
  return parsed.data
}
