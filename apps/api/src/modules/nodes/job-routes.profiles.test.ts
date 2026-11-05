// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T18 (D24, D42, K6, K18, L18, S20a): a profile is a level and the Liaison
// tools switch. Raising it, any choice of Open, and a save that leaves a node
// whose published pin is below the level all need an attached in-app
// confirmation per such node; lowering asks nothing and voids the raises
// above. The list shows each node's confirmed level and suggests a level only
// for a Claude model preference.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("node profiles with in-app confirmations (P1-T18)", () => {
  let owner: minimal.Session
  let agentId: string

  const call = (path: string, method: string, body?: unknown, nodeCredential?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable(pins: Array<{ agentId: string; level: string }> = []) {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const node = { nodeId: d.node.id as string, credential: d.credential as string }
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [], levelPins: pins },
      node.credential,
    )
    expect(caps.status).toBe(200)
    return node
  }

  async function mint(nodeId: string, level: string): Promise<string> {
    const res = await call("/api/me/node-level-confirmations", "POST", {
      nodeId,
      agentId,
      level,
      purpose: "profile_raise",
    })
    expect(res.status).toBe(201)
    return (await json(res)).data.confirmationId as string
  }

  const save = (body: Record<string, unknown>) =>
    call(`/api/nodes/me/profiles/${agentId}`, "PUT", { liaisonTools: true, ...body })

  async function savedLevel(): Promise<string | null> {
    const [row] = await sql<{ level: string }[]>`
      SELECT level FROM kernel.node_profiles WHERE agent_id = ${agentId}`
    return row?.level ?? null
  }

  async function confirmationRow(id: string) {
    const [row] = await sql<
      Array<{ attached_at: Date | null; consumed_at: Date | null }>
    >`SELECT attached_at, consumed_at FROM kernel.node_level_confirmations WHERE id = ${id}`
    return row
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@pr-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '[]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`UPDATE kernel.agents SET model_preference = NULL WHERE id = ${agentId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("saving a profile publishes change profile per enabled node (S18)", async () => {
    const a = await enable()
    const b = await enable()
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      expect((await save({ level: "strict" })).status).toBe(200)
      const frames = spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e.app === "kernel" && e.entity === "node")
      expect(frames.map((e) => e.data)).toEqual(
        expect.arrayContaining([
          { ownerUserId: owner.userId, nodeId: a.nodeId, change: "profile" },
          { ownerUserId: owner.userId, nodeId: b.nodeId, change: "profile" },
        ]),
      )
      expect(frames).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("raising a profile without confirmations is 403 confirmation_required naming the nodes; with attached ones it saves; lowering saves without", async () => {
    const a = await enable()
    const b = await enable()
    const refused = await save({ level: "standard" })
    expect(refused.status).toBe(403)
    const body = await json(refused)
    expect(body.error.code).toBe("confirmation_required")
    expect([...body.error.nodeIds].sort()).toEqual([a.nodeId, b.nodeId].sort())
    expect(await savedLevel()).toBeNull()

    // One node confirmed is not enough: nothing is saved, the other is named.
    const ca = await mint(a.nodeId, "standard")
    const partial = await save({ level: "standard", confirmationIds: [ca] })
    expect(partial.status).toBe(403)
    expect((await json(partial)).error.nodeIds).toEqual([b.nodeId])
    expect(await savedLevel()).toBeNull()
    expect((await confirmationRow(ca)).attached_at).toBeNull()

    const cb = await mint(b.nodeId, "standard")
    const ok = await save({ level: "standard", confirmationIds: [ca, cb] })
    expect(ok.status).toBe(200)
    expect(await savedLevel()).toBe("standard")
    expect((await confirmationRow(ca)).attached_at).not.toBeNull()
    expect((await confirmationRow(cb)).attached_at).not.toBeNull()

    const lowered = await save({ level: "strict" })
    expect(lowered.status).toBe(200)
    expect(await savedLevel()).toBe("strict")
  })

  it("an expired or another node's confirmation is refused", async () => {
    const a = await enable()
    const b = await enable()
    const forB = await mint(b.nodeId, "standard")
    // A third node's id cannot stand in for the first node's.
    const wrongNode = await save({ level: "standard", confirmationIds: [forB] })
    expect(wrongNode.status).toBe(403)
    expect((await json(wrongNode)).error.nodeIds).toEqual([a.nodeId])

    const forA = await mint(a.nodeId, "standard")
    await sql`UPDATE kernel.node_level_confirmations SET expires_at = now() - interval '1 second'
               WHERE id = ${forA}`
    const expired = await save({ level: "standard", confirmationIds: [forA, forB] })
    expect(expired.status).toBe(403)
    expect((await json(expired)).error.nodeIds).toEqual([a.nodeId])
    expect(await savedLevel()).toBeNull()
  })

  it("a migrated Standard profile on a node with no published pin: re-saving Standard without ids is 403 naming that node; with its confirmation it saves and the confirmation is attached", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const n = await enable()
    const refused = await save({ level: "standard" })
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toMatchObject({
      code: "confirmation_required",
      nodeIds: [n.nodeId],
    })
    const id = await mint(n.nodeId, "standard")
    const ok = await save({ level: "standard", confirmationIds: [id] })
    expect(ok.status).toBe(200)
    expect((await confirmationRow(id)).attached_at).not.toBeNull()
  })

  // P1-walk D7: Confirm on one computer was refused while another enabled one
  // was unconfirmed; the first confirmation stayed unattached and a second
  // dialog asked for every computer at once.
  it("confirming the saved level on one computer saves for that computer alone; the other stays unconfirmed (D7)", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const a = await enable()
    const b = await enable()
    const id = await mint(a.nodeId, "standard")
    const ok = await save({ level: "standard", confirmationIds: [id] })
    expect(ok.status).toBe(200)
    expect((await json(ok)).data.unconfirmedNodeIds).toEqual([b.nodeId])
    expect((await confirmationRow(id)).attached_at).not.toBeNull()
    const [profile] = (await json(await call("/api/nodes/me/profiles", "GET"))).data
    const byNode = new Map(
      profile.nodes.map((n: { nodeId: string; confirmedLevel: string }) => [
        n.nodeId,
        n.confirmedLevel,
      ]),
    )
    // A's raise waits for its next session to consume it: confirmed here already.
    expect(byNode.get(a.nodeId)).toBe("standard")
    expect(byNode.get(b.nodeId)).toBe("strict")
    // A raise still needs every computer.
    const raise = await save({ level: "open", confirmationIds: [await mint(a.nodeId, "open")] })
    expect(raise.status).toBe(403)
  })

  it("re-saving Open from Open asks", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'open', true)`
    await enable([{ agentId, level: "open" }])
    const refused = await save({ level: "open" })
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("confirmation_required")
  })

  it("a node whose pin is already standard needs no confirmation to save standard", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    await enable([{ agentId, level: "standard" }])
    const ok = await save({ level: "standard", liaisonTools: false })
    expect(ok.status).toBe(200)
    const [row] = await sql<{ liaison_tools: boolean }[]>`
      SELECT liaison_tools FROM kernel.node_profiles WHERE agent_id = ${agentId}`
    expect(row.liaison_tools).toBe(false)
  })

  it("lowering voids an unconsumed open confirmation", async () => {
    const n = await enable()
    const id = await mint(n.nodeId, "open")
    expect((await save({ level: "open", confirmationIds: [id] })).status).toBe(200)
    expect((await confirmationRow(id)).consumed_at).toBeNull()
    expect(
      (await save({ level: "standard", confirmationIds: [await mint(n.nodeId, "standard")] }))
        .status,
    ).toBe(200)
    expect((await confirmationRow(id)).consumed_at).not.toBeNull()
  })

  it("DELETE goes back to strict and voids every raise above it", async () => {
    const n = await enable()
    const id = await mint(n.nodeId, "standard")
    expect((await save({ level: "standard", confirmationIds: [id] })).status).toBe(200)
    const res = await call(`/api/nodes/me/profiles/${agentId}`, "DELETE")
    expect(res.status).toBe(200)
    expect((await json(res)).data).toMatchObject({ level: "strict", liaisonTools: true })
    expect((await confirmationRow(id)).consumed_at).not.toBeNull()
  })

  it("the old confirmOpen flag is refused, never a way around the confirmation", async () => {
    await enable()
    const res = await save({ level: "open", confirmOpen: true })
    expect(res.status).toBe(400)
    expect(await savedLevel()).toBeNull()
  })

  it("GET /me/profiles shows each node's confirmed level, and no suggested level for a Gemini agent", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const pinned = await enable([{ agentId, level: "standard" }])
    const fresh = await enable()
    await sql`UPDATE kernel.agents SET model_preference = 'gemini-2.5-flash-lite' WHERE id = ${agentId}`
    const [gemini] = (await json(await call("/api/nodes/me/profiles", "GET"))).data
    expect(gemini).toMatchObject({
      agentId,
      agentName: "Fixer",
      level: "standard",
      liaisonTools: true,
      suggestedGuardrail: null,
    })
    expect(gemini.agentModel).toBeUndefined()
    expect(gemini.hash).toBeUndefined()
    const byNode = new Map(
      gemini.nodes.map((n: { nodeId: string; confirmedLevel: string }) => [
        n.nodeId,
        n.confirmedLevel,
      ]),
    )
    expect(byNode.get(pinned.nodeId)).toBe("standard")
    expect(byNode.get(fresh.nodeId)).toBe("strict")
    expect(typeof gemini.nodes[0].nodeName).toBe("string")

    await sql`UPDATE kernel.agents SET model_preference = 'claude-opus-5-5' WHERE id = ${agentId}`
    const [claude] = (await json(await call("/api/nodes/me/profiles", "GET"))).data
    expect(claude.suggestedGuardrail).toBe("standard")
    expect(claude.riskNote).toContain("Untrusted input")
  })
})
