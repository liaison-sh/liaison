// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel's doors around a client's portal account: what the portal role can
// reach in the database, what the member side lists, and what a client can never
// be given. Every read runs on the real roles (liaison_rls, liaison_portal); rows
// are written on the privileged connection.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { app } from "~/app"
import { resolveAssignee } from "~/apps/projects/service/resolve"
import { extractRows, sql } from "~/db"
import { type PortalClient, PortalContextRefusedError, withPortalContext } from "~/db/portal-rls"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import {
  assignRolePreflight,
  handleAssignRole,
  handleDescribeUserAccess,
  handleGrantDimensionValue,
  handleSetUserScope,
  setUserScopePreflight,
} from "~/modules/agent/tools/admin-tools"
import { handleUsersSearch } from "~/modules/agent/tools/user-tools"
import { resolveRecipients } from "~/modules/attention/recipients"
import { signAccessToken } from "~/modules/auth/jwt"
import { countSeats, readOrgCaps, setOrgCaps } from "~/modules/org/caps"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"
import { scopeHoldersInTx, withoutExternalUsers } from "~/modules/permissions/scope-holders"
import {
  rowPassesIndexFilter,
  searchableRegistrationsFrom,
} from "~/modules/search/searchable-entities"
import { listShareMembers } from "~/modules/sharing/targets"
import { listActiveMembers } from "~/modules/threads/member-directory"
import { createExternalUser } from "~/modules/users/external-user"
import { listUsers } from "~/modules/users/service"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  adminContext,
  asPortalRole,
  attempt,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  insertShare,
  memberContext,
  rowsOf,
} from "./fixture"

let w: DoorWorld

/** A portal transaction for one client, through the product's own entry. */
function asClient<T>(
  orgId: string,
  client: { userId: string },
  fn: (tx: PortalClient) => Promise<T>,
): Promise<T> {
  return withPortalContext({ orgId, userId: client.userId }, fn)
}

/** A superuser, for what no product role may do: DDL in kernel, writes past triggers. */
function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}
const superuser = postgres(superuserUrl(), { max: 1, onnotice: () => {} })

beforeAll(async () => {
  w = await createDoorWorld()
})

afterAll(async () => {
  await dropDoorWorld(w)
  await superuser.end()
})

const clientIds = () => [w.clientA, w.clientA2, w.clientB, w.clientC].map((c) => c.userId)
const noClient = (ids: string[]) => ids.filter((id) => clientIds().includes(id))

describe("what the portal role reaches", () => {
  it("NT-10 the portal role gets permission denied on kernel tables and on each table behind a portal view", async () => {
    const tables = [
      "kernel.users",
      "kernel.contacts",
      "kernel.roles",
      "kernel.threads",
      "kernel.companies",
      "kernel.audit_log",
      "kernel.client_actions",
      "kernel.client_action_events",
      "kernel.client_action_devices",
      "kernel.portal_shares",
      "kernel.portal_people",
      "app_projects.task_time",
    ]
    const results = await asClient(w.orgId, w.clientA, async (tx) => {
      const out: Record<string, unknown> = {}
      for (const t of tables) out[t] = await attempt(tx, `SELECT * FROM ${t} LIMIT 1`)
      return out
    })
    for (const t of tables) {
      // Rows, or an empty answer, here is a boundary failure, not a test to adjust.
      expect({ table: t, outcome: results[t] }).toMatchObject({
        table: t,
        outcome: { code: "42501" },
      })
    }
  })

  it("NT-10 a table created later is denied to the portal role", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const inPortal = `portal.door_probe_${tag}`
    const inKernel = `kernel.door_probe_${tag}`
    await superuser.unsafe(`CREATE TABLE ${inPortal} (id int)`)
    await superuser.unsafe(`CREATE TABLE ${inKernel} (id int)`)
    try {
      const results = await asClient(w.orgId, w.clientA, async (tx) => ({
        portal: await attempt(tx, `SELECT * FROM ${inPortal}`),
        kernel: await attempt(tx, `SELECT * FROM ${inKernel}`),
      }))
      expect(results.portal).toMatchObject({ code: "42501" })
      expect(results.kernel).toMatchObject({ code: "42501" })
    } finally {
      await superuser.unsafe(`DROP TABLE ${inPortal}`)
      await superuser.unsafe(`DROP TABLE ${inKernel}`)
    }
  })
})

