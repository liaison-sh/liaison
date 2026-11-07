// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.dashboards (migration 0275) on real Postgres: personal dashboards are
// their owner's alone, org ones the org's; only an owner holding
// kernel:dashboards:share (or :admin) makes or keeps one org-visible, and
// kernel:dashboards:admin manages any org dashboard; a personal dashboard
// never lacks an owner. Erasing a person deletes their personal dashboards,
// keeps their org ones ownerless, and drops their name from authored rows
// (dashboards and app store documents).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { appDocuments, dashboards } from "~/db/schema/kernel"
import { setDocument } from "~/modules/data-store/service"
import { eraseUser } from "~/modules/erasure/erase-user"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let owner = ""
let other = ""

function as<T>(userId: string, scopes: string[], fn: (tx: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext({ actorType: "user", userId, orgId, scopes, dimensionGrants: {} }, fn)
}

const SPEC = { v: 1, layout: "grid", blocks: [] }

function insert(
  userId: string,
  scopes: string[],
  row: { title: string; visibility: "personal" | "org"; ownerUserId: string | null },
) {
  return as(userId, scopes, async (tx) => {
    const [r] = await tx
      .insert(dashboards)
      .values({ orgId, spec: SPEC, createdBy: userId, updatedBy: userId, ...row })
      .returning({ id: dashboards.id })
    return r!.id
  })
}

const visibleTo = (userId: string, scopes: string[] = []) =>
  as(userId, scopes, (tx) => tx.select({ id: dashboards.id }).from(dashboards)).then((rows) =>
    rows.map((r) => r.id),
  )

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Dashboards Org" })
  orgId = org.orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("kernel.dashboards visibility", () => {
  it("a personal dashboard is its owner's alone; an org one is the org's", async () => {
    const personal = await insert(owner, ["kernel:dashboards:write"], {
      title: "Mine",
      visibility: "personal",
      ownerUserId: owner,
    })
    const shared = await insert(owner, ["kernel:dashboards:share"], {
      title: "Ours",
      visibility: "org",
      ownerUserId: owner,
    })
    expect(await visibleTo(owner)).toEqual(expect.arrayContaining([personal, shared]))
    const seen = await visibleTo(other)
    expect(seen).toContain(shared)
    expect(seen).not.toContain(personal)
    // Even kernel:dashboards:admin never reads someone's personal dashboard.
    expect(await visibleTo(other, ["kernel:dashboards:admin"])).not.toContain(personal)
  })

  it("an org dashboard needs kernel:dashboards:share or :admin", async () => {
    await expect(
      insert(owner, ["kernel:dashboards:write"], {
        title: "No share",
        visibility: "org",
        ownerUserId: owner,
      }),
    ).rejects.toThrow()
    const id = await insert(owner, ["kernel:dashboards:write"], {
      title: "Personal first",
      visibility: "personal",
      ownerUserId: owner,
    })
    const switched = await as(owner, ["kernel:dashboards:write"], (tx) =>
      tx.update(dashboards).set({ visibility: "org" }).where(eq(dashboards.id, id)).returning(),
    ).catch(() => "refused")
    expect(switched).toBe("refused")
  })

  it("nobody but the owner writes a dashboard, except an admin on an org one", async () => {
    const shared = await insert(owner, ["kernel:dashboards:share"], {
      title: "Team",
      visibility: "org",
      ownerUserId: owner,
    })
    const byOther = await as(other, ["kernel:dashboards:share"], (tx) =>
      tx.update(dashboards).set({ title: "Hijacked" }).where(eq(dashboards.id, shared)).returning(),
    )
    expect(byOther).toHaveLength(0)
    const byAdmin = await as(other, ["kernel:dashboards:admin"], (tx) =>
      tx.update(dashboards).set({ title: "Renamed" }).where(eq(dashboards.id, shared)).returning(),
    )
    expect(byAdmin.map((r) => r.title)).toEqual(["Renamed"])
    // Nobody makes a dashboard in someone else's name without :admin.
    await expect(
      insert(other, ["kernel:dashboards:share"], {
        title: "Forged",
        visibility: "personal",
        ownerUserId: owner,
      }),
    ).rejects.toThrow()
  })

  it("a personal dashboard always has an owner", async () => {
    await expect(
      insert(owner, ["*"], { title: "Orphan", visibility: "personal", ownerUserId: null }),
    ).rejects.toThrow()
    const ownerless = await insert(owner, ["kernel:dashboards:admin"], {
      title: "Org, ownerless",
      visibility: "org",
      ownerUserId: null,
    })
    expect(await visibleTo(other)).toContain(ownerless)
  })
})

describe("erasure", () => {
  it("deletes personal dashboards, keeps org ones ownerless, and drops author links", async () => {
    const leaver = (await minimal.person(orgId)).id
    const personal = await insert(leaver, ["kernel:dashboards:write"], {
      title: "Leaver's",
      visibility: "personal",
      ownerUserId: leaver,
    })
    const shared = await insert(leaver, ["kernel:dashboards:share"], {
      title: "Leaver's team board",
      visibility: "org",
      ownerUserId: leaver,
    })
    await as(leaver, ["*"], (tx) =>
      setDocument(tx, { orgId, app: "agent", userId: leaver }, "notes", "n1", { title: "x" }),
    )

    expect((await eraseUser(leaver)).exitCode).toBe(0)

    const rows = await withPrivilegedDb(orgId, "dashboards-erasure-check", async (tx) => ({
      boards: await tx
        .select({
          id: dashboards.id,
          owner: dashboards.ownerUserId,
          createdBy: dashboards.createdBy,
          updatedBy: dashboards.updatedBy,
        })
        .from(dashboards)
        .where(eq(dashboards.orgId, orgId)),
      docs: await tx
        .select({ createdBy: appDocuments.createdBy, updatedBy: appDocuments.updatedBy })
        .from(appDocuments)
        .where(eq(appDocuments.orgId, orgId)),
    }))
    const ids = rows.boards.map((b) => b.id)
    expect(ids).not.toContain(personal)
    expect(rows.boards.find((b) => b.id === shared)).toEqual({
      id: shared,
      owner: null,
      createdBy: null,
      updatedBy: null,
    })
    expect(rows.docs).toEqual([{ createdBy: null, updatedBy: null }])
  })
})
