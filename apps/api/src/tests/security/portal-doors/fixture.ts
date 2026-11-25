// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world every portal door test runs in: two orgs; in the first, companies A
// and B and a closed company C, a member, an admin holding `*`, and portal
// people of each company; in the second, a company and its portal person. Rows
// are written on the privileged connection, then every read runs through the
// real roles: liaison_rls for members, liaison_portal for clients. The sign-in
// tests add a deactivated client, a client with a second factor and a client of
// the second org whose address is the member's (createSignInWorld).

import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { generateTotpSecret } from "~/modules/auth/totp"
import { PORTAL_REFRESH_COOKIE } from "~/modules/portal/auth-routes"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { turnOnOrgFeatures } from "~/tests/helpers/org-features"
import { clearRedisPatterns } from "~/tests/route-test-setup"

export interface DoorPerson {
  userId: string
  contactId: string
  email: string
  name: string
}

export interface DoorWorld {
  orgId: string
  orgSlug: string
  orgName: string
  otherOrgId: string
  otherOrgSlug: string
  companyA: string
  companyB: string
  /** Closed: its people read nothing. */
  companyC: string
  /** The second org's company. */
  otherCompany: string
  member: DoorPerson
  admin: DoorPerson
  clientA: DoorPerson
  clientA2: DoorPerson
  clientB: DoorPerson
  clientC: DoorPerson
  otherClient: DoorPerson
  /** Every user id the world created, for a search over responses. */
  staffIds: string[]
}

function person(label: string, tag: string): DoorPerson {
  return {
    userId: crypto.randomUUID(),
    contactId: crypto.randomUUID(),
    email: `${label}-${tag}@doors.example.com`,
    name: `${label[0]?.toUpperCase()}${label.slice(1)} ${tag}`,
  }
}

// insertSql takes its columns from the first row: every row below names the same ones.

/** Creates the world; `dropDoorWorld` removes every row of it. */
export async function createDoorWorld(): Promise<DoorWorld> {
  const tag = crypto.randomUUID().slice(0, 8)
  const w: DoorWorld = {
    orgId: crypto.randomUUID(),
    orgSlug: `doors-${tag}`,
    orgName: "Maison Portes",
    otherOrgId: crypto.randomUUID(),
    otherOrgSlug: `doors-other-${tag}`,
    companyA: crypto.randomUUID(),
    companyB: crypto.randomUUID(),
    companyC: crypto.randomUUID(),
    otherCompany: crypto.randomUUID(),
    member: person("member", tag),
    admin: person("admin", tag),
    clientA: person("clienta", tag),
    clientA2: person("clientatwo", tag),
    clientB: person("clientb", tag),
    clientC: person("clientc", tag),
    otherClient: person("other", tag),
    staffIds: [],
  }
  w.staffIds = [w.member.userId, w.admin.userId]

  await sql.unsafe(
    insertSql("kernel.organizations", [
      { id: w.orgId, name: w.orgName, slug: w.orgSlug },
      { id: w.otherOrgId, name: "Maison Autre", slug: w.otherOrgSlug },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.companies", [
      {
        id: w.companyA,
        org_id: w.orgId,
        handle: `a-${tag}`,
        name: "Maison Alpha",
        closed_at: null,
      },
      { id: w.companyB, org_id: w.orgId, handle: `b-${tag}`, name: "Maison Beta", closed_at: null },
      {
        id: w.companyC,
        org_id: w.orgId,
        handle: `c-${tag}`,
        name: "Maison Close",
        closed_at: { raw: "now()" },
      },
      {
        id: w.otherCompany,
        org_id: w.otherOrgId,
        handle: `o-${tag}`,
        name: "Maison Ailleurs",
        closed_at: null,
      },
    ]),
  )
  for (const m of [w.member, w.admin]) {
    await sql.unsafe(
      insertSql("kernel.users", { id: m.userId, org_id: w.orgId, email: m.email, name: m.name }),
    )
  }
  // The admin holds every scope through a role, as a real owner does.
  const everything = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.roles", { id: everything, org_id: w.orgId, name: `everything-${tag}` }),
  )
  await sql.unsafe(insertSql("kernel.role_scope_grants", { role_id: everything, scope: "*" }))
  await sql.unsafe(
    insertSql("kernel.user_roles", {
      user_id: w.admin.userId,
      role_id: everything,
      org_id: w.orgId,
    }),
  )
  const clients: Array<[DoorPerson, string, string]> = [
    [w.clientA, w.orgId, w.companyA],
    [w.clientA2, w.orgId, w.companyA],
    [w.clientB, w.orgId, w.companyB],
    [w.clientC, w.orgId, w.companyC],
    [w.otherClient, w.otherOrgId, w.otherCompany],
  ]
  for (const [c, orgId, companyId] of clients) await insertClient(c, orgId, companyId)
  return w
}

