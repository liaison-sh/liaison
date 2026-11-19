// SPDX-License-Identifier: FSL-1.1-ALv2
// The demo decide: a fictional client's stand-in decision, in a visitor demo
// workspace on a demo box only. It refuses any other workspace (the reserved
// review workspace included) and any other box, a row about another target than
// the one its caller names, an action already decided, and a document whose
// fingerprint moved. When it decides, the row reads as a link decision with the
// invited name, its event is the system's and says demo, and the decided event
// is queued once.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { markOrgAsDemo, reservedMarker, visitorMarker } from "~/modules/demo/demo-org"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"
import { decideDemoClientAction } from "./demo-decide"
import { mintClientAction } from "./mint"

const kit = useClientActionWorld("demodecide", "contract")
const TARGET = { app: "demodecide", type: "contract" }

async function mint(): Promise<string> {
  const r = await mintClientAction({
    orgId: kit.w.orgId,
    kind: "accept",
    targetApp: kit.targetApp,
    targetType: kit.targetType,
    targetId: crypto.randomUUID(),
    contactId: kit.w.clientA.contactId,
    companyId: kit.w.companyA,
    invitedEmail: kit.w.clientA.email,
    expiresInDays: 7,
    createdByUserId: kit.w.admin.userId,
  })
  return r.id
}

async function rowOf(id: string) {
  const [row] = await sql`SELECT decided_at, decision, decided_via, typed_name, capacity,
      code_verified_at FROM ${k("client_actions")} WHERE id = ${id}`
  return row
}

async function decidedEvents(id: string) {
  return sql`SELECT payload FROM kernel.pending_events
    WHERE org_id = ${kit.w.orgId} AND payload->>'entity' = 'client_action'
      AND payload->>'action' = 'decided' AND payload->>'entityId' = ${id}`
}

