// SPDX-License-Identifier: FSL-1.1-ALv2
// Prompt-cache friendliness oracle. Provider prompt caches (Gemini implicit,
// OpenAI automatic, Anthropic breakpoints) are longest-common-PREFIX matches
// over the serialized request: ONE per-request byte in the system block (a
// timestamp, a view id) invalidates the cached system+tools+history prefix on
// every turn. These tests pin the contract that assembleContext keeps every
// per-request-variable byte OUT of the system parts and confines it to the
// ephemeral runtime-context tail message appended after the history.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { assembleContext, systemPartsToText } from "~/modules/agent/context/context"
import { computeRawInputCost } from "~/modules/agent/credits/credit-meter"
import { atClockOffset, CLOCK_JUMP_MS } from "~/tests/helpers/clock"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cb0001"
const USER_ID = "00000000-0000-0000-0000-000000cb0002"
const THREAD_ID = "00000000-0000-0000-0000-000000cb0003"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

describe("prompt-cache stability", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CacheOrg', 'cache-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'cache@test.com', 'Cache User')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'cache-chat-1', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
  })

  afterAll(releaseTestLock)

  it("system parts are byte-identical across consecutive assemblies (the cacheable prefix)", async () => {
    const a = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    // Move the wall clock past a second (and a day) so a stray timestamp
    // anywhere in the system block would differ between the two assemblies.
    const b = await atClockOffset(CLOCK_JUMP_MS, () =>
      assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor }),
    )
    expect(systemPartsToText(a.system)).toBe(systemPartsToText(b.system))
  })

  it("system parts contain no wall-clock timestamp", async () => {
    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    // ISO-8601 datetime anywhere in the system block = per-request byte = cache buster.
    expect(systemPartsToText(result.system)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("the current time rides in the ephemeral runtime-context tail message", async () => {
    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const last = result.messages[result.messages.length - 1]
    expect(last?.role).toBe("user")
    const content = typeof last?.content === "string" ? last.content : ""
    expect(content).toContain("<runtime-context")
    expect(content).toMatch(/current time is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(content).toContain("</runtime-context>")
  })

  it("the tail message is the ONLY per-request-variable message (history prefix stays stable)", async () => {
    const a = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const b = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const historyA = a.messages.slice(0, -1)
    const historyB = b.messages.slice(0, -1)
    expect(JSON.stringify(historyA)).toBe(JSON.stringify(historyB))
  })
})

describe("computeRawInputCost — cached-input pricing", () => {
  const RATE = 1 // 1 unit per 1M tokens keeps the arithmetic legible

  it("bills full rate when no cached tokens are reported", () => {
    expect(computeRawInputCost("google", 1_000_000, 0, RATE)).toBeCloseTo(1)
  })

  it("bills cached-subset providers at (input-cached) full + cached at 10%", () => {
    // google/openai/mistral report inputTokens INCLUSIVE of cache hits
    expect(computeRawInputCost("google", 1_000_000, 900_000, RATE)).toBeCloseTo(0.1 + 0.09)
    expect(computeRawInputCost("openai", 1_000_000, 900_000, RATE)).toBeCloseTo(0.19)
    expect(computeRawInputCost("mistral", 1_000_000, 900_000, RATE)).toBeCloseTo(0.19)
  })

  // The numbers below are the AI SDK's normalized usage for one real-shaped
  // Anthropic response (input_tokens 100k, cache_read_input_tokens 850k,
  // cache_creation_input_tokens 50k): inputTokens is the WHOLE prompt, 1M.
  it("bills anthropic reads at 0.1x and writes at the 1h premium, both inside inputTokens", () => {
    const saved = process.env.LIAISON_ANTHROPIC_CACHE_TTL
    try {
      delete process.env.LIAISON_ANTHROPIC_CACHE_TTL // default 1h
      expect(computeRawInputCost("anthropic", 1_000_000, 850_000, RATE, 50_000)).toBeCloseTo(
        0.1 + 0.085 + 0.1,
      )
      process.env.LIAISON_ANTHROPIC_CACHE_TTL = "5m"
      expect(computeRawInputCost("anthropic", 1_000_000, 850_000, RATE, 50_000)).toBeCloseTo(
        0.1 + 0.085 + 0.0625,
      )
    } finally {
      if (saved === undefined) delete process.env.LIAISON_ANTHROPIC_CACHE_TTL
      else process.env.LIAISON_ANTHROPIC_CACHE_TTL = saved
    }
  })

  // A request mixes TTLs: the 1h assembly breakpoints and the 5m rolling step
  // breakpoints. Anthropic reports the 5m part (cache_creation
  // .ephemeral_5m_input_tokens); it costs 1.25x, the rest the 1h 2x.
  it("bills the 5-minute part of the writes at 1.25x and the rest at the 1h rate", () => {
    const saved = process.env.LIAISON_ANTHROPIC_CACHE_TTL
    try {
      delete process.env.LIAISON_ANTHROPIC_CACHE_TTL // default 1h
      // 100k plain + 850k read + 50k written: 20k of them at 5m, 30k at 1h.
      expect(
        computeRawInputCost("anthropic", 1_000_000, 850_000, RATE, 50_000, 20_000),
      ).toBeCloseTo(0.1 + 0.085 + 0.02 * 1.25 + 0.03 * 2, 10)
      // All writes 5m: 1.25x, never the 1h 2x.
      expect(
        computeRawInputCost("anthropic", 1_000_000, 850_000, RATE, 50_000, 50_000),
      ).toBeCloseTo(0.1 + 0.085 + 0.0625, 10)
      // A 5m count above the write total is clamped to it.
      expect(
        computeRawInputCost("anthropic", 1_000_000, 850_000, RATE, 50_000, 90_000),
      ).toBeCloseTo(0.1 + 0.085 + 0.0625, 10)
    } finally {
      if (saved === undefined) delete process.env.LIAISON_ANTHROPIC_CACHE_TTL
      else process.env.LIAISON_ANTHROPIC_CACHE_TTL = saved
    }
  })

  it("ignores cache writes for providers that do not charge them", () => {
    expect(computeRawInputCost("google", 1_000_000, 900_000, RATE, 50_000)).toBeCloseTo(0.19)
  })

  it("clamps a cached count larger than input on subset providers", () => {
    // Defensive: never bill negative uncached input.
    expect(computeRawInputCost("google", 500_000, 900_000, RATE)).toBeCloseTo(0.05)
  })

  it("falls back to full rate for unknown providers", () => {
    expect(computeRawInputCost("someproxy", 1_000_000, 900_000, RATE)).toBeCloseTo(1)
  })
})