/** A portal person: their contact, their external user row and their portal row. */
async function insertClient(c: DoorPerson, orgId: string, companyId: string): Promise<void> {
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id: c.contactId,
      org_id: orgId,
      handle: `contact-${c.contactId.slice(0, 8)}`,
      name: c.name,
      email: c.email,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", {
      id: c.userId,
      org_id: orgId,
      email: c.email,
      name: c.name,
      user_type: "external",
      company_id: companyId,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.portal_people", {
      user_id: c.userId,
      org_id: orgId,
      company_id: companyId,
      contact_id: c.contactId,
      title: "Client",
    }),
  )
}

export interface SignInWorld extends DoorWorld {
  /** A deactivated client of company A. */
  clientGone: DoorPerson
  /** A client of company A with a second factor set up, and its secret. */
  clientTotp: DoorPerson & { secret: string }
  /** A client of the second org whose address is `member.email`. */
  twoOrgClient: DoorPerson
}

/** The door world plus the people the sign-in doors need; `dropDoorWorld` removes it. */
export async function createSignInWorld(): Promise<SignInWorld> {
  const w = await createDoorWorld()
  const tag = w.orgSlug.slice("doors-".length)
  const clientGone = person("clientgone", tag)
  const clientTotp = { ...person("clienttotp", tag), secret: generateTotpSecret() }
  const twoOrgClient = { ...person("twoorg", tag), email: w.member.email }
  await insertClient(clientGone, w.orgId, w.companyA)
  await insertClient(clientTotp, w.orgId, w.companyA)
  await insertClient(twoOrgClient, w.otherOrgId, w.otherCompany)
  const k = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
  await sql`UPDATE ${k("users")} SET status = 'deactivated' WHERE id = ${clientGone.userId}`
  await sql`UPDATE ${k("users")} SET totp_enabled = true,
    totp_secret = ${encryptSecret(clientTotp.secret, encryptionKey, CryptoContext.totpSecret)}
    WHERE id = ${clientTotp.userId}`
  // Companies (and the portal on a company page) are off until an admin turns them on.
  await turnOnOrgFeatures(w.orgId)
  return { ...w, clientGone, clientTotp, twoOrgClient }
}

/**
 * Removes every row of the world. The client action trail is append only for a
 * year, so its rows go the way an org purge takes them: the org marked deleting,
 * then liaison_admin with the purge setting naming the org.
 */
export async function dropDoorWorld(w: DoorWorld): Promise<void> {
  const k = (table: string) => `"${schemaRef("kernel")}".${table}`
  const byOrg = [
    "sessions",
    "password_resets",
    "client_actions",
    "portal_shares",
    "portal_people",
    "audit_log",
    "user_dimension_grants",
    "user_scope_grants",
    "user_roles",
  ]
  for (const orgId of [w.orgId, w.otherOrgId]) {
    await sql.unsafe(`UPDATE ${k("organizations")} SET deleting_at = now() WHERE id = $1`, [orgId])
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      await tx.unsafe("SELECT set_config('liaison.demo_purge_org', $1, true)", [orgId])
      await tx.unsafe(`DELETE FROM ${k("client_action_devices")} WHERE org_id = $1`, [orgId])
      await tx.unsafe(`DELETE FROM ${k("client_action_events")} WHERE org_id = $1`, [orgId])
    })
    for (const table of byOrg) {
      await sql.unsafe(`DELETE FROM ${k(table)} WHERE org_id = $1`, [orgId])
    }
    await sql.unsafe(
      `DELETE FROM ${k("role_scope_grants")} WHERE role_id IN (SELECT id FROM ${k("roles")} WHERE org_id = $1)`,
      [orgId],
    )
    for (const table of ["roles", "users", "contacts", "companies"]) {
      await sql.unsafe(`DELETE FROM ${k(table)} WHERE org_id = $1`, [orgId])
    }
    await sql.unsafe(`DELETE FROM ${k("organizations")} WHERE id = $1`, [orgId])
  }
}

/** A member of the first org with exactly these scopes. */
export function memberContext(w: DoorWorld, scopes: string[] = []): UserContext {
  return { actorType: "user", userId: w.member.userId, orgId: w.orgId, scopes, dimensionGrants: {} }
}