describe("kernel.users is not exposed", () => {
  it("NT-11 portal.me and portal.people_me answer only the caller, and nothing for a member's id", async () => {
    const mine = await asClient(w.orgId, w.clientA, async (tx) => ({
      me: await rowsOf(tx, "SELECT id FROM portal.me"),
      people: await rowsOf(tx, "SELECT * FROM portal.people_me"),
    }))
    expect(mine.me.map((r) => r.id)).toEqual([w.clientA.userId])
    expect(mine.people).toHaveLength(1)
    expect(Object.keys(mine.people[0] ?? {}).sort()).toEqual(
      ["notice_ack_at", "notice_version", "title"].sort(),
    )
    const asMemberId = await asPortalRole(w.orgId, w.member.userId, async (tx) => ({
      me: await rowsOf(tx, "SELECT id FROM portal.me"),
      people: await rowsOf(tx, "SELECT * FROM portal.people_me"),
      company: await rowsOf(tx, "SELECT portal.company_id() AS id"),
    }))
    expect(asMemberId.me).toEqual([])
    expect(asMemberId.people).toEqual([])
    expect(asMemberId.company).toEqual([{ id: null }])
  })

  it("NT-11 no portal view hands a client a staff member's id, name or address", async () => {
    const target = crypto.randomUUID()
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: target })
    await insertClientAction(w, {
      company_id: w.companyA,
      target_id: target,
      signer_user_id: w.member.userId,
      created_by_user_id: w.admin.userId,
    })
    const views = await sql<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'portal' AND c.relkind = 'v'`
    expect(views.length).toBeGreaterThanOrEqual(4)
    const bodies = await asClient(w.orgId, w.clientA, async (tx) => {
      const out: string[] = []
      for (const v of views) out.push(JSON.stringify(await rowsOf(tx, `SELECT * FROM ${v.name}`)))
      return out.join("\n")
    })
    // The share and the action are visible, so the search below reads real rows.
    expect(bodies).toContain(target)
    for (const staff of [w.member, w.admin]) {
      for (const value of [staff.userId, staff.email, staff.name]) {
        expect(bodies.includes(value)).toBe(false)
      }
    }
  })
})

describe("the views read stamps and open shares", () => {
  it("NT-23 a client action with no company reads as no row to every client", async () => {
    const target = crypto.randomUUID()
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: target })
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: target })
    const id = await insertClientAction(w, { company_id: null, target_id: target })
    for (const client of [w.clientA, w.clientB]) {
      const rows = await asClient(w.orgId, client, (tx) =>
        rowsOf(tx, "SELECT id FROM portal.client_actions"),
      )
      expect(rows.map((r) => r.id)).not.toContain(id)
    }
  })

  it("company B's shares and actions never reach company A's client, and a named share only its people", async () => {
    const forB = crypto.randomUUID()
    const named = crypto.randomUUID()
    const restricted = crypto.randomUUID()
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: forB })
    const bAction = await insertClientAction(w, { company_id: w.companyB, target_id: forB })
    await insertShare(w, {
      company_id: w.companyA,
      kind: "file",
      object_id: named,
      only_user_ids: [w.clientA.userId],
    })
    // A restricted document's action needs the share to name the reader.
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: restricted })
    const restrictedAction = await insertClientAction(w, {
      company_id: w.companyA,
      target_id: restricted,
      visible_to: [w.member.userId],
    })
    const read = (client: typeof w.clientA) =>
      asClient(w.orgId, client, async (tx) => ({
        shares: (await rowsOf(tx, "SELECT object_id FROM portal.shares")).map((r) => r.object_id),
        actions: (await rowsOf(tx, "SELECT id FROM portal.client_actions")).map((r) => r.id),
      }))
    const a = await read(w.clientA)
    const a2 = await read(w.clientA2)
    const b = await read(w.clientB)
    expect(a.shares).not.toContain(forB)
    expect(a.actions).not.toContain(bAction)
    expect(b.actions).toContain(bAction)
    expect(a.shares).toContain(named)
    expect(a2.shares).not.toContain(named)
    expect(a.actions).not.toContain(restrictedAction)
    expect(a2.actions).not.toContain(restrictedAction)
    const other = await asClient(w.otherOrgId, w.otherClient, async (tx) => ({
      shares: await rowsOf(tx, "SELECT object_id FROM portal.shares"),
      actions: await rowsOf(tx, "SELECT id FROM portal.client_actions"),
    }))
    expect(other).toEqual({ shares: [], actions: [] })
  })

  it("after the company closes, the next portal read returns nothing on the same token", async () => {
    const target = crypto.randomUUID()
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: target })
    const before = await asClient(w.orgId, w.clientB, (tx) =>
      rowsOf(tx, "SELECT object_id FROM portal.shares"),
    )
    expect(before.map((r) => r.object_id)).toContain(target)
    const nothing = async () => {
      const rows = await asPortalRole(w.orgId, w.clientB.userId, async (tx) => ({
        company: await rowsOf(tx, "SELECT portal.company_id() AS id"),
        me: await rowsOf(tx, "SELECT id FROM portal.me"),
        shares: await rowsOf(tx, "SELECT object_id FROM portal.shares"),
        contact: await rowsOf(tx, "SELECT portal.contact_id() AS id"),
      }))
      expect(rows).toEqual({ company: [{ id: null }], me: [], shares: [], contact: [{ id: null }] })
      await expect(asClient(w.orgId, w.clientB, async () => "ran")).rejects.toBeInstanceOf(
        PortalContextRefusedError,
      )
    }
    try {
      await sql`UPDATE kernel.companies SET closed_at = now() WHERE id = ${w.companyB}`
      await nothing()
      await sql`UPDATE kernel.companies SET closed_at = NULL, portal_ended_at = now() WHERE id = ${w.companyB}`
      await nothing()
    } finally {
      await sql`UPDATE kernel.companies SET closed_at = NULL, portal_ended_at = NULL WHERE id = ${w.companyB}`
    }
    // A company closed from the start: its person never reads its open share.
    await insertShare(w, { company_id: w.companyC, kind: "invoices" })
    const closed = await asPortalRole(w.orgId, w.clientC.userId, (tx) =>
      rowsOf(tx, "SELECT kind FROM portal.shares"),
    )
    expect(closed).toEqual([])
  })
})

describe("a person never changes kind", () => {
  it("NT-30 changing user_type raises, for liaison_admin too", async () => {
    for (const [id, to] of [
      [w.clientA.userId, "member"],
      [w.member.userId, "external"],
    ] as const) {
      const outcome = await sql
        .begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE liaison_admin")
          await tx.unsafe(`UPDATE kernel.users SET user_type = '${to}' WHERE id = '${id}'`)
          return "updated"
        })
        .catch((err: Error) => err.message)
      expect(outcome).toContain("user_type cannot change")
    }
  })
})

describe("pickers, mentions and assignment hold no client", () => {
  const tokenFor = (scopes: string[]) =>
    signAccessToken(
      {
        userId: w.member.userId,
        orgId: w.orgId,
        name: w.member.name,
        authVersion: 1,
        permissionVersion: 1,
        scopes,
      },
      env.JWT_SECRET,
    )
  const getIds = async (path: string, scopes: string[], pick: (d: unknown) => string[]) => {
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${await tokenFor(scopes)}` },
    })
    expect({ path, scopes, status: res.status }).toEqual({ path, scopes, status: 200 })
    return pick(((await res.json()) as { data: unknown }).data)
  }

  it("NT-33 as a member and as an admin holding every scope, pickers hold no client", async () => {
    for (const ctx of [memberContext(w, ["kernel:users:read"]), adminContext(w)]) {
      const listed = await withRlsContext(ctx, async (tx) => ({
        users: (await listUsers(tx, { orgId: w.orgId, page: 1, limit: 100 })).rows.map((r) => r.id),
        share: (await listShareMembers(tx, w.orgId)).map((m) => m.userId),
        directory: (await listActiveMembers(tx, { orgId: w.orgId, limit: 100 })).items.map(
          (m) => m.id,
        ),
        search: (
          await handleUsersSearch({}, { db: tx, orgId: w.orgId, userId: ctx.userId })
        ).items.map((u) => u.id),
      }))
      for (const ids of Object.values(listed)) {
        expect(ids).toContain(w.member.userId)
        expect(noClient(ids)).toEqual([])
      }
    }
    // A token holding `*` must pass the admin second factor; the portal admin scope
    // is the one that lets a session read clients' rows, so it stands for the admin.
    const reader = ["kernel:threads:read", "kernel:threads:write"]
    for (const scopes of [reader, ["kernel:portal:admin", ...reader]]) {
      const members = await getIds("/api/sharing/members", scopes, (d) =>
        (d as { userId: string }[]).map((m) => m.userId),
      )
      const directory = await getIds("/api/mentions/members", scopes, (d) =>
        (d as { id: string }[]).map((m) => m.id),
      )
      expect(noClient(members)).toEqual([])
      expect(noClient(directory)).toEqual([])
      expect(members).toContain(w.member.userId)
    }
    // Mention search: a client's account is never indexed nor found by the fallback.
    const userReg = searchableRegistrationsFrom([]).entities.find((e) => e.entityType === "user")
    expect(userReg).toBeDefined()
    if (!userReg) return
    expect(rowPassesIndexFilter(userReg, { status: "active", user_type: "external" })).toBe(false)
    expect(rowPassesIndexFilter(userReg, { status: "active", user_type: "member" })).toBe(true)
    // describe_user_access: a client is no teammate to describe.
    const described = await handleDescribeUserAccess(
      { userId: w.clientA.userId },
      { orgId: w.orgId, userId: w.admin.userId },
    )
    expect(described).toEqual({ error: { code: "USER_NOT_FOUND" } })
  })

  it("NT-33b scope holders, mentions and eligible approvers never resolve to a client", async () => {
    // A grant on a client's row cannot be written any more; one is forced in past
    // the triggers to prove the readers' own filter.
    await superuser.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica")
      await tx.unsafe(
        insertSql("kernel.user_scope_grants", {
          user_id: w.clientA.userId,
          org_id: w.orgId,
          scope: "kernel:audit:read",
        }),
      )
    })
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", {
        user_id: w.member.userId,
        org_id: w.orgId,
        scope: "kernel:audit:read",
      }),
    )
    try {
      const { holders, approvers } = await withPrivilegedDb(w.orgId, "doors-test", async (tx) => ({
        holders: await scopeHoldersInTx(tx, w.orgId, "kernel:audit:read"),
        approvers: await eligibleApprovers(tx, w.orgId, "kernel:audit:read"),
      }))
      expect(holders).toContain(w.member.userId)
      expect(noClient(holders)).toEqual([])
      expect(noClient(approvers)).toEqual([])
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${w.orgId}`
    }
    const ctx = { orgId: w.orgId, keepMembers: withoutExternalUsers }
    const event = {
      actorId: w.clientA.userId,
      data: {
        text: `ping @[Client](user:${w.clientA.userId}) and @[Member](user:${w.member.userId})`,
        assignee: w.clientA.userId,
        people: [w.clientA.userId, w.member.userId],
      },
    }
    expect(await resolveRecipients({ kind: "mentions", path: "data.text" }, event, ctx)).toEqual(
      (
        await resolveRecipients({ kind: "mentions", path: "data.text" }, event, { orgId: w.orgId })
      ).filter((id) => id !== w.clientA.userId),
    )
    expect(await resolveRecipients({ kind: "field", path: "data.assignee" }, event, ctx)).toEqual(
      [],
    )
    expect(await resolveRecipients({ kind: "actor" }, event, ctx)).toEqual([])
    expect(
      await resolveRecipients({ kind: "participants", path: "data.people" }, event, ctx),
    ).toEqual([w.member.userId])
  })

  it("NT-33c users_search as a member and as an admin returns no client, and a client assignee is refused", async () => {
    for (const ctx of [memberContext(w, ["kernel:users:read"]), adminContext(w)]) {
      const found = await withRlsContext(ctx, (tx) =>
        handleUsersSearch({ query: "client" }, { db: tx, orgId: w.orgId, userId: ctx.userId }),
      )
      expect(found.items).toEqual([])
      const refused = await withRlsContext(ctx, async (tx) => {
        const out: string[] = []
        for (const input of [{ assigneeId: w.clientA.userId }, { assigneeName: w.clientA.name }]) {
          out.push(
            await resolveAssignee(tx, w.orgId, input).then(
              () => "assigned",
              (err: { code?: string }) => err.code ?? "error",
            ),
          )
        }
        return out
      })
      expect(refused).toEqual(["assignee_not_found", "assignee_not_found"])
    }
    const assigned = await withRlsContext(adminContext(w), (tx) =>
      resolveAssignee(tx, w.orgId, { assigneeId: w.member.userId }),
    )
    expect(assigned).toBe(w.member.userId)
  })
})

describe("no role, no scope, no seat", () => {
  it("NT-34 assign_role, grant_user_scope and grant_dimension_value refuse a client in a plain sentence, and a direct insert raises", async () => {
    const roleId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.roles", {
        id: roleId,
        org_id: w.orgId,
        name: `door-${roleId.slice(0, 8)}`,
      }),
    )
    const ctx = { orgId: w.orgId, userId: w.admin.userId }
    const target = w.clientA.userId
    const results = [
      await handleAssignRole({ userId: target, roleId }, ctx),
      await handleSetUserScope({ userId: target, grant: ["kernel:audit:read"] }, ctx),
      await handleGrantDimensionValue(
        { userId: target, dimension: "territory", values: ["FR"] },
        ctx,
      ),
      await assignRolePreflight({ userId: target, roleId }, ctx),
      await setUserScopePreflight({ userId: target, grant: ["kernel:audit:read"] }, ctx),
    ]
    for (const r of results) {
      const error = (r as { error?: { code: string; message?: string } }).error
      expect(error?.code).toBe("USER_IS_EXTERNAL")
      expect(error?.message?.startsWith("This person is a client")).toBe(true)
    }
    for (const [table, row] of [
      ["kernel.user_roles", { user_id: target, role_id: roleId, org_id: w.orgId }],
      [
        "kernel.user_scope_grants",
        { user_id: target, org_id: w.orgId, scope: "kernel:audit:read" },
      ],
      [
        "kernel.user_dimension_grants",
        {
          user_id: target,
          org_id: w.orgId,
          dimension_key: "territory",
          dimension_values: '["FR"]',
        },
      ],
    ] as const) {
      const outcome = await sql.unsafe(insertSql(table, row)).then(
        () => "inserted",
        (err: Error) => err.message,
      )
      expect(outcome).toMatch(/an external user holds no/)
    }
    const grants = await sql`
      SELECT (SELECT count(*) FROM kernel.user_roles WHERE user_id = ${target})::int AS roles,
             (SELECT count(*) FROM kernel.user_scope_grants WHERE user_id = ${target})::int AS scopes,
             (SELECT count(*) FROM kernel.user_dimension_grants WHERE user_id = ${target})::int AS dims`
    expect(grants[0]).toEqual({ roles: 0, scopes: 0, dims: 0 })
  })

  it("NT-35 at the seat cap a client invite works and the count stays", async () => {
    const before = await withPrivilegedDb(w.orgId, "doors-test", (tx) => countSeats(tx, w.orgId))
    const caps = await readOrgCaps(w.orgId)
    await setOrgCaps(w.orgId, { set: { seats: before } })
    try {
      const made = await withPrivilegedDb(w.orgId, "doors-test", (tx) =>
        createExternalUser(tx, {
          orgId: w.orgId,
          companyId: w.companyA,
          email: `seat-${crypto.randomUUID().slice(0, 8)}@doors.example.com`,
          name: "Seat Client",
        }),
      )
      expect(made.ok).toBe(true)
      const after = await withPrivilegedDb(w.orgId, "doors-test", (tx) => countSeats(tx, w.orgId))
      expect(after).toBe(before)
    } finally {
      await setOrgCaps(w.orgId, {
        unset: ["seats"],
        set: caps.seats == null ? {} : { seats: caps.seats },
      })
    }
  })
})

describe("what can never be shared", () => {
  it("NT-39 a share kind for notes, discussions, agents, routines, cost or margin does not exist", async () => {
    for (const kind of ["notes", "threads", "agents", "routines", "cost", "margin", "task_time"]) {
      const outcome = await sql
        .unsafe(
          insertSql("kernel.portal_shares", {
            org_id: w.orgId,
            company_id: w.companyA,
            kind,
            object_id: crypto.randomUUID(),
            shared_by_user_id: w.admin.userId,
          }),
        )
        .then(
          () => "inserted",
          (err: { code?: string }) => err.code,
        )
      expect({ kind, outcome }).toEqual({ kind, outcome: "23514" })
    }
  })
})

describe("what a client did is read only with the portal log scope", () => {
  it("NT-40 a member with the audit scope and no portal log scope reads no portal row", async () => {
    await sql.unsafe(
      insertSql("kernel.audit_log", [
        { org_id: w.orgId, actor_type: "system", app: "portal", action: "signed_in" },
        { org_id: w.orgId, actor_type: "system", app: "kernel", action: "door_probe" },
      ]),
    )
    const read = (scopes: string[]) =>
      withRlsContext(memberContext(w, scopes), async (tx) =>
        extractRows<{ app: string }>(
          await tx.execute(drizzleSql`SELECT app FROM kernel.audit_log WHERE org_id = ${w.orgId}`),
        )
          .map((r) => r.app)
          .sort(),
      )
    expect(await read(["kernel:audit:read"])).toEqual(["kernel"])
    expect(await read(["kernel:audit:read", "kernel:portal:logs"])).toEqual(["kernel", "portal"])
  })
})
