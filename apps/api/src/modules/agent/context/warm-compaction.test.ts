// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cold resume, run while the cache is still warm (warm-compaction.ts):
// a turn's request is kept and slides one job to `lastCall + TTL - margin`;
// the job advances only a thread still idle, once per idle window whatever
// the replicas, and its brief request is the thread's last request with one
// instruction appended.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { env } from "~/lib/env"
import { loadBoundedHistory } from "~/modules/agent/context/checkpoint"
import { WARM_WINDOW_MS } from "~/modules/agent/context/cold-resume"
import { setOrgHistorySettings } from "~/modules/agent/context/history-settings"
import {
  type LastRequestStore,
  MEASURED_CACHE_TTL_S,
  promptCacheTtlSeconds,
  readLastTurnRequest,
  recordTurnRequest,
  runWarmCompaction,
  WARM_COMPACTION_MARGIN_MS,
  WARM_COMPACTION_MIN_IDLE_MS,
  WarmCompactionTestAccess,
  warmBriefRequestBody,
  warmCompactionDelayMs,
  warmCompactionJobId,
} from "~/modules/agent/context/warm-compaction"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "4e000000-0000-4000-8000-000000000001"
const USER_ID = "4e000000-0000-4000-8000-000000000002"
const AGENT_ID = "4e000000-0000-4000-8000-000000000003"
const OTHER_AGENT = "4e000000-0000-4000-8000-000000000004"
const THREAD = "4e000000-0000-4000-8000-000000000010"
const QUIET_THREAD = "4e000000-0000-4000-8000-000000000011"
const BUSY_THREAD = "4e000000-0000-4000-8000-000000000012"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

/** An in-memory stand-in for the Redis keys (same contract). */
function memoryStore(): LastRequestStore & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>()
  return {
    data,
    async put(key, value) {
      data.set(key, value)
    },
    async get(key) {
      return data.get(key) ?? null
    },
    async claim(key) {
      if (data.has(key)) return false
      data.set(key, Buffer.from("1"))
      return true
    },
  }
}

const arms: Array<{ delayMs: number; jobId: string }> = []
const sent: Array<Record<string, unknown>> = []

/** 40 alternating rows of 4,000 characters: about 40,000 tokens, over the floor. */
async function seedConversation(threadId: string, handle: string): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
  for (let i = 1; i <= 40; i++) {
    const user = i % 2 === 1
    const body = `${user ? "Question" : "Answer"} ${i} `
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_agent_id, author_type, content, created_at, required_scopes)
      VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, ${user ? null : AGENT_ID},
        ${user ? "user" : "agent"}, ${body + "x".repeat(4_000 - body.length)},
        ${new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()}, '{}')`
  }
}

/** The turn's last request, as the provider sent it (pin applied). */
function lastBody(): Record<string, unknown> {
  return {
    model: "deepseek/deepseek-v4.1-flash",
    stream: true,
    stream_options: { include_usage: true },
    provider: { order: ["Wafer"], allow_fallbacks: true },
    usage: { include: true },
    tools: [{ type: "function", function: { name: "tickets__get", parameters: {} } }],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "You help." },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ${"x".repeat(4_000)}`,
      })),
    ],
  }
}

const turn = (threadId: string, agentId = AGENT_ID) => ({
  orgId: ORG_ID,
  agentId,
  actor,
  modelKey: "openrouter/deepseek/deepseek-v4.1-flash",
  contextWindow: 1_048_576,
  threadId,
})