beforeAll(async () => {
  await markOrgAsDemo(kit.w.orgId, visitorMarker(24))
  DemoModeTestAccess.set(true)
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the demo decide", () => {
  it("records a stand-in decision as a link decision, its event the system's, and queues the decided event once", async () => {
    const id = await mint()
    const out = await decideDemoClientAction({ orgId: kit.w.orgId, actionId: id, target: TARGET })
    expect(out).toEqual({ ok: true, actionId: id, decision: "accepted" })
    const row = await rowOf(id)
    expect(row?.decision).toBe("accepted")
    expect(row?.decided_via).toBe("link")
    expect(row?.typed_name).toBe(kit.w.clientA.name)
    expect(row?.capacity).toBeNull()
    expect(row?.code_verified_at).toBeNull()
    const [event] = await sql`SELECT actor_kind, meta FROM ${k("client_action_events")}
      WHERE action_id = ${id} AND event = 'decided'`
    expect(event?.actor_kind).toBe("system")
    expect(event?.meta).toMatchObject({ demo: true, decision: "accepted" })
    const queued = await decidedEvents(id)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.payload.data).toMatchObject({
      id,
      decision: "accepted",
      decided_via: "link",
      target: { app: TARGET.app, type: TARGET.type },
    })
  })

  it("writes the caller's stand-in record once, in the decision's transaction, only when it decides", async () => {
    const id = await mint()
    const seen: string[] = []
    const out = await decideDemoClientAction({
      orgId: kit.w.orgId,
      actionId: id,
      target: TARGET,
      standIn: async (tx) => {
        // Inside the decision's transaction: the row is already decided there.
        const [row] = extractRows<{ decided: boolean }>(
          await tx.execute(
            dsql`SELECT (decided_at IS NOT NULL) AS decided FROM kernel.client_actions WHERE id = ${id}`,
          ),
        )
        seen.push(row?.decided ? "decided" : "open")
      },
    })
    expect(out.ok).toBe(true)
    expect(seen).toEqual(["decided"])
    // Refused (decided already, a box that is no demo): the stand-in writer never runs.
    const again = await decideDemoClientAction({
      orgId: kit.w.orgId,
      actionId: id,
      target: TARGET,
      standIn: async () => {
        seen.push("again")
      },
    })
    expect(again).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_OPEN" })
    const other = await mint()
    DemoModeTestAccess.set(false)
    try {
      const off = await decideDemoClientAction({
        orgId: kit.w.orgId,
        actionId: other,
        target: TARGET,
        standIn: async () => {
          seen.push("off")
        },
      })
      expect(off).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_DEMO_BOX" })
    } finally {
      DemoModeTestAccess.set(true)
    }
    expect(seen).toEqual(["decided"])
  })

  it("a stand-in record that fails leaves the action undecided, with no decided event", async () => {
    const id = await mint()
    await expect(
      decideDemoClientAction({
        orgId: kit.w.orgId,
        actionId: id,
        target: TARGET,
        standIn: async () => {
          throw new Error("the stand-in record could not be written")
        },
      }),
    ).rejects.toThrow("the stand-in record could not be written")
    expect((await rowOf(id))?.decided_at).toBeNull()
    expect(await decidedEvents(id)).toHaveLength(0)
  })

  it("refuses an action already decided", async () => {
    const id = await mint()
    expect(
      (await decideDemoClientAction({ orgId: kit.w.orgId, actionId: id, target: TARGET })).ok,
    ).toBe(true)
    const again = await decideDemoClientAction({ orgId: kit.w.orgId, actionId: id, target: TARGET })
    expect(again).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_OPEN" })
    expect(await decidedEvents(id)).toHaveLength(1)
  })

  it("refuses an organisation that is not a demo", async () => {
    const id = await mint()
    // The action exists, but in another workspace than the one asked: and that one is no demo.
    const out = await decideDemoClientAction({
      orgId: kit.w.otherOrgId,
      actionId: id,
      target: TARGET,
    })
    expect(out).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_DEMO" })
    expect((await rowOf(id))?.decided_at).toBeNull()
  })

  it("refuses the reserved review workspace", async () => {
    await markOrgAsDemo(kit.w.otherOrgId, reservedMarker())
    const id = await mint()
    const out = await decideDemoClientAction({
      orgId: kit.w.otherOrgId,
      actionId: id,
      target: TARGET,
    })
    expect(out).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_DEMO" })
    expect((await rowOf(id))?.decided_at).toBeNull()
  })

  it("refuses on a box that is not a demo", async () => {
    const id = await mint()
    DemoModeTestAccess.set(false)
    try {
      const out = await decideDemoClientAction({ orgId: kit.w.orgId, actionId: id, target: TARGET })
      expect(out).toMatchObject({ ok: false, code: "DEMO_DECIDE_NOT_DEMO_BOX" })
    } finally {
      DemoModeTestAccess.set(true)
    }
    expect((await rowOf(id))?.decided_at).toBeNull()
  })

  it("refuses a row whose target differs from the one its caller names", async () => {
    const id = await mint()
    const out = await decideDemoClientAction({
      orgId: kit.w.orgId,
      actionId: id,
      target: { app: "agreements", type: "agreement_version" },
    })
    expect(out).toMatchObject({ ok: false, code: "DEMO_DECIDE_OTHER_TARGET" })
    expect((await rowOf(id))?.decided_at).toBeNull()
    expect(await decidedEvents(id)).toHaveLength(0)
  })

  it("refuses when the shown document no longer matches its fingerprint", async () => {
    const id = await mint()
    kit.view = { ...kit.view, sha256: "c".repeat(64) }
    const out = await decideDemoClientAction({ orgId: kit.w.orgId, actionId: id, target: TARGET })
    expect(out).toMatchObject({ ok: false, code: "DEMO_DECIDE_VERSION_CHANGED" })
    expect((await rowOf(id))?.decided_at).toBeNull()
  })
})
