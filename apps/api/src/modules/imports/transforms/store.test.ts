// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { TransformSourceError } from "./source"
import {
  getTransform,
  listTransforms,
  resolvePinnedTransform,
  saveTransform,
  TransformStoreError,
} from "./store"

let orgId: string
let otherOrgId: string
let userId: string

const V1 = `function transform(batch, ctx) { return { state: { v: 1 } } }`
const V2 = `function transform(batch, ctx) { return { state: { v: 2 } } }`

const priv = <T>(org: string, fn: Parameters<typeof withPrivilegedDb<T>>[2]) =>
  withPrivilegedDb(org, "test:import-transforms", fn)

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err) {
    if (err instanceof Error) return err
    throw err
  }
  throw new Error("expected an error")
}

beforeAll(async () => {
  await acquireTestLock()
  const stamp = Date.now()
  const orgs = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES
        (gen_random_uuid(), 'Transforms Org', ${`transforms-${stamp}`}),
        (gen_random_uuid(), 'Other Transforms Org', ${`transforms-other-${stamp}`})
      RETURNING id
    `),
  )
  orgId = orgs[0]!.id
  otherOrgId = orgs[1]!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`author-${stamp}@example.test`}, 'Author', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("import transform store", () => {
  it("a save creates version n+1; a run's pin keeps resolving to its version", async () => {
    const base = {
      orgId,
      name: "helpdesk-csv",
      kinds: ["tickets.ticket"],
      sourceType: "upload" as const,
      createdBy: userId,
    }
    const v1 = await priv(orgId, (tx) => saveTransform(tx, { ...base, source: V1 }))
    expect(v1).toMatchObject({ name: "helpdesk-csv", version: 1 })
    const v2 = await priv(orgId, (tx) => saveTransform(tx, { ...base, source: V2 }))
    expect(v2.version).toBe(2)
    expect(v2.id).not.toBe(v1.id)

    const latest = await priv(orgId, (tx) => getTransform(tx, orgId, "helpdesk-csv"))
    expect(latest).toMatchObject({ version: 2, source: V2 })
    const first = await priv(orgId, (tx) => getTransform(tx, orgId, "helpdesk-csv", 1))
    expect(first.source).toBe(V1)

    const pinned = await priv(orgId, (tx) =>
      resolvePinnedTransform(tx, orgId, { transformId: v1.id, version: 1 }),
    )
    expect(pinned.source).toBe(V1)
    const moved = await errorOf(
      priv(orgId, (tx) => resolvePinnedTransform(tx, orgId, { transformId: v1.id, version: 2 })),
    )
    expect((moved as TransformStoreError).code).toBe("transform_version_mismatch")

    const listed = await priv(orgId, (tx) => listTransforms(tx, orgId))
    expect(listed.map((t) => [t.name, t.version])).toEqual([["helpdesk-csv", 2]])
  })

  it("concurrent saves of one name get distinct versions", async () => {
    const base = {
      orgId,
      name: "race",
      kinds: ["projects.issue"],
      sourceType: "upload" as const,
      source: V1,
    }
    const refs = await Promise.all(
      Array.from({ length: 4 }, () => priv(orgId, (tx) => saveTransform(tx, base))),
    )
    expect(refs.map((r) => r.version).sort()).toEqual([1, 2, 3, 4])
  })

  it("another org sees none of it", async () => {
    const err = await errorOf(
      priv(otherOrgId, (tx) => getTransform(tx, otherOrgId, "helpdesk-csv")),
    )
    expect((err as TransformStoreError).code).toBe("transform_not_found")
    const pin = await priv(orgId, (tx) => getTransform(tx, orgId, "helpdesk-csv", 1))
    const cross = await errorOf(
      priv(otherOrgId, (tx) =>
        resolvePinnedTransform(tx, otherOrgId, { transformId: pin.id, version: 1 }),
      ),
    )
    expect((cross as TransformStoreError).code).toBe("transform_not_found")
  })

  it("is not readable through the RLS role at all", async () => {
    const rows = await withRlsContext(
      { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
      (tx) => tx.execute(drizzleSql`SELECT id FROM kernel.import_transforms`),
    )
    expect(extractRows(rows)).toEqual([])
  })

  it("a saved version can never be changed, even through the privileged connection", async () => {
    const ref = await priv(orgId, (tx) =>
      saveTransform(tx, {
        orgId,
        name: "frozen",
        kinds: ["tickets.ticket"],
        sourceType: "upload",
        source: V1,
        createdBy: userId,
      }),
    )
    for (const change of [
      drizzleSql`UPDATE kernel.import_transforms SET source = ${V2} WHERE id = ${ref.id}::uuid`,
      drizzleSql`UPDATE kernel.import_transforms SET version = 9 WHERE id = ${ref.id}::uuid`,
      drizzleSql`UPDATE kernel.import_transforms SET kinds = '{projects.issue}' WHERE id = ${ref.id}::uuid`,
    ]) {
      expect(await errorOf(priv(orgId, (tx) => tx.execute(change)))).toBeInstanceOf(Error)
    }
    // Losing its author (a user deleted) is the one change allowed.
    await priv(orgId, (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.import_transforms SET created_by = NULL WHERE id = ${ref.id}::uuid`,
      ),
    )
    const after = await priv(orgId, (tx) => getTransform(tx, orgId, "frozen"))
    expect(after).toMatchObject({ source: V1, version: 1, createdBy: null })
  })

  it("validates name, kinds, connection and source", async () => {
    const ok = {
      orgId,
      name: "x",
      kinds: ["tickets.ticket"],
      sourceType: "upload" as const,
      source: V1,
    }
    for (const bad of [
      { ...ok, name: "Has Spaces" },
      { ...ok, kinds: [] },
      { ...ok, kinds: ["notakind"] },
      { ...ok, connectionIdentifier: "crm" },
      {
        ...ok,
        sourceType: "api" as const,
        source: "async function pull(p, ctx) { return { nextCursor: null } }",
      },
    ]) {
      expect(await errorOf(priv(orgId, (tx) => saveTransform(tx, bad)))).toBeInstanceOf(
        TransformStoreError,
      )
    }
    expect(
      await errorOf(
        priv(orgId, (tx) => saveTransform(tx, { ...ok, source: "export function transform() {}" })),
      ),
    ).toBeInstanceOf(TransformSourceError)
    const api = await priv(orgId, (tx) =>
      saveTransform(tx, {
        ...ok,
        name: "crm-pull",
        sourceType: "api",
        connectionIdentifier: "crm",
        source: "async function pull(page, ctx) { return { nextCursor: null } }",
      }),
    )
    expect(api.version).toBe(1)
  })
})
