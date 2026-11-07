// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The target serves the org only when the control plane says the move
// committed: the source agent's `activate` alone does not unfreeze it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { _setEdition } from "~/lib/edition"
import { BillingUnavailableError } from "~/modules/billing-managed/control-client"
import { writeIndexAndWait } from "~/modules/search/index-writer"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { orgTransferStateOf, setOrgTransferState } from "../transfer-state/state"
import { TargetAgent } from "./agent-target"
import { importSearchDocuments } from "./search"

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("target activation", () => {
  it("refuses while the control plane has the move frozen, serves once it is committed", async () => {
    const { orgId } = await minimal.secondOrg({ name: "Activating Org" })
    const transferId = randomUUID()
    let decided = "frozen"
    const agent = new TargetAgent({
      sql: {} as never,
      ownKeys: {} as never,
      ackInstances: [],
      moveState: async () => decided as never,
    })
    await agent.handle("hello", {
      orgId,
      transferId,
      keys: { encryption: "a".repeat(64), byok: "b".repeat(64) },
    })
    await setOrgTransferState(orgId, "incoming", transferId)
    try {
      await expect(agent.handle("activate", {})).rejects.toThrow(/has the move frozen/)
      expect((await orgTransferStateOf(orgId))?.state).toBe("incoming")
      decided = "committed"
      await agent.handle("activate", {})
      expect(await orgTransferStateOf(orgId)).toBeNull()
    } finally {
      await setOrgTransferState(orgId, null, transferId).catch(() => {})
    }
  }, 60_000)

  it("a control plane that cannot be asked leaves the org incoming", async () => {
    const { orgId } = await minimal.secondOrg({ name: "Activating Org 2" })
    const transferId = randomUUID()
    const agent = new TargetAgent({
      sql: {} as never,
      ownKeys: {} as never,
      ackInstances: [],
      moveState: async () => {
        throw new Error("down")
      },
    })
    await agent.handle("hello", {
      orgId,
      transferId,
      keys: { encryption: "a".repeat(64), byok: "b".repeat(64) },
    })
    await setOrgTransferState(orgId, "incoming", transferId)
    try {
      await expect(agent.handle("activate", {})).rejects.toThrow(/could not confirm/)
      expect((await orgTransferStateOf(orgId))?.state).toBe("incoming")
    } finally {
      await setOrgTransferState(orgId, null, transferId).catch(() => {})
    }
  }, 60_000)

  for (const edition of ["managed", "self_hosted"] as const) {
    it(`a cell without control-plane config ${edition === "managed" ? "refuses (managed)" : "serves (self-hosted)"}`, async () => {
      const { orgId } = await minimal.secondOrg({ name: `Activating Org ${edition}` })
      const transferId = randomUUID()
      const agent = new TargetAgent({
        sql: {} as never,
        ownKeys: {} as never,
        ackInstances: [],
        moveState: async () => {
          throw new BillingUnavailableError("no registered identity for this instance")
        },
      })
      await agent.handle("hello", {
        orgId,
        transferId,
        keys: { encryption: "a".repeat(64), byok: "b".repeat(64) },
      })
      await setOrgTransferState(orgId, "incoming", transferId)
      _setEdition(edition)
      try {
        if (edition === "managed") {
          await expect(agent.handle("activate", {})).rejects.toThrow(/could not confirm/)
          expect((await orgTransferStateOf(orgId))?.state).toBe("incoming")
        } else {
          await agent.handle("activate", {})
          expect(await orgTransferStateOf(orgId)).toBeNull()
        }
      } finally {
        _setEdition(null)
        await setOrgTransferState(orgId, null, transferId).catch(() => {})
      }
    }, 60_000)
  }

  it("a second hello cannot switch the org mid-session", async () => {
    const agent = new TargetAgent({ sql: {} as never, ownKeys: {} as never })
    const keys = { encryption: "a".repeat(64), byok: "b".repeat(64) }
    await agent.handle("hello", { orgId: randomUUID(), transferId: randomUUID(), keys })
    await expect(
      agent.handle("hello", { orgId: randomUUID(), transferId: randomUUID(), keys }),
    ).rejects.toThrow(/hello already received/)
  })

  it("a search document another org holds is never overwritten by the import", async () => {
    const other = randomUUID()
    const mine = randomUUID()
    const id = `foreign-${randomUUID()}`
    // A fresh Meilisearch has no index, or one a failed first write created
    // without a primary key: make sure it exists with `id`.
    const meili = getMeili()
    const name = effectiveIndexName()
    const created = await meili.createIndex(name, { primaryKey: "id" })
    await waitForMeiliTask(meili, created.taskUid).catch(() => {})
    const updated = await meili.index(name).update({ primaryKey: "id" })
    await waitForMeiliTask(meili, updated.taskUid).catch(() => {})
    await writeIndexAndWait({ docs: [{ id, org_id: other, title: "theirs" }] })
    try {
      await expect(
        importSearchDocuments(mine, [JSON.stringify({ id, org_id: mine, title: "mine" })]),
      ).rejects.toThrow(/belongs to another org/)
    } finally {
      await writeIndexAndWait({ deleteIds: [id] })
    }
  }, 60_000)
})
