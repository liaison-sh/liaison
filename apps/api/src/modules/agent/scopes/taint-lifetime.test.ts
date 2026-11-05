// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The untrusted-content mark (threads.tainted) covers the turn, tick or session that read outside
// text, not the thread's whole life. A turn the person typed and each routine tick start clean; an
// event-fired tick starts marked only when its event carries text from outside the org. Within a
// turn the mark stands: a read then an outward tool still parks.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { triggerEventOrigin } from "~/infra/jobs/event-routine-gate"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { runAgentChat } from "~/modules/agent/runtime/agent-service"
import { beginLiveRun, threadRunKey } from "~/modules/agent/scopes/live-runs"
import {
  setTaintFlag,
  taintSourceApplies,
  taintThreadForTriggerEvent,
} from "~/modules/agent/scopes/taint"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG_ID = "00000000-0000-4000-8000-00000071a001"
const USER_ID = "00000000-0000-4000-8000-00000071a002"
const THREAD = "00000000-0000-4000-8000-00000071a003"
const STRANGER_ID = "00000000-0000-4000-8000-00000071a0ff"
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

const actor = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function tainted(): Promise<boolean> {
  const [row] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${THREAD}`
  return row.tainted === true
}

let outwardRuns = 0

const turn = (content: string) => ({ threadId: THREAD, content, actor, orgId: ORG_ID })

/** End a turn the way the runtime does, so it is no longer live on the thread. */
async function finish(r: { finalize: (p: never) => Promise<unknown> }): Promise<void> {
  await r.finalize({
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "stop",
    text: "ok",
    steps: [],
  } as never)
}

describe("the untrusted-content mark covers one turn, tick or session", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    // No network: the turn's model is the scripted one.
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    await setScriptedTurn(THREAD, [{ text: "ok" }])
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG_ID}, 'TaintLifetime', 'taint-lifetime', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${USER_ID}, ${ORG_ID}, 'member@taint-life.test', 'Member', 'x', 'active')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${THREAD}, ${ORG_ID}, 'taint-life', 'agent_chat', ${USER_ID}, true) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG_ID}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.delete([ORG_ID, "kernel", "t_outward"])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
    else delete process.env.LIAISON_MODEL_PROVIDER
    await clearScriptedTurns(THREAD)
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("a background re-invocation keeps the mark of the turn it continues", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    await finish(await runAgentChat({ ...turn("continue"), background: true }))
    expect(await tainted()).toBe(true)
  })

  it("a typed turn does not reset the mark while another run is live on the thread", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    // A background turn is still running (not finalized) when the person types.
    const background = await runAgentChat({ ...turn("working"), background: true })
    await finish(await runAgentChat(turn("meanwhile")))
    expect(await tainted()).toBe(true)
    // Once it ended, the next typed turn starts clean.
    await finish(background)
    await finish(await runAgentChat(turn("again")))
    expect(await tainted()).toBe(false)
  })

  it("a routine tick does not reset the mark while another run is live on the thread", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    const end = await beginLiveRun(threadRunKey(THREAD))
    await taintThreadForTriggerEvent(THREAD, ORG_ID, undefined)
    expect(await tainted()).toBe(true)
    end()
    await taintThreadForTriggerEvent(THREAD, ORG_ID, undefined)
    expect(await tainted()).toBe(false)
  })

  it("a turn the person typed starts clean, then a read in that turn still parks an outward tool", async () => {
    // A thread marked weeks ago under the old forever rule.
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    await finish(await runAgentChat(turn("new question")))
    expect(await tainted()).toBe(false)

    toolRegistry.set([ORG_ID, "kernel", "t_outward"], {
      appName: "kernel",
      name: "t_outward",
      description: "outward (test stand-in)",
      requiredScopes: ["kernel:threads:read"],
      externalEffect: true,
      params: z.object({}),
      handler: async () => {
        outwardRuns++
        return { ok: true }
      },
    })
    const call = () =>
      executeTool({
        toolName: "kernel:t_outward",
        orgId: ORG_ID,
        actor,
        params: {},
        threadId: THREAD,
        origin: "in-app-agent",
        stepBundleId: null,
      })
    const clean = await call()
    expect(clean.blocked).toBeUndefined()
    expect(outwardRuns).toBe(1)
    // The same turn reads outside text: the outward tool now parks.
    await setTaintFlag(THREAD, ORG_ID)
    const parked = await call()
    expect(parked.blocked?.reason).toBe("taint_escalation")
    expect(outwardRuns).toBe(1)
  })

  it("each routine tick starts clean; only an external event marks it", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    // A cron tick (no event).
    await taintThreadForTriggerEvent(THREAD, ORG_ID, undefined)
    expect(await tainted()).toBe(false)
    const ev = { app: "projects", entity: "task", action: "moved", entityId: "t1", data: {} }
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD}`
    await taintThreadForTriggerEvent(THREAD, ORG_ID, { ...ev, origin: "internal" })
    expect(await tainted()).toBe(false)
    await taintThreadForTriggerEvent(THREAD, ORG_ID, { ...ev, origin: "external" })
    expect(await tainted()).toBe(true)
    // A payload queued before the origin existed fails closed.
    await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${THREAD}`
    await taintThreadForTriggerEvent(THREAD, ORG_ID, ev)
    expect(await tainted()).toBe(true)
  })

  it("classifies an event by whether it carries text from outside the org", async () => {
    const base = { orgId: ORG_ID, entityId: "e1" }
    // A member's own action, directly or through their agent or an MCP client.
    for (const actorType of ["user", "agent", "mcp"]) {
      expect(
        await triggerEventOrigin({
          ...base,
          app: "projects",
          entity: "task",
          action: "moved",
          actorType,
          actorId: USER_ID,
        }),
      ).toBe("internal")
    }
    // An internal thread message by a member.
    expect(
      await triggerEventOrigin({
        ...base,
        app: "kernel",
        entity: "message",
        action: "create",
        actorType: "user",
        actorId: USER_ID,
      }),
    ).toBe("internal")
    // A webhook or sync (system actor), and an actor that is not a member of the org.
    expect(
      await triggerEventOrigin({
        ...base,
        app: "shopify",
        entity: "inventory",
        action: "low",
        actorType: "system",
        actorId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBe("external")
    expect(
      await triggerEventOrigin({
        ...base,
        app: "projects",
        entity: "task",
        action: "moved",
        actorType: "user",
        actorId: STRANGER_ID,
      }),
    ).toBe("external")
    // An inbound mail is judged on its sender, whoever the sync ran as.
    const mail = (email: string) => ({
      ...base,
      app: "mail",
      entity: "message",
      action: "create",
      actorType: "user",
      actorId: USER_ID,
      data: { direction: "inbound", from: { email } },
    })
    // Any inbound mail is outside text: its From is not authenticated, and a member's forward
    // carries a customer's words.
    expect(await triggerEventOrigin(mail("Member@Taint-Life.test"))).toBe("external")
    expect(await triggerEventOrigin(mail("customer@outside.test"))).toBe("external")
    // A thread message an agent posted can carry what its turn read; a member's own stays internal.
    const post = (actorType: string, authorType: string) => ({
      ...base,
      app: "kernel",
      entity: "message",
      action: "create",
      actorType,
      actorId: USER_ID,
      data: { authorType },
    })
    expect(await triggerEventOrigin(post("agent", "agent"))).toBe("external")
    expect(await triggerEventOrigin(post("user", "agent"))).toBe("external")
    expect(await triggerEventOrigin(post("user", "user"))).toBe("internal")
    // An event that cannot be judged fails closed.
    const unreadable = {
      ...base,
      app: "projects",
      entity: "task",
      action: "moved",
      actorType: "user",
      get actorId(): string {
        throw new Error("unreadable")
      },
    }
    expect(await triggerEventOrigin(unreadable)).toBe("external")
    // A customer's ticket message and a social post are outside text by nature.
    expect(
      await triggerEventOrigin({
        ...base,
        app: "tickets",
        entity: "message",
        action: "create",
        actorType: "system",
        data: { ticketId: "t" },
      }),
    ).toBe("external")
    expect(
      await triggerEventOrigin({
        ...base,
        app: "tickets",
        entity: "message",
        action: "create",
        actorType: "user",
        actorId: USER_ID,
        data: { kind: "outbound" },
      }),
    ).toBe("internal")
    expect(
      await triggerEventOrigin({
        ...base,
        app: "social",
        entity: "finding",
        action: "created",
        actorType: "user",
        actorId: USER_ID,
      }),
    ).toBe("external")
  })

  it("a taintSourceWhen that cannot answer marks the turn", async () => {
    const throwing = async (): Promise<boolean> => {
      throw new Error("lookup failed")
    }
    expect(
      await taintSourceApplies({ taintSource: true, taintSourceWhen: throwing }, {}, ORG_ID),
    ).toBe(true)
    expect(
      await taintSourceApplies(
        { taintSource: true, taintSourceWhen: async () => false },
        {},
        ORG_ID,
      ),
    ).toBe(false)
  })
})
