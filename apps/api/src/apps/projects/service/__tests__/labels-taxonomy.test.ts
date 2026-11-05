// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task label taxonomy service: admin writes (create, rename, reorder,
// archive, restore, whole-tree save), the immutable parent, name uniqueness
// among name-active siblings, the version token, the settings tree contract,
// the admin scope and one `label` event per write.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  archiveLabel,
  createLabel,
  labelsTree,
  labelsVersion,
  listLabels,
  reorderLabels,
  updateLabel,
} from "~/apps/projects/service/labels"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let admin: UserContext
let member: UserContext

async function seedOrg(): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Labels Taxonomy Org', ${`labels-tax-${stamp}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`labels-tax-${stamp}@test.com`}, 'Labels Admin', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  admin = {
    actorType: "user",
    userId: user!.id,
    orgId,
    scopes: ["projects:projects:read", "projects:labels:admin"],
    dimensionGrants: { "*": ["*"] },
  }
  member = { ...admin, scopes: ["projects:projects:read", "projects:tasks:write"] }
}

beforeAll(async () => {
  await acquireTestLock()
  await seedOrg()
})

afterAll(releaseTestLock)

const as = <T>(actor: UserContext, fn: (tx: RlsClient) => Promise<T>) =>
  withRlsContext(actor, (tx) => fn(tx as RlsClient))

const uniq = (s: string) => `${s}-${Math.random().toString(36).slice(2, 7)}`

const create = (name: string, parentId?: string | null, sortOrder?: number) =>
  as(admin, (tx) => createLabel({ tx, orgId, actor: admin, input: { name, parentId, sortOrder } }))
const update = (input: Parameters<typeof updateLabel>[0]["input"]) =>
  as(admin, (tx) => updateLabel({ tx, orgId, actor: admin, input }))
const archive = (id: string, archived = true) =>
  as(admin, (tx) => archiveLabel({ tx, orgId, actor: admin, input: { id, archived } }))
const list = (includeArchived = false) =>
  as(admin, (tx) => listLabels({ tx, orgId, includeArchived }))
const version = () => as(admin, (tx) => labelsVersion(tx, orgId))
const tree = () => as(admin, (tx) => labelsTree({ tx, orgId }))
const reorder = (baseVersion: unknown, nodes: unknown[]) =>
  as(admin, (tx) => reorderLabels({ tx, orgId, actor: admin, input: { baseVersion, nodes } }))