/** The first org's admin, holding every scope. */
export function adminContext(w: DoorWorld): UserContext {
  return {
    actorType: "user",
    userId: w.admin.userId,
    orgId: w.orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

/**
 * The portal role entered by hand for any user id, past the portal context's own
 * refusal: the views themselves must hold when a context carries an id the entry
 * would have refused (a closed company's person, a member).
 */
export function asPortalRole<T>(
  orgId: string,
  userId: string,
  fn: (tx: RlsClient) => Promise<T>,
): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} },
    async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('role', 'liaison_portal', true)`)
      return fn(tx)
    },
  )
}

/** A member's or a client's transaction: anything that runs a statement and opens a savepoint. */
export interface DoorTx {
  execute: (query: SQL) => Promise<unknown>
  transaction: <T>(fn: (sp: DoorTx) => Promise<T>) => Promise<T>
}

export type Outcome = { rows: Record<string, unknown>[] } | { code: string; message: string }

function pgError(err: unknown): { code: string; message: string } {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  return {
    code: e?.cause?.code ?? e?.code ?? "unknown",
    message: e?.cause?.message ?? e?.message ?? "",
  }
}

/** Runs one statement in a savepoint and returns its rows or the error it raised. */
export async function attempt(tx: DoorTx, statement: string): Promise<Outcome> {
  try {
    return {
      rows: await tx.transaction(async (sp) =>
        extractRows<Record<string, unknown>>(await sp.execute(drizzleSql.raw(statement))),
      ),
    }
  } catch (err) {
    return pgError(err)
  }
}

/** The rows of a statement that must succeed. */
export async function rowsOf(tx: DoorTx, statement: string) {
  return extractRows<Record<string, unknown>>(await tx.execute(drizzleSql.raw(statement)))
}

/** A uuid list as a SQL array literal; every other value as is. */
export function uuidArray(ids: string[]): RowValue {
  return { raw: `ARRAY[${ids.map((id) => `'${id}'`).join(", ")}]::uuid[]` }
}

function withArrays(
  values: Record<string, RowValue | string[] | undefined>,
): Record<string, RowValue> {
  const out: Record<string, RowValue> = {}
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? uuidArray(v) : v
  }
  return out
}

/** An open client action on a target, for the first org's company. */
export async function insertClientAction(
  w: DoorWorld,
  values: Record<string, RowValue | string[]> & { company_id: string | null },
): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.client_actions", {
      id,
      org_id: w.orgId,
      group_id: crypto.randomUUID(),
      kind: "sign",
      target_app: "agreements",
      target_type: "agreement_version",
      target_id: crypto.randomUUID(),
      target_sha256: "a".repeat(64),
      invited_email: w.clientA.email,
      invited_name: w.clientA.name,
      token_hash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      expires_at: { raw: "now() + interval '7 days'" },
      ...withArrays(values),
    }),
  )
  return id
}

/** An open share for a company of the first org. */
export async function insertShare(
  w: DoorWorld,
  values: { company_id: string; kind: string; object_id?: string | null; only_user_ids?: string[] },
): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.portal_shares", {
      id,
      org_id: w.orgId,
      shared_by_user_id: w.admin.userId,
      object_id: null,
      ...withArrays(values),
    }),
  )
  return id
}

/** A system mail provider that keeps what it was given, optionally after a delay. */
export class CaptureProvider implements EmailProvider {
  sent: EmailMessage[] = []
  constructor(private delayMs = 0) {}
  async send(message: EmailMessage): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    this.sent.push(message)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

/** An allowed Origin for the portal's refresh route. */
export const ORIGIN = "http://localhost:5173"

export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** The challenge id and token of a captured portal sign-in mail (its link's fragment). */
export function linkOf(mail: EmailMessage | undefined): { challengeId: string; token: string } {
  const m = (mail?.text ?? mail?.html ?? "").match(
    /#c=([A-Za-z0-9_-]+)&(?:amp;)?t=([A-Za-z0-9_-]+)/,
  )
  if (!m?.[1] || !m[2]) throw new Error("no portal sign-in link in the mail")
  return { challengeId: m[1], token: m[2] }
}

/** The portal refresh cookie a response set, or null. */
export function cookieOf(res: Response): string | null {
  const set = res.headers.get("set-cookie") ?? ""
  const m = set.match(new RegExp(`${PORTAL_REFRESH_COOKIE}=([^;]*)`))
  return m?.[1] ? m[1] : null
}

/** Forgets the sign-in send budgets (portal and member), so one run may ask for several links. */
export async function clearSends(): Promise<void> {
  await clearRedisPatterns([
    "portal:signin:*",
    "magic-rate:*",
    "magic:cooldown:*",
    "magic:email-hour:*",
    "magic:email-day:*",
    "reset-rate:*",
  ])
}
