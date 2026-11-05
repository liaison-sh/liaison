// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T24: auto recall runs before every turn, inside its budget, in the
// EPHEMERAL TAIL and never in a system part (invariant I2), and every row it
// actually injects taints the turn (A2).
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const TAINTED_THREAD_ID = crypto.randomUUID()
const ROUTINE_THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const SCOPE = "crm:deals:read"

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function systemText(result: { system: unknown }): string {
  const parts = result.system as Array<{ content: string }> | string
  return typeof parts === "string" ? parts : parts.map((p) => p.content).join("\n\n")
}

function tailText(result: { messages: Array<{ content: unknown }> }): string {
  const last = result.messages[result.messages.length - 1]
  const content = typeof last?.content === "string" ? last.content : ""
  return content.startsWith("<runtime-context") ? content : ""
}

async function seedFile(name: string, description: string, body: string, scopes: string[]) {
  await sql`INSERT INTO kernel.agent_memory
    (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
    VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', ${name}, ${description}, ${body},
      ${`project/${name}.md`}, ${scopes}::text[])`
}

describe("auto recall", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'RecallOrg', ${`recall-${tag}`})`
    for (const [id, name] of [
      [USER_A, "recall-a"],
      [ADMIN, "recall-admin"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', ${`recall${tag}`}, 'Liaison', ${USER_A})`
    for (const [id, handle, tainted] of [
      [THREAD_ID, `recallthread${tag}`, false],
      [TAINTED_THREAD_ID, `recalltaint${tag}`, true],
      [ROUTINE_THREAD_ID, `recallroutine${tag}`, false],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by, tainted)
        VALUES (${id}, ${ORG_ID}, ${handle}, ${USER_A}, ${tainted})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${id}, ${USER_A}, ${ORG_ID})`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("auto recall injects at most 800 tokens into the tail and nothing into a system part", async () => {
    const { autoRecall, AUTO_RECALL_TOKEN_CAP, RECALLED_MEMORY_MARKER } = await import(
      "./memory-recall"
    )
    const { estimateTokens } = await import("~/modules/agent/context/compaction")
    const { assembleContext } = await import("~/modules/agent/context/context")
    expect(AUTO_RECALL_TOKEN_CAP).toBe(800)
    const body = `The kestrel account number is 55123. ${"padding padding padding ".repeat(60)}`
    for (let i = 0; i < 12; i++) {
      await seedFile(`kestrel-${i}`, `kestrel note ${i}`, body, [])
    }
    const recalled = await autoRecall({
      agentId: AGENT_A,
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: [],
      incomingText: "what is the kestrel account number",
    })
    expect(recalled).not.toBeNull()
    expect(estimateTokens(recalled?.text ?? "")).toBeLessThanOrEqual(AUTO_RECALL_TOKEN_CAP)

    const result = await assembleContext({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      agentId: AGENT_A,
      ...(recalled ? { recalledMemory: recalled } : {}),
    })
    expect(tailText(result)).toContain(RECALLED_MEMORY_MARKER)
    expect(systemText(result)).not.toContain(RECALLED_MEMORY_MARKER)
  })

  it("a row the budget dropped taints nothing: only injected rows are recorded", async () => {
    const { autoRecall } = await import("./memory-recall")
    const body = `The kestrel account number is 55123. ${"padding padding padding ".repeat(60)}`
    const seeded: string[] = []
    for (let i = 0; i < 8; i++) {
      const scope = `zz:drop${i}:read`
      seeded.push(scope)
      // Wide rows on purpose: the serialized payload cap trims the search, and
      // the 800 token recall budget then trims what is left again. Both drops
      // have to leave the turn untainted.
      await seedFile(
        `kestrel-drop-with-a-long-file-name-${i}`,
        `kestrel note ${i} ${"detail ".repeat(100)}`.slice(0, 560),
        body,
        [scope],
      )
    }
    const recalled = await autoRecall({
      agentId: AGENT_A,
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: ["*"],
      incomingText: "what is the kestrel account number",
    })
    expect(recalled).not.toBeNull()
    // The budget really did drop rows, which is what makes the rest of this
    // case mean anything.
    // Rows WERE dropped on the way to the model: the payload cap and the 800
    // token block both trim from the bottom, and whichever one did it, the
    // dropped row never reached the turn.
    expect(recalled?.hitCount ?? 0).toBeLessThan(seeded.length)
    expect(recalled?.injectedScopes.length).toBe(recalled?.hitCount)
    const injected = (recalled?.injectedScopes ?? []).flat()
    const rendered = recalled?.text ?? ""
    for (const scope of seeded) {
      const index = Number(scope.slice("zz:drop".length, scope.indexOf(":read")))
      const wasInjected = rendered.includes(
        `project/kestrel-drop-with-a-long-file-name-${index}.md`,
      )
      expect(injected.includes(scope)).toBe(wasInjected)
    }
    expect(injected.length).toBeLessThan(seeded.length)
  })

  it("a recalled row's required scopes are unioned into the turn", async () => {
    const { autoRecall } = await import("./memory-recall")
    const { assembleContext } = await import("~/modules/agent/context/context")
    const { createTurnScopeAccumulator } = await import(
      "~/modules/agent/scopes/turn-scope-accumulator"
    )
    await seedFile("osprey", "the osprey rebate", "The osprey rebate is 12 percent.", [SCOPE])
    const recalled = await autoRecall({
      agentId: AGENT_A,
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: [SCOPE],
      incomingText: "what is the osprey rebate",
    })
    expect(recalled?.injectedScopes).toContainEqual([SCOPE])
    const accumulator = createTurnScopeAccumulator()
    await assembleContext({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      agentId: AGENT_A,
      effectiveScope: [SCOPE],
      turnScopeAccumulator: accumulator,
      ...(recalled ? { recalledMemory: recalled } : {}),
    })
    // Zero tool calls made, and the turn is still tagged with the row's scope.
    expect(accumulator.snapshot()).toContain(SCOPE)
  })

  it("auto recall is skipped on a tainted thread", async () => {
    const memorySearchModule = await import("./memory-search")
    const spy = spyOn(memorySearchModule, "memorySearch")
    const { autoRecall } = await import("./memory-recall")
    await seedFile("gannet", "the gannet rate", "The gannet rate is 9.", [])
    const recalled = await autoRecall({
      agentId: AGENT_A,
      threadId: TAINTED_THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: [],
      incomingText: "what is the gannet rate",
    })
    expect(recalled).toBeNull()
    expect(spy).toHaveBeenCalledTimes(0)
    spy.mockRestore()
  })

  it("a fact from a high scope turn is absent from a low scope room's auto recall", async () => {
    const { autoRecall } = await import("./memory-recall")
    await seedFile("petrel", "the petrel margin", "The petrel margin is 31 percent.", [SCOPE])
    const low = await autoRecall({
      agentId: AGENT_A,
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: [],
      incomingText: "what is the petrel margin",
    })
    expect(low?.hitCount ?? 0).toBe(0)
    const admin = await autoRecall({
      agentId: AGENT_A,
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: ["*"],
      incomingText: "what is the petrel margin",
    })
    expect(admin?.hitCount).toBe(1)
  })

  it("a routine tick recalls its own prior episode before the general query", async () => {
    const { autoRecall } = await import("./memory-recall")
    // Tick 1's episode, in the routine's own output thread, plus an unrelated
    // topic file that scores higher on plain lexical grounds.
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path,
       required_scopes, source_thread_id)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'episode', ${`tick-one-${tag}`},
        'what tick one concluded', 'Tick one concluded the puffin backlog is clear.',
        ${`episodes/recallroutine${tag}/2026-09-12.md`}, '{}'::text[], ${ROUTINE_THREAD_ID})`
    await seedFile("puffin", "puffin puffin puffin", "puffin puffin puffin backlog puffin", [])
    const recalled = await autoRecall({
      agentId: AGENT_A,
      threadId: ROUTINE_THREAD_ID,
      orgId: ORG_ID,
      actor: actorA,
      scopes: [],
      incomingText: "what is the puffin backlog",
      isRoutineTick: true,
    })
    expect(recalled?.hits[0]?.path).toBe(`episodes/recallroutine${tag}/2026-09-12.md`)
  })
})