async function rowCount(): Promise<number> {
  const [r] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM app_projects.labels WHERE org_id = ${orgId}::uuid`,
    ),
  )
  return r!.n
}

async function storedRow(id: string) {
  const [r] = extractRows<{ name: string; parent_id: string | null; archived_at: unknown }>(
    await db.execute(
      drizzleSql`SELECT name, parent_id, archived_at FROM app_projects.labels WHERE id = ${id}::uuid`,
    ),
  )
  return r!
}

async function caught(fn: () => Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await fn()
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string }
    return { code: e.code, status: e.status }
  }
  throw new Error("expected a refusal")
}

async function labelEvents(sinceSeq: number) {
  return extractRows<{ action: string; entity_id: string }>(
    await db.execute(drizzleSql`
      SELECT payload->>'action' AS action, payload->>'entityId' AS entity_id
      FROM kernel.pending_events
      WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'projects' AND payload->>'entity' = 'label'
        AND seq > ${sinceSeq}
      ORDER BY seq
    `),
  )
}

async function maxSeq(): Promise<number> {
  const [r] = extractRows<{ s: number | null }>(
    await db.execute(drizzleSql`SELECT max(seq)::int AS s FROM kernel.pending_events`),
  )
  return r?.s ?? 0
}

/** A fresh group with values, for tests that must not see each other's rows. */
async function seedGroup(values: string[]) {
  const g = await create(uniq("G"))
  const vs = []
  for (const v of values) vs.push(await create(v, g.id))
  return { g, vs }
}

describe("labels taxonomy: create, rename, order, list", () => {
  it("creates a group and values, renames both, reorders values, lists live in order", async () => {
    const g = await create(uniq("Nature"))
    const bug = await create("bug", g.id)
    const evo = await create("evolution", g.id)
    expect(bug.parentId).toBe(g.id)
    expect(evo.sortOrder).toBe(bug.sortOrder + 1)
    const renamedG = await update({ id: g.id, name: `${g.name}!` })
    expect(renamedG.name).toBe(`${g.name}!`)
    await update({ id: bug.id, name: "Bug" })
    await update({ id: evo.id, sortOrder: -1 })
    const { groups } = await list()
    const mine = groups.find((x) => x.id === g.id)!
    expect(mine.name).toBe(`${g.name}!`)
    expect(mine.values.map((v) => v.name)).toEqual(["evolution", "Bug"])
  })

  it("includeArchived marks an archived value and a live value of an archived group", async () => {
    const { g, vs } = await seedGroup(["a1", "a2"])
    await archive(vs[0]!.id)
    expect((await list()).groups.find((x) => x.id === g.id)!.values.map((v) => v.id)).toEqual([
      vs[1]!.id,
    ])
    await archive(g.id)
    expect((await list()).groups.some((x) => x.id === g.id)).toBe(false)
    const all = (await list(true)).groups.find((x) => x.id === g.id)!
    expect(all.archivedAt).not.toBeNull()
    const [a1, a2] = all.values
    expect(a1).toMatchObject({ id: vs[0]!.id, archived: true })
    expect(a1!.archivedAt).not.toBeNull()
    expect(a2).toMatchObject({ id: vs[1]!.id, archived: true, archivedAt: null })
  })

  it("archiving a group stamps only the group; restore revives values not archived on their own", async () => {
    const { g, vs } = await seedGroup(["x", "y", "z"])
    await archive(vs[2]!.id)
    await archive(g.id)
    for (const v of vs.slice(0, 2)) expect((await storedRow(v.id)).archived_at).toBeNull()
    await archive(g.id, false)
    const live = (await list()).groups.find((x) => x.id === g.id)!
    expect(live.values.map((v) => v.name)).toEqual(["x", "y"])
  })
})

describe("labels taxonomy: names", () => {
  it("refuses duplicates (case and whitespace insensitive) with name_exists 400", async () => {
    const { g, vs } = await seedGroup(["bug", "evolution"])
    expect(await caught(() => create("  BUG ", g.id))).toEqual({ code: "name_exists", status: 400 })
    expect(await caught(() => update({ id: vs[1]!.id, name: "Bug" }))).toEqual({
      code: "name_exists",
      status: 400,
    })
    expect(await caught(() => create(g.name))).toEqual({ code: "name_exists", status: 400 })
    const other = await seedGroup([])
    expect((await create("bug", other.g.id)).name).toBe("bug")
  })

  it("refuses a restore into a live name clash", async () => {
    const { g, vs } = await seedGroup(["bug"])
    await archive(vs[0]!.id)
    await create("bug", g.id)
    expect(await caught(() => archive(vs[0]!.id, false))).toEqual({
      code: "name_exists",
      status: 400,
    })
  })

  it("keeps values of an archived group unique among their name-active siblings", async () => {
    const { g, vs } = await seedGroup(["v1", "v2"])
    await archive(g.id)
    expect(await caught(() => update({ id: vs[0]!.id, name: "v2" }))).toEqual({
      code: "name_exists",
      status: 400,
    })
    await archive(g.id, false)
    const names = (await list()).groups.find((x) => x.id === g.id)!.values.map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("refuses __NONE__, empty and 61-character names", async () => {
    for (const name of ["__NONE__", "   ", "x".repeat(61)]) {
      expect((await caught(() => create(name))).code).toBe("invalid_params")
    }
  })
})

describe("labels taxonomy: parents", () => {
  it("updateLabel with another parentId is refused and leaves the row", async () => {
    const { vs } = await seedGroup(["p1"])
    const other = await seedGroup([])
    expect((await caught(() => update({ id: vs[0]!.id, parentId: other.g.id }))).code).toBe(
      "invalid_params",
    )
    expect((await storedRow(vs[0]!.id)).parent_id).not.toBe(other.g.id)
  })

  it("createLabel refuses a value parent, an archived group and an unknown id", async () => {
    const { g, vs } = await seedGroup(["leaf"])
    const archivedGroup = await seedGroup([])
    await archive(archivedGroup.g.id)
    const before = await rowCount()
    expect((await caught(() => create("deep", vs[0]!.id))).code).toBe("invalid_params")
    expect((await caught(() => create("late", archivedGroup.g.id))).code).toBe("invalid_params")
    expect(await caught(() => create("ghost", crypto.randomUUID()))).toEqual({
      code: "not_found",
      status: 404,
    })
    expect(await rowCount()).toBe(before)
    // The live group still takes values.
    expect((await create("sibling", g.id)).parentId).toBe(g.id)
  })
})

describe("labels taxonomy: whole-tree save", () => {
  it("creates a new group with a new child under it", async () => {
    const v = await version()
    const out = await reorder(v, [
      { tempId: "g", parentId: null, name: uniq("Team"), sortOrder: 0 },
      { tempId: "c", parentTempId: "g", name: "core", sortOrder: 0 },
    ])
    expect((await storedRow(out.ids.c!)).parent_id).toBe(out.ids.g!)
  })

  it("refuses moves of stored nodes and writes nothing", async () => {
    const a = await seedGroup(["va"])
    const b = await seedGroup(["vb"])
    const cases = [
      { id: a.vs[0]!.id, parentId: b.g.id, name: "va", sortOrder: 0 },
      { id: a.vs[0]!.id, parentId: null, name: "va", sortOrder: 0 },
      { id: a.g.id, parentId: b.g.id, name: a.g.name, sortOrder: 0 },
    ]
    for (const node of cases) {
      const v = await version()
      const n = await rowCount()
      expect((await caught(() => reorder(v, [node]))).code).toBe("invalid_params")
      expect(await rowCount()).toBe(n)
      expect(await version()).toBe(v)
    }
  })

  it("refuses a new value under a group archived in the same save", async () => {
    const a = await seedGroup([])
    const v = await version()
    expect(
      (
        await caught(() =>
          reorder(v, [
            { id: a.g.id, parentId: null, name: a.g.name, sortOrder: 0, archived: true },
            { tempId: "n", parentId: a.g.id, name: "new", sortOrder: 0 },
          ]),
        )
      ).code,
    ).toBe("invalid_params")
  })

  it("refuses a new node under an existing value with a typed invalid_params", async () => {
    const a = await seedGroup(["leaf"])
    const v = await version()
    const n = await rowCount()
    expect(
      (
        await caught(() =>
          reorder(v, [{ tempId: "x", parentId: a.vs[0]!.id, name: "deep", sortOrder: 0 }]),
        )
      ).code,
    ).toBe("invalid_params")
    expect(await rowCount()).toBe(n)
  })

  it("lets a save swap two names but refuses a real duplicate with name_exists 400", async () => {
    const a = await seedGroup(["one", "two"])
    const [one, two] = a.vs
    const v = await version()
    await reorder(v, [
      { id: one!.id, parentId: a.g.id, name: "two", sortOrder: 0 },
      { id: two!.id, parentId: a.g.id, name: "one", sortOrder: 1 },
    ])
    expect((await storedRow(one!.id)).name).toBe("two")
    const v2 = await version()
    expect(
      await caught(() =>
        reorder(v2, [{ id: one!.id, parentId: a.g.id, name: "ONE", sortOrder: 0 }]),
      ),
    ).toEqual({ code: "name_exists", status: 400 })
  })

  it("refuses a stale baseVersion with conflict 409", async () => {
    const v = await version()
    await create(uniq("Bump"))
    expect(await caught(() => reorder(v, []))).toEqual({ code: "conflict", status: 409 })
  })

  it("an archived subtree stamps the group only", async () => {
    const a = await seedGroup(["s1", "s2"])
    const v = await version()
    await reorder(v, [
      { id: a.g.id, parentId: null, name: a.g.name, sortOrder: 0, archived: true },
      { id: a.vs[0]!.id, parentId: a.g.id, name: "s1", sortOrder: 0, archived: true },
      { id: a.vs[1]!.id, parentId: a.g.id, name: "s2", sortOrder: 1, archived: true },
    ])
    expect((await storedRow(a.g.id)).archived_at).not.toBeNull()
    for (const x of a.vs) expect((await storedRow(x.id)).archived_at).toBeNull()
  })
})

/**
 * Run `first` in its own transaction and keep that transaction open, start
 * `second` in another one, give it time to reach its checks, then commit
 * `first`. Without the per-org advisory lock, `second` checks a tree that does
 * not show `first`'s uncommitted write, and both succeed; with it, `second`
 * waits for `first` to commit and then sees its write.
 */
async function whileFirstHolds<A, B>(
  first: (tx: RlsClient) => Promise<A>,
  second: (tx: RlsClient) => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  let firstWrote!: () => void
  const wrote = new Promise<void>((r) => {
    firstWrote = r
  })
  const a = as(admin, async (tx) => {
    try {
      return await first(tx)
    } finally {
      firstWrote()
      await held
    }
  })
  await wrote
  const b = as(admin, second)
  await new Promise((r) => setTimeout(r, 300))
  release()
  return [...(await Promise.allSettled([a, b]))] as [
    PromiseSettledResult<A>,
    PromiseSettledResult<B>,
  ]
}

const reasonCode = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? (r.reason as { code?: string }).code : "fulfilled"

describe("labels taxonomy: concurrency (per-org advisory lock)", () => {
  it("two concurrent creates of one name: one succeeds, the other is name_exists", async () => {
    const { g } = await seedGroup([])
    const name = uniq("twin")
    const input = { name, parentId: g.id }
    const [a, b] = await whileFirstHolds(
      (tx) => createLabel({ tx, orgId, actor: admin, input }),
      (tx) => createLabel({ tx, orgId, actor: admin, input }),
    )
    expect(a.status).toBe("fulfilled")
    expect(reasonCode(b)).toBe("name_exists")
    const [r] = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.labels
        WHERE org_id = ${orgId}::uuid AND parent_id = ${g.id}::uuid AND lower(name) = lower(${name})
      `),
    )
    expect(r!.n).toBe(1)
  })

  it("two whole-tree saves from the same baseVersion: the second is a conflict", async () => {
    const base = await version()
    const save = (tag: string) => (tx: RlsClient) =>
      reorderLabels({
        tx,
        orgId,
        actor: admin,
        input: {
          baseVersion: base,
          nodes: [{ tempId: tag, parentId: null, name: uniq(tag), sortOrder: 0 }],
        },
      })
    const before = await rowCount()
    const [a, b] = await whileFirstHolds(save("first"), save("second"))
    expect(a.status).toBe("fulfilled")
    expect(reasonCode(b)).toBe("conflict")
    expect(await rowCount()).toBe(before + 1)
  })

  it("a rename racing a create of the same name: the second write is name_exists", async () => {
    const { g, vs } = await seedGroup(["alpha"])
    const name = uniq("taken")
    const [a, b] = await whileFirstHolds(
      (tx) => updateLabel({ tx, orgId, actor: admin, input: { id: vs[0]!.id, name } }),
      (tx) => createLabel({ tx, orgId, actor: admin, input: { name, parentId: g.id } }),
    )
    expect(a.status).toBe("fulfilled")
    expect(reasonCode(b)).toBe("name_exists")
  })

  it("a restore racing a create of the same name: the second write is name_exists", async () => {
    const { g, vs } = await seedGroup(["gamma"])
    await archive(vs[0]!.id)
    const [a, b] = await whileFirstHolds(
      (tx) => createLabel({ tx, orgId, actor: admin, input: { name: "gamma", parentId: g.id } }),
      (tx) => archiveLabel({ tx, orgId, actor: admin, input: { id: vs[0]!.id, archived: false } }),
    )
    expect(a.status).toBe("fulfilled")
    expect(reasonCode(b)).toBe("name_exists")
  })
})

