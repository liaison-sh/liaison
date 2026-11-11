// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 3 on real Postgres: a person's edits (no approval, their scopes decide), the version
// history kept on every save (the last 20, readable with the dashboard), revert as a new
// version, a duplicate as the caller's own personal dashboard, today in the org's zone, and
// the filter options search.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { UserContext } from "~/db/rls"
import {
  createDashboard,
  duplicateDashboard,
  editDashboard,
  getDashboard,
  getFilterOptions,
  getVersion,
  KEPT_VERSIONS,
  listDashboards,
  listVersions,
  updateDashboard,
} from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const WRITE = "kernel:dashboards:write"
const SHARE = "kernel:dashboards:share"
const ADMIN = "kernel:dashboards:admin"

let orgId = ""
let owner = ""
let other = ""

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

const note = (id: string, text = `Note ${id}`) => ({ id, type: "text", title: id, text })
const spec = (...blocks: unknown[]) => ({ v: 1, blocks })

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Step3 Org" })).orgId
  owner = (await minimal.person(orgId, { name: "Ines Owner" })).id
  other = (await minimal.person(orgId)).id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("a person's edits and the version history", () => {
  it("applies operations without approval, keeps every version, and reverts as a new one", async () => {
    const me = as(owner, [WRITE, SHARE])
    const d = await createDashboard(me, {
      title: "Ops",
      visibility: "org",
      spec: spec(note("a"), note("b")),
    })
    const v2 = await editDashboard(me, d.id, {
      ifVersion: 1,
      operations: [
        { op: "resizeBlock", blockId: "a", width: 2, height: 2 },
        { op: "duplicateBlock", blockId: "b" },
        { op: "setDescription", description: "Daily view" },
        { op: "updateBlock", blockId: "a", changes: { title: "Renamed" } },
      ],
    })
    expect(v2.version).toBe(2)
    expect(v2.spec.blocks.map((b) => b.id)).toEqual(["a", "b", "b-copy"])
    expect(v2.spec.blocks[0]).toMatchObject({ title: "Renamed", width: 2, height: 2 })
    expect(v2.spec.description).toBe("Daily view")

    const history = await listVersions(me, d.id)
    expect(history.map((v) => [v.version, v.current, v.blockCount])).toEqual([
      [2, true, 3],
      [1, false, 2],
    ])
    expect(history[0]!.savedByName).toBe("Ines Owner")

    // Another member reads the org dashboard's history; they cannot edit it.
    expect((await listVersions(as(other, []), d.id)).length).toBe(2)
    await expect(
      editDashboard(as(other, [WRITE]), d.id, {
        ifVersion: 2,
        operations: [{ op: "setTitle", title: "x" }],
      }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })

    const v3 = await editDashboard(me, d.id, {
      ifVersion: 2,
      operations: [{ op: "revert", toVersion: 1 }],
    })
    expect(v3.version).toBe(3)
    expect(v3.spec.blocks.map((b) => b.id)).toEqual(["a", "b"])
    expect(v3.spec.description).toBeUndefined()
    expect((await getVersion(me, d.id, 2)).spec.description).toBe("Daily view")
    await expect(
      editDashboard(me, d.id, { ifVersion: 2, operations: [{ op: "revert", toVersion: 1 }] }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" })
    await expect(
      editDashboard(me, d.id, { ifVersion: 3, operations: [{ op: "revert", toVersion: 99 }] }),
    ).rejects.toMatchObject({ code: "INVALID_SPEC" })
  })

  it("keeps only the last versions, and a personal dashboard's history stays its owner's", async () => {
    const me = as(owner, [WRITE])
    const d = await createDashboard(me, { title: "Mine", visibility: "personal", spec: spec() })
    let version = 1
    for (let i = 0; i < KEPT_VERSIONS + 2; i++) {
      version = (await updateDashboard(me, d.id, { title: `Mine ${i}`, ifVersion: version }))
        .version
    }
    const history = await listVersions(me, d.id)
    expect(history.length).toBe(KEPT_VERSIONS)
    expect(history[0]!.version).toBe(version)
    expect(history.at(-1)!.version).toBe(version - KEPT_VERSIONS + 1)
    await expect(listVersions(as(other, [ADMIN]), d.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("duplicates a dashboard as the caller's own personal one", async () => {
    const d = await createDashboard(as(owner, [WRITE, SHARE]), {
      title: "Team",
      visibility: "org",
      spec: { ...spec(note("x")), description: "Shared" },
    })
    await expect(duplicateDashboard(as(other, []), d.id)).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    })
    const copy = await duplicateDashboard(as(other, [WRITE]), d.id)
    expect(copy).toMatchObject({
      title: "Team (copy)",
      visibility: "personal",
      ownerUserId: other,
      version: 1,
    })
    const listed = (await listDashboards(as(other, [WRITE]))).find((x) => x.id === copy.id)
    expect(listed?.description).toBe("Shared")
  })

  it("sends today and the zone the presets resolve in", async () => {
    const d = await createDashboard(as(owner, [WRITE]), {
      title: "Today",
      visibility: "personal",
      spec: spec(),
    })
    const view = await getDashboard(
      as(owner, [WRITE]),
      d.id,
      undefined,
      new Date("2026-11-11T23:30:00Z"),
    )
    expect(view.timeZone).toBeString()
    expect(view.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    if (view.timeZone === "UTC") expect(view.today).toBe("2026-11-11")
  })
})

describe("filter options search", () => {
  it("q keeps the options that contain it, case-insensitive", async () => {
    const d = await createDashboard(as(owner, [WRITE]), {
      title: "Filters",
      visibility: "personal",
      spec: {
        v: 1,
        filters: [
          {
            id: "market",
            label: "Market",
            type: "select",
            options: ["France", "Spain", "UK", "Japan"],
          },
        ],
        blocks: [],
      },
    })
    const out = await getFilterOptions(as(owner, [WRITE]), d.id, "market", { q: "AN" })
    expect(out).toMatchObject({ ok: true, options: ["France", "Japan"], truncated: false })
  })
})
