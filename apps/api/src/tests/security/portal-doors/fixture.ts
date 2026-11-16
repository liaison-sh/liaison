// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world every portal door test runs in: two orgs; in the first, companies A
// and B and a closed company C, a member, an admin holding `*`, and portal
// people of each company; in the second, a company and its portal person. Rows
// are written on the privileged connection, then every read runs through the
// real roles: liaison_rls for members, liaison_portal for clients.

import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"

export interface DoorPerson {
  userId: string
  contactId: string
  email: string
  name: string
}

export interface DoorWorld {
  orgId: string
  otherOrgId: string
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
    otherOrgId: crypto.randomUUID(),
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
      { id: w.orgId, name: "Maison Portes", slug: `doors-${tag}` },
      { id: w.otherOrgId, name: "Maison Autre", slug: `doors-other-${tag}` },
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
  for (const [c, orgId, companyId] of clients) {
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
  return w
}

/**
 * Removes every row of the world. The client action trail is append only for a
 * year, so its rows go the way an org purge takes them: the org marked deleting,
 * then liaison_admin with the purge setting naming the org.
 */
export async function dropDoorWorld(w: DoorWorld): Promise<void> {
  const k = (table: string) => `"${schemaRef("kernel")}".${table}`
  const byOrg = [
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