describe("labels taxonomy: whole-tree save, remaining branches", () => {
  it("archives a lone value of a live group, stamping only that value", async () => {
    const a = await seedGroup(["keep", "drop"])
    const [keep, drop] = a.vs
    const v = await version()
    await reorder(v, [
      { id: a.g.id, parentId: null, name: a.g.name, sortOrder: 0 },
      { id: keep!.id, parentId: a.g.id, name: "keep", sortOrder: 0 },
      { id: drop!.id, parentId: a.g.id, name: "drop", sortOrder: 1, archived: true },
    ])
    expect((await storedRow(drop!.id)).archived_at).not.toBeNull()
    expect((await storedRow(keep!.id)).archived_at).toBeNull()
    expect((await storedRow(a.g.id)).archived_at).toBeNull()
  })

  it("refuses a new value under a group archived before the save", async () => {
    const a = await seedGroup([])
    await archive(a.g.id)
    const v = await version()
    const n = await rowCount()
    expect(
      await caught(() =>
        reorder(v, [{ tempId: "late", parentId: a.g.id, name: "late", sortOrder: 0 }]),
      ),
    ).toEqual({ code: "invalid_params", status: 400 })
    expect(await rowCount()).toBe(n)
  })

  it("refuses a new node named like a live sibling, or two new nodes with one name", async () => {
    const a = await seedGroup(["taken"])
    let v = await version()
    const n = await rowCount()
    expect(
      await caught(() =>
        reorder(v, [{ tempId: "dup", parentId: a.g.id, name: " TAKEN ", sortOrder: 1 }]),
      ),
    ).toEqual({ code: "name_exists", status: 400 })
    v = await version()
    expect(
      await caught(() =>
        reorder(v, [
          { tempId: "x", parentId: a.g.id, name: "fresh", sortOrder: 1 },
          { tempId: "y", parentId: a.g.id, name: "Fresh", sortOrder: 2 },
        ]),
      ),
    ).toEqual({ code: "name_exists", status: 400 })
    expect(await rowCount()).toBe(n)
  })

  it("refuses an unknown id with not_found and writes nothing", async () => {
    const v = await version()
    const n = await rowCount()
    expect(
      await caught(() =>
        reorder(v, [{ id: crypto.randomUUID(), parentId: null, name: "ghost", sortOrder: 0 }]),
      ),
    ).toEqual({ code: "not_found", status: 404 })
    expect(await rowCount()).toBe(n)
    expect(await version()).toBe(v)
  })

  it("refuses to restore a group whose name a live group took meanwhile", async () => {
    const a = await seedGroup([])
    await archive(a.g.id)
    await create(a.g.name)
    expect(await caught(() => archive(a.g.id, false))).toEqual({
      code: "name_exists",
      status: 400,
    })
    expect((await storedRow(a.g.id)).archived_at).not.toBeNull()
  })
})