describe("warm-cache idle compaction", () => {
  let store: ReturnType<typeof memoryStore>

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'WarmOrg', 'warm-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'warm@test.com', 'Warm')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@warm', 'Warm', ${USER_ID}, '["*"]'::jsonb, 'You help.')`
    await seedConversation(THREAD, "warm-main")
    await seedConversation(QUIET_THREAD, "warm-quiet")
    await seedConversation(BUSY_THREAD, "warm-busy")
    store = memoryStore()
    WarmCompactionTestAccess.setStore(store)
    WarmCompactionTestAccess.setArm(async (_payload, delayMs, jobId) => {
      arms.push({ delayMs, jobId })
    })
    WarmCompactionTestAccess.setCreditGate(async () => ({
      allowed: true,
      providerKey: "test-key",
      settle: async () => {},
    }))
    WarmCompactionTestAccess.setSend(async ({ body }) => {
      sent.push(body)
      return {
        provider: "Wafer",
        choices: [{ message: { content: "### Current decisions\nnone" } }],
        usage: {
          prompt_tokens: 42_000,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 41_000 },
        },
      }
    })
  })

  afterAll(async () => {
    WarmCompactionTestAccess.setStore()
    WarmCompactionTestAccess.setArm()
    WarmCompactionTestAccess.setCreditGate()
    WarmCompactionTestAccess.setSend()
    for (const table of [
      "audit_log",
      "agent_memory",
      "thread_briefs",
      "thread_brief_marks",
      "thread_episodes",
      "agent_thread_checkpoints",
      "messages",
      "thread_participants",
      "threads",
      "agents",
      "users",
    ]) {
      await sql.unsafe(`DELETE FROM kernel.${table} WHERE org_id = $1`, [ORG_ID])
    }
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("TTL: a measured host gets its lifetime, any other the configured default", () => {
    expect(promptCacheTtlSeconds(null)).toBe(env.AGENT_PROMPT_CACHE_TTL_S)
    expect(promptCacheTtlSeconds("SomeUnmeasuredHost")).toBe(env.AGENT_PROMPT_CACHE_TTL_S)
    for (const [host, ttl] of Object.entries(MEASURED_CACHE_TTL_S)) {
      expect(promptCacheTtlSeconds(host)).toBe(ttl)
    }
    expect(warmCompactionDelayMs(300)).toBe(300_000 - WARM_COMPACTION_MARGIN_MS)
    // Never later than the cold resume's own window.
    expect(warmCompactionDelayMs(24 * 3600)).toBe(WARM_WINDOW_MS - WARM_COMPACTION_MARGIN_MS)
  })

  it("every turn request is kept and slides ONE job to lastCall + TTL - margin", async () => {
    arms.length = 0
    const t0 = Date.now()
    await recordTurnRequest(turn(THREAD), lastBody(), null, t0)
    await recordTurnRequest(turn(THREAD), lastBody(), null, t0 + 5_000)
    const kept = await readLastTurnRequest(ORG_ID, THREAD)
    expect(kept?.at).toBe(t0 + 5_000)
    expect(kept?.body).toEqual(lastBody())
    const id = warmCompactionJobId({ orgId: ORG_ID, agentId: AGENT_ID, threadId: THREAD })
    // The same job id each time: re-arming replaces the delayed job.
    expect(arms).toEqual([
      { delayMs: warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S), jobId: id },
      { delayMs: warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S), jobId: id },
    ])
  })

  it("a host whose cache is too short for an idle moment is left to the cold resume", async () => {
    arms.length = 0
    const short = Object.entries(MEASURED_CACHE_TTL_S).find(
      ([, ttl]) => warmCompactionDelayMs(ttl) < WARM_COMPACTION_MIN_IDLE_MS,
    )
    expect(short).toBeDefined()
    const other = "33333333-3333-4333-8333-333333333333"
    await recordTurnRequest(turn(other), lastBody(), short?.[0] ?? null)
    expect(arms).toEqual([])
    expect(await readLastTurnRequest(ORG_ID, other)).toBeNull()
  })

  it("a request too small to hold a history worth compressing is not kept", async () => {
    arms.length = 0
    await recordTurnRequest(
      turn(QUIET_THREAD),
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      null,
    )
    expect(await readLastTurnRequest(ORG_ID, QUIET_THREAD)).toBeNull()
    expect(arms).toEqual([])
  })

  it("the brief request is the thread's last request with one instruction appended", () => {
    const last = lastBody()
    const body = warmBriefRequestBody(last, "Write the brief.")
    const msgs = body.messages as unknown[]
    // The cached prefix, byte for byte: system, tools, every history message.
    expect(msgs.slice(0, -1)).toEqual(last.messages as unknown[])
    expect(JSON.stringify(msgs.slice(0, -1))).toBe(JSON.stringify(last.messages))
    expect(body.tools).toEqual(last.tools)
    expect(body.model).toBe(last.model)
    expect(body.provider).toEqual(last.provider)
    expect(msgs.at(-1)).toEqual({ role: "user", content: "Write the brief." })
    // Only what is not prompt changes.
    expect(body.stream).toBeUndefined()
    expect(body.stream_options).toBeUndefined()
    // tool_choice too: "none" makes a host leave the tool list out of the
    // prompt, which breaks the cached prefix right after the system prompt.
    expect(body.tool_choice).toBe(last.tool_choice)
    expect(Object.keys(body).sort()).toEqual(
      Object.keys(last)
        .filter((k) => k !== "stream" && k !== "stream_options")
        .concat("max_tokens")
        .filter((k, i, all) => all.indexOf(k) === i)
        .sort(),
    )
  })

  it("a turn after the job was armed: the job re-arms for the newer request instead of firing", async () => {
    arms.length = 0
    const at = Date.now()
    await recordTurnRequest(turn(THREAD), lastBody(), null, at)
    arms.length = 0
    const outcome = await runWarmCompaction(
      { orgId: ORG_ID, agentId: AGENT_ID, threadId: THREAD },
      at + 10_000,
    )
    expect(outcome).toBe("rearmed")
    expect(arms).toHaveLength(1)
    expect(arms[0].jobId).toEndWith(`:${at}`)
  })

  it("too late (the cache is already cold): nothing to gain, the returning turn compresses", async () => {
    const at = Date.now()
    await recordTurnRequest(turn(THREAD), lastBody(), null, at)
    const outcome = await runWarmCompaction(
      { orgId: ORG_ID, agentId: AGENT_ID, threadId: THREAD },
      at + env.AGENT_PROMPT_CACHE_TTL_S * 1000 + 1,
    )
    expect(outcome).toBe("cache-cold")
  })

  it("another agent's request is the newest: this agent's job does nothing", async () => {
    const at = Date.now()
    await recordTurnRequest(turn(QUIET_THREAD, OTHER_AGENT), lastBody(), null, at)
    const outcome = await runWarmCompaction(
      { orgId: ORG_ID, agentId: AGENT_ID, threadId: QUIET_THREAD },
      at + warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S),
    )
    expect(outcome).toBe("other-agent")
  })

  it("a person wrote after the last request: no compaction, the coming turn starts warm", async () => {
    const at = Date.now() - 1_000
    await recordTurnRequest(turn(BUSY_THREAD), lastBody(), null, at)
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
      VALUES (${BUSY_THREAD}, ${ORG_ID}, ${USER_ID}, 'user', 'One more thing', ${new Date(at + 500).toISOString()}, '{}')`
    const outcome = await runWarmCompaction(
      { orgId: ORG_ID, agentId: AGENT_ID, threadId: BUSY_THREAD },
      at + warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S),
    )
    expect(outcome).toBe("activity")
  })

  it("the org setting off: no compaction", async () => {
    const at = Date.now()
    await recordTurnRequest(turn(QUIET_THREAD), lastBody(), null, at)
    await setOrgHistorySettings(ORG_ID, { warmCompaction: false })
    try {
      const outcome = await runWarmCompaction(
        { orgId: ORG_ID, agentId: AGENT_ID, threadId: QUIET_THREAD },
        at + warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S),
      )
      expect(outcome).toBe("setting-off")
    } finally {
      await setOrgHistorySettings(ORG_ID, { warmCompaction: true })
    }
  })

  it("idle just before the TTL: ONE advance across replicas, sent as the cached request plus the instruction", async () => {
    sent.length = 0
    const at = Date.now()
    await recordTurnRequest(turn(THREAD), lastBody(), null, at)
    const due = at + warmCompactionDelayMs(env.AGENT_PROMPT_CACHE_TTL_S)
    const payload = { orgId: ORG_ID, agentId: AGENT_ID, threadId: THREAD }
    // Two workers pick the job up at the same moment (a retry, a second replica).
    const outcomes = await Promise.all([
      runWarmCompaction(payload, due),
      runWarmCompaction(payload, due),
    ])
    expect(outcomes.filter((o) => o === "advanced")).toHaveLength(1)
    expect(outcomes).toContain("claimed")
    const versions = await sql`SELECT version, summary FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${ORG_ID} AND thread_id = ${THREAD} AND agent_id = ${AGENT_ID}`
    expect(versions).toHaveLength(1)
    // The brief is the cold resume's: same storage, same format.
    expect(versions[0].summary).toContain("Current decisions")

    // ONE brief call, and it is the thread's last request with one appended
    // instruction carrying the brief prompt, the brief so far and the region.
    expect(sent).toHaveLength(1)
    const msgs = sent[0].messages as Array<{ role: string; content: string }>
    expect(JSON.stringify(msgs.slice(0, -1))).toBe(JSON.stringify(lastBody().messages))
    const instruction = msgs.at(-1)
    expect(instruction?.role).toBe("user")
    expect(instruction?.content).toContain("## The brief so far")
    expect(instruction?.content).toContain("## The new region")
    expect(instruction?.content).toContain("Current decisions")

    // The turn after the gap starts from the checkpoint and the cold tail.
    const after = await loadBoundedHistory({
      threadId: THREAD,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: 1_048_576,
    })
    expect(after.checkpoint?.summary).toContain("Current decisions")
    expect(after.estimatedTokens).toBeLessThanOrEqual(8_000)

    // Fired again for the same idle window (a late retry): nothing more.
    expect(await runWarmCompaction(payload, due + 1_000)).not.toBe("advanced")
  })
})
