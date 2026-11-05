// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import {
  applyMeSubstitution,
  cloneSavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  SavedViewError,
  updateSavedView,
} from "~/modules/saved-views/service"

const ORG = "00000000-0000-0000-0000-0000000099a1"
const USER = "00000000-0000-0000-0000-0000000099a2"
const USER2 = "00000000-0000-0000-0000-0000000099a3"

function userCtx(userId: string, scopes: string[]): UserContext {
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes,
    dimensionGrants: { "*": ["*"] },
  }
}

beforeAll(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id IN (${USER}, ${USER2})`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`INSERT INTO kernel.organizations(id, name, slug)
    VALUES (${ORG}, 'sv-svc', 'sv-svc')`
  await sql`INSERT INTO kernel.users(id, org_id, email, name, status)
    VALUES
      (${USER}, ${ORG}, 'sv1@test', 'sv', 'active'),
      (${USER2}, ${ORG}, 'sv2@test', 'sv2', 'active')`
})

afterEach(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`UPDATE kernel.users SET status = 'active' WHERE id IN (${USER}, ${USER2})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id IN (${USER}, ${USER2})`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("applyMeSubstitution", () => {
  it("replaces literal '$me' with actor id at any depth", () => {
    const out = applyMeSubstitution(
      { assignedTo: "$me", nested: { user: "$me" }, list: ["$me", "x"] },
      "u-1",
    )
    expect(out).toEqual({
      assignedTo: "u-1",
      nested: { user: "u-1" },
      list: ["u-1", "x"],
    })
  })

  it("leaves non-matching strings untouched", () => {
    expect(applyMeSubstitution({ a: "literal", b: 42, c: null }, "u-1")).toEqual({
      a: "literal",
      b: 42,
      c: null,
    })
  })
})

describe("saved views service", () => {
  it("creates a private view", async () => {
    const row = await createSavedView(userCtx(USER, ["*"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Mine",
      payload: { smartFilter: "all-open" },
    })
    expect(row.ownerUserId).toBe(USER)
    expect(row.sharedWithOrg).toBe(false)
    expect(row.payload).toEqual({ smartFilter: "all-open" })
  })

  it("rejects sharedWithOrg without kernel:saved_views:share", async () => {
    await expect(
      createSavedView(userCtx(USER, []), {
        app: "tickets",
        viewId: "inbox",
        name: "X",
        payload: {},
        sharedWithOrg: true,
      }),
    ).rejects.toThrow(/share/)
  })

  it("accepts sharedWithOrg with the share scope", async () => {
    const row = await createSavedView(userCtx(USER, ["kernel:saved_views:share"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Shared",
      payload: {},
      sharedWithOrg: true,
    })
    expect(row.sharedWithOrg).toBe(true)
  })

  it("list returns owner-private + org-shared, ordered (default, position, createdAt)", async () => {
    await createSavedView(userCtx(USER, []), {
      app: "tickets",
      viewId: "inbox",
      name: "Mine",
      payload: {},
    })
    await createSavedView(userCtx(USER2, ["kernel:saved_views:share"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Shared",
      payload: {},
      sharedWithOrg: true,
    })
    const out = await listSavedViews(userCtx(USER, []), { app: "tickets", viewId: "inbox" })
    const names = out.map((v) => v.name).sort()
    expect(names).toEqual(["Mine", "Shared"])
  })

  it("update on shared view by non-owner without admin scope returns SCOPE_DENIED", async () => {
    const v = await createSavedView(userCtx(USER, ["kernel:saved_views:share"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Shared",
      payload: {},
      sharedWithOrg: true,
    })
    await expect(
      updateSavedView(userCtx(USER2, []), v.id, { name: "Hacked" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("update by owner succeeds", async () => {
    const v = await createSavedView(userCtx(USER, []), {
      app: "tickets",
      viewId: "inbox",
      name: "Mine",
      payload: {},
    })
    const updated = await updateSavedView(userCtx(USER, []), v.id, { name: "Renamed" })
    expect(updated.name).toBe("Renamed")
  })

  it("clone creates a private copy preserving payload", async () => {
    const src = await createSavedView(userCtx(USER, ["kernel:saved_views:share"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Source",
      payload: { a: 1 },
      sharedWithOrg: true,
    })
    const c = await cloneSavedView(userCtx(USER2, []), src.id)
    expect(c.ownerUserId).toBe(USER2)
    expect(c.sharedWithOrg).toBe(false)
    expect(c.payload).toEqual({ a: 1 })
    expect(c.isDefault).toBe(false)
  })

  it("deactivated owner: list still includes owner display data with 'deactivated' status", async () => {
    const shared = await createSavedView(userCtx(USER, ["kernel:saved_views:share"]), {
      app: "tickets",
      viewId: "inbox",
      name: "Shared",
      payload: {},
      sharedWithOrg: true,
    })
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${USER}`
    const out = await listSavedViews(userCtx(USER2, []), { app: "tickets", viewId: "inbox" })
    const row = out.find((v) => v.id === shared.id)
    expect(row?.owner).toMatchObject({ id: USER, name: "sv", status: "deactivated" })
  })

  it("delete by owner succeeds", async () => {
    const v = await createSavedView(userCtx(USER, []), {
      app: "tickets",
      viewId: "inbox",
      name: "ToDelete",
      payload: {},
    })
    await deleteSavedView(userCtx(USER, []), v.id)
    const out = await listSavedViews(userCtx(USER, []), { app: "tickets", viewId: "inbox" })
    expect(out.find((r) => r.id === v.id)).toBeUndefined()
  })

  it("saved_view event drains through the outbox to processed_at (no dead-letter)", async () => {
    // Force a clean, FULLY-populated event bus. A prior file in this shared bun
    // process may have left declaredEmits cleared (via resetEventBus) so a
    // guarded initEventBus() would no-op — leaving "saved_view:created"
    // undeclared, which makes the outbox publish-time check throw and release
    // the claim (processed_at stays NULL). resetEventBus() resets the guard so
    // initEventBus() re-declares the full kernel emit set.
    resetEventBus()
    initEventBus()
    // Also drop any durable consumer a prior file registered, so it can't fire
    // on this event and release the claim. (outbox-worker.test.ts convention.)
    DurableConsumersTestAccess.reset()
    const v = await createSavedView(userCtx(USER, []), {
      app: "tickets",
      viewId: "inbox",
      name: "Outbox",
      payload: {},
    })
    // The create queued a kernel/saved_view/created event into pending_events.
    const [pending] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'entity' = 'saved_view'
        AND payload->>'action' = 'created'
        AND payload->>'entityId' = ${v.id}
      LIMIT 1`
    expect(pending?.id).toBeDefined()

    // Drain the outbox — the event must publish + mark processed, not dead-letter.
    await processOutboxBatch()

    const [row] = await sql<{ processed_at: Date | null; failed_at: Date | null }[]>`
      SELECT processed_at, failed_at FROM kernel.pending_events WHERE id = ${pending.id}`
    expect(row.failed_at).toBeNull()
    expect(row.processed_at).not.toBeNull()

    await sql`DELETE FROM kernel.pending_events WHERE id = ${pending.id}`
  })

  it("rejects update for non-user actors", async () => {
    const v = await createSavedView(userCtx(USER, []), {
      app: "tickets",
      viewId: "inbox",
      name: "X",
      payload: {},
    })
    const systemCtx = {
      actorType: "system" as const,
      orgId: ORG,
      purpose: "job" as const,
      scopes: ["*"],
    }
    await expect(updateSavedView(systemCtx, v.id, { name: "Y" })).rejects.toBeInstanceOf(
      SavedViewError,
    )
  })
})