describe("labels taxonomy: version, scope, events, tree", () => {
  it("moves the version on every write kind, even two writes in one transaction", async () => {
    const a = await seedGroup(["k"])
    const steps: Array<() => Promise<unknown>> = [
      () => create(uniq("V")),
      () => update({ id: a.vs[0]!.id, name: uniq("k") }),
      () => archive(a.vs[0]!.id),
      () => archive(a.vs[0]!.id, false),
      async () =>
        reorder(await version(), [{ tempId: "t", parentId: null, name: uniq("R"), sortOrder: 0 }]),
    ]
    for (const step of steps) {
      const before = await version()
      await step()
      expect(await version()).not.toBe(before)
    }
    const before = await version()
    const mid = await as(admin, async (tx) => {
      await updateLabel({ tx, orgId, actor: admin, input: { id: a.g.id, sortOrder: 50 } })
      const v1 = await labelsVersion(tx, orgId)
      await updateLabel({ tx, orgId, actor: admin, input: { id: a.g.id, sortOrder: 51 } })
      return { v1, v2: await labelsVersion(tx, orgId) }
    })
    expect(mid.v1).not.toBe(before)
    expect(mid.v2).not.toBe(mid.v1)
  })

  it("refuses every write without projects:labels:admin; reads need only projects:projects:read", async () => {
    const a = await seedGroup(["m"])
    const writes: Array<(tx: RlsClient) => Promise<unknown>> = [
      (tx) => createLabel({ tx, orgId, actor: member, input: { name: uniq("no") } }),
      (tx) => updateLabel({ tx, orgId, actor: member, input: { id: a.g.id, name: uniq("no") } }),
      (tx) => archiveLabel({ tx, orgId, actor: member, input: { id: a.g.id } }),
      async (tx) =>
        reorderLabels({
          tx,
          orgId,
          actor: member,
          input: { baseVersion: await labelsVersion(tx, orgId), nodes: [] },
        }),
    ]
    for (const w of writes) {
      expect(await caught(() => as(member, w))).toEqual({ code: "forbidden", status: 403 })
    }
    const reader = { ...member, scopes: ["projects:projects:read"] }
    const groups = await as(reader, (tx) => listLabels({ tx, orgId }))
    expect(groups.groups.some((x) => x.id === a.g.id)).toBe(true)
  })

  it("queues exactly one past-tense label event per write", async () => {
    const a = await seedGroup(["e"])
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["created", () => create(uniq("E"))],
      ["updated", () => update({ id: a.vs[0]!.id, name: uniq("e") })],
      ["archived", () => archive(a.vs[0]!.id)],
      ["restored", () => archive(a.vs[0]!.id, false)],
      ["reordered", async () => reorder(await version(), [])],
    ]
    for (const [action, run] of cases) {
      const seq = await maxSeq()
      await run()
      const events = await labelEvents(seq)
      expect(events.map((e) => e.action)).toEqual([action])
    }
  })

  it("labelsTree returns live groups and their live values only", async () => {
    const A = await seedGroup(["a1", "a2"])
    const B = await seedGroup(["b1", "b2"])
    await archive(A.g.id)
    await archive(B.vs[1]!.id)
    const { rows } = await tree()
    const ids = new Set(rows.map((r) => r.id))
    const mine = [A.g.id, ...A.vs.map((v) => v.id), B.g.id, ...B.vs.map((v) => v.id)].filter((id) =>
      ids.has(id),
    )
    expect(mine.sort()).toEqual([B.g.id, B.vs[0]!.id].sort())
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["id", "name", "parentId", "sortOrder", "updatedAt"])
    }
  })

  it("round-trips the version with the settings block's sequence", async () => {
    const t = await tree()
    expect(t.version).toBe(await version())
    const r1 = await reorder(t.version, [
      { tempId: "a", parentId: null, name: uniq("T1"), sortOrder: 0 },
    ])
    expect(r1.version).toBe((await tree()).version)
    const r2 = await reorder(r1.version, [
      { tempId: "b", parentId: null, name: uniq("T2"), sortOrder: 1 },
    ])
    expect(r2.version).toBe(await version())
    expect(await caught(() => reorder(t.version, []))).toEqual({ code: "conflict", status: 409 })
  })
})
