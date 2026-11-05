// SPDX-License-Identifier: FSL-1.1-ALv2
// The categories tree of the tickets settings page saves in ONE call:
// `categories.reorder { baseVersion, nodes }` applies order, parents, names,
// new nodes (temp ids) and archives in one transaction, on the version the page
// loaded (`categories.tree`). A second save on the same base is refused (409),
// and the two-level rule is checked on the FINAL tree by a deferred constraint
// trigger, so a swap that passes through three levels mid-transaction succeeds
// while a final third level is refused, also when a root that has children is
// re-parented (the gap the old per-row trigger left open).
import { beforeEach, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string

async function freshOrg(): Promise<void> {
  const slug = `cat-reorder-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("cat-reorder-fixture", async (tx) => {
    const orgRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Cat Reorder', ${slug}) RETURNING id
      `),
    )
    orgId = orgRows[0].id
    const u = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
      `),
    )
    userId = u[0].id
  })
  await ensureAppsForOrg(orgId, {})
}

const op = (name: string, params: Record<string, unknown> = {}) =>
  withSystemDb("cat-reorder-op", (tx) =>
    runAdminOp(tx as never, orgId, name, params, {
      actorType: "user",
      userId,
      scopes: ["tickets:categories:admin", "tickets:tickets:read"],
    }),
  ) as Promise<any>

/** Run reorder; a commit-time refusal (the deferred trigger) surfaces as a thrown error. */
async function reorder(params: Record<string, unknown>): Promise<any> {
  try {
    return await op("categoriesReorder", params)
  } catch (err) {
    const e = err as Error & { cause?: Error }
    return { thrown: `${e.message}\n${e.cause?.message ?? ""}` }
  }
}

async function create(name: string, parentId: string | null = null): Promise<string> {
  const row = await op("categoriesCreate", { name, parentId })
  return row.id as string
}

async function stored(): Promise<
  Array<{
    id: string
    name: string
    parent_id: string | null
    sort_order: number
    archived: boolean
  }>
> {
  return extractRows(
    await db.execute(drizzleSql`
      SELECT id, name, parent_id, sort_order, archived_at IS NOT NULL AS archived
      FROM app_tickets.categories WHERE org_id = ${orgId} ORDER BY sort_order, name
    `),
  )
}

beforeEach(freshOrg)

describe("tickets categories.tree / categories.reorder", () => {
  it("the manifest declares both tools for the settings page only", () => {
    const tools = (ticketsManifest as any).tools
    expect(tools["categories.tree"].readOnly).toBe(true)
    expect(tools["categories.tree"].requiredScopes).toEqual(["tickets:tickets:read"])
    expect(tools["categories.tree"].agentVisible).toBe(false)
    expect(tools["categories.reorder"].requiredScopes).toEqual(["tickets:categories:admin"])
    expect(tools["categories.reorder"].gated).toBeUndefined()
    expect(tools["categories.reorder"].agentVisible).toBe(false)
    expect(tools["categories.reorder"].params.required).toEqual(["baseVersion", "nodes"])
  })

  it("tree returns the rows with updated_at and a version that moves on every write", async () => {
    const empty = await op("categoriesTree")
    expect(empty.rows).toEqual([])
    expect(typeof empty.version).toBe("string")
    await create("Billing")
    const one = await op("categoriesTree")
    expect(one.rows).toHaveLength(1)
    expect(one.rows[0].updated_at).toBeTruthy()
    expect(one.version).not.toBe(empty.version)
  })

  it("two saves on the same base: the second is refused with conflict (409)", async () => {
    const a = await create("A")
    const { version } = await op("categoriesTree")
    const first = await reorder({
      baseVersion: version,
      nodes: [{ id: a, parentId: null, name: "A renamed", sortOrder: 0 }],
    })
    expect(first.error).toBeUndefined()
    expect(typeof first.version).toBe("string")
    const second = await reorder({
      baseVersion: version,
      nodes: [{ id: a, parentId: null, name: "A other", sortOrder: 0 }],
    })
    expect(second.error?.code).toBe("conflict")
    expect((await stored())[0].name).toBe("A renamed")
  })

  it("a swap passing through three levels mid-save succeeds (root A with child B goes under C, B is promoted)", async () => {
    const a = await create("A")
    const b = await create("B", a)
    const c = await create("C")
    const { version } = await op("categoriesTree")
    const out = await reorder({
      baseVersion: version,
      nodes: [
        { id: c, parentId: null, name: "C", sortOrder: 0 },
        { id: a, parentId: c, name: "A", sortOrder: 0 },
        { id: b, parentId: null, name: "B", sortOrder: 1 },
      ],
    })
    expect(out.error).toBeUndefined()
    expect(out.thrown).toBeUndefined()
    const rows = await stored()
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get(a)?.parent_id).toBe(c)
    expect(by.get(b)?.parent_id).toBeNull()
    expect(by.get(c)?.parent_id).toBeNull()
  })

  it("a final third level is refused: category_depth_limit, nothing written", async () => {
    const a = await create("A")
    const b = await create("B", a)
    const c = await create("C")
    const { version } = await op("categoriesTree")
    const out = await reorder({
      baseVersion: version,
      nodes: [
        { id: c, parentId: null, name: "C", sortOrder: 0 },
        { id: a, parentId: c, name: "A", sortOrder: 0 },
        { id: b, parentId: a, name: "B", sortOrder: 0 },
      ],
    })
    expect(out.error?.code).toBe("category_depth_limit")
    const by = new Map((await stored()).map((r) => [r.id, r]))
    expect(by.get(a)?.parent_id).toBeNull()
  })

  it("the database refuses a root with children moved under another root (deferred trigger)", async () => {
    const a = await create("A")
    await create("B", a)
    const c = await create("C")
    const out = await withSystemDb("cat-reorder-raw", async (tx) => {
      try {
        await tx.execute(drizzleSql`
          UPDATE app_tickets.categories SET parent_id = ${c}::uuid WHERE id = ${a}::uuid
        `)
        return "committed"
      } catch (err) {
        return `${(err as Error).message}\n${((err as Error).cause as Error | undefined)?.message ?? ""}`
      }
    }).catch((err: Error) => `${err.message}\n${(err.cause as Error | undefined)?.message ?? ""}`)
    expect(out).toContain("category_depth_limit")
    const by = new Map((await stored()).map((r) => [r.id, r]))
    expect(by.get(a)?.parent_id).toBeNull()
  })

  it("new nodes travel with temp ids, a child may name its new parent's temp id, server ids come back", async () => {
    const { version } = await op("categoriesTree")
    const out = await reorder({
      baseVersion: version,
      nodes: [
        { tempId: "t1", parentId: null, name: "Hardware", sortOrder: 0 },
        { tempId: "t2", parentTempId: "t1", name: "Returns", sortOrder: 0 },
      ],
    })
    expect(out.error).toBeUndefined()
    expect(typeof out.ids.t1).toBe("string")
    const rows = await stored()
    const hw = rows.find((r) => r.name === "Hardware")
    const ret = rows.find((r) => r.name === "Returns")
    expect(hw?.id).toBe(out.ids.t1)
    expect(ret?.parent_id).toBe(out.ids.t1)
  })

  it("an archived child does not count toward the depth", async () => {
    const a = await create("A")
    const b = await create("B", a)
    const c = await create("C")
    const { version } = await op("categoriesTree")
    // B is archived and A moves under C: the live tree is two levels.
    const out = await reorder({
      baseVersion: version,
      nodes: [
        { id: c, parentId: null, name: "C", sortOrder: 0 },
        { id: a, parentId: c, name: "A", sortOrder: 0 },
        { id: b, parentId: a, name: "B", sortOrder: 0, archived: true },
      ],
    })
    expect(out.error).toBeUndefined()
    expect(out.thrown).toBeUndefined()
    const by = new Map((await stored()).map((r) => [r.id, r]))
    expect(by.get(a)?.parent_id).toBe(c)
    expect(by.get(b)?.archived).toBe(true)
  })

  it("an id from another org is refused", async () => {
    const { version } = await op("categoriesTree")
    const out = await reorder({
      baseVersion: version,
      nodes: [
        { id: "00000000-0000-4000-8000-000000000001", parentId: null, name: "X", sortOrder: 0 },
      ],
    })
    expect(out.error?.code).toBe("invalid_params")
  })
})
