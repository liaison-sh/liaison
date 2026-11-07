// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reserved App Review org's guards OUTSIDE the turn loop, one test each,
// every one run for the reserved org on a demo box AND for a normal org on the
// same box. Each guard is a single line that returns early for the reserved
// org, so each test is written to fail when that line is deleted.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the refusal from `processMediaAnalysisJob`: the reserved org's job
//    reaches its pre check.
//  * Delete the `isReservedDemoOrg` return from `generateTitleWithLLM`
//    (auto-title.ts): the reserved org's title is asked of a model.
//  * Make `runSandboxedExtraction` pick a model for the reserved org
//    (web-tools.ts): the extraction is asked of a model.
//  * Delete the `isReservedDemoOrg` return from `meterSideCall`:
//    a normal org's unmetered side call gets a usage row.
//  * Delete the release from `routineCreditGate` (kernel-jobs.ts): the gate
//    leaves a turn's reservation held against the reserved org's ceiling.
//
// A model call is observed at the network: `fetch` is stubbed with a Gemini
// shaped answer, and the cheapest auto eligible model is a Google one seeded
// here, so the unguarded path reaches the stub and nothing leaves the machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { threads as kernelThreads } from "~/db/schema/kernel"
import { routineCreditGate } from "~/infra/jobs/kernel-jobs"
import { redis } from "~/lib/redis"
import { meterSideCall, preCheck } from "~/modules/agent/credits/credit-meter"
import { autoTitleAgentChat } from "~/modules/agent/runtime/auto-title"
import { runSandboxedExtraction } from "~/modules/agent/tools/web-tools"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import { RESERVED_MODEL_DEFAULT } from "~/modules/demo/demo-spend-ceiling"
import { processMediaAnalysisJob } from "~/modules/files/media-analysis-job"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

/** The cheapest auto eligible model while this file runs, so every auto pick lands on it. */
const CHEAP_MODEL = "reserved-guards-cheapest"
const STUB_TEXT = "Stubbed model answer"

describe("the reserved demo org's guards outside a turn", () => {
  let reservedOrgId: string
  let normalOrgId: string
  let savedGoogleKey: string | undefined
  const realFetch = globalThis.fetch
  const modelCalls: string[] = []

  beforeAll(async () => {
    await acquireTestLock()
    reservedOrgId = (await minimal.secondOrg({ name: "Reserved Guards" })).orgId
    normalOrgId = (await minimal.secondOrg({ name: "Normal Guards" })).orgId
    await markOrgAsDemo(reservedOrgId, reservedMarker())
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${CHEAP_MODEL}, 'google', 'Cheapest', '0', '0', 1048576, 'starter', true),
             (${RESERVED_MODEL_DEFAULT}, 'google', 'Gemini Flash-Lite', '0.09', '0.35',
              1048576, 'starter', true)
      ON CONFLICT DO NOTHING`
    savedGoogleKey = process.env.GOOGLE_API_KEY
    process.env.GOOGLE_API_KEY = "google-reserved-guards-key"
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      modelCalls.push(url)
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { role: "model", parts: [{ text: STUB_TEXT }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (savedGoogleKey !== undefined) process.env.GOOGLE_API_KEY = savedGoogleKey
    else delete process.env.GOOGLE_API_KEY
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${CHEAP_MODEL}`
    await sql`DELETE FROM kernel.credit_transactions
              WHERE org_id IN (${reservedOrgId}, ${normalOrgId})`
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(async () => {
    modelCalls.length = 0
    invalidateDemoMarker()
    await clearRedisPatterns(["demo:*"])
  })

  it("media analysis job: refuses the reserved org before its pre check", async () => {
    DemoModeTestAccess.set(true)
    const run = async (orgId: string) => {
      const preCheckSpy = mock(async () => ({ allowed: false as const, reason: "stop here" }))
      const persisted: string[] = []
      await processMediaAnalysisJob(
        {
          fileId: crypto.randomUUID(),
          orgId,
          storageKey: `orgs/${orgId}/x/clip.mp4`,
          modelId: RESERVED_MODEL_DEFAULT,
          context: "",
          userId: crypto.randomUUID(),
        },
        {
          preCheck: preCheckSpy as never,
          privileged: (async (_o: string, reason: string) => {
            persisted.push(reason)
          }) as never,
        },
      )
      return { preChecked: preCheckSpy.mock.calls.length, persisted }
    }
    const reserved = await run(reservedOrgId)
    expect(reserved.preChecked).toBe(0)
    expect(reserved.persisted).toEqual(["files:analysis"])
    const normal = await run(normalOrgId)
    expect(normal.preChecked).toBe(1)
  })

  it("auto-title: the reserved org titles by heuristic, a normal org asks the model", async () => {
    DemoModeTestAccess.set(true)
    const titleFor = async (orgId: string) => {
      const threadId = await withPrivilegedDb(orgId, "guards-thread", async (tx) => {
        const [t] = await tx
          .insert(kernelThreads)
          .values({
            orgId,
            handle: `rg-${crypto.randomUUID().slice(0, 8)}`,
            type: "agent_chat",
            createdBy: (await minimal.orgAdmin(orgId)).id,
          })
          .returning({ id: kernelThreads.id })
        return t!.id
      })
      await autoTitleAgentChat({
        threadId,
        orgId,
        userMessage: "Quel est le chiffre du mois dernier",
        agentReply: "Voici le chiffre.",
        agentId: null,
      })
      const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${threadId}`
      return String(row?.title ?? "")
    }
    const reserved = await titleFor(reservedOrgId)
    expect(modelCalls).toEqual([])
    expect(reserved).not.toBe(STUB_TEXT)
    expect(reserved.length).toBeGreaterThan(0)

    const normal = await titleFor(normalOrgId)
    expect(modelCalls.length).toBe(1)
    expect(normal).toBe(STUB_TEXT)
  })

  it("sandbox extraction: the reserved org gets the raw page, a normal org the model's", async () => {
    DemoModeTestAccess.set(true)
    const page = `<p>price list ${crypto.randomUUID()}</p>`
    const reserved = await runSandboxedExtraction({
      webContent: page,
      extractionQuery: "the prices",
      orgId: reservedOrgId,
    })
    expect(modelCalls).toEqual([])
    expect(reserved).toContain(page)

    const normal = await runSandboxedExtraction({
      webContent: page,
      extractionQuery: "the prices",
      orgId: normalOrgId,
    })
    expect(modelCalls.length).toBe(1)
    expect(normal).toContain(STUB_TEXT)
    expect(normal).not.toContain(page)
  })

  it("side call settlement: the reserved org's lands in the ledger, a normal org's does not", async () => {
    DemoModeTestAccess.set(true)
    const credit = {
      model: {
        provider: "google",
        modelId: RESERVED_MODEL_DEFAULT,
        inputCostPerM: "0.09",
        outputCostPerM: "0.35",
        contextWindow: 1_048_576,
      },
      keySource: "liaison" as const,
    }
    const rows = async (orgId: string) => {
      const [r] = await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions
                            WHERE org_id = ${orgId} AND model = ${RESERVED_MODEL_DEFAULT}`
      return Number(r?.n ?? 0)
    }
    const before = { reserved: await rows(reservedOrgId), normal: await rows(normalOrgId) }
    await meterSideCall(reservedOrgId, credit, { inputTokens: 40, outputTokens: 2 })
    await meterSideCall(normalOrgId, credit, { inputTokens: 40, outputTokens: 2 })
    expect(await rows(reservedOrgId)).toBe(before.reserved + 1)
    expect(await rows(normalOrgId)).toBe(before.normal)
  })

  it("routine credit gate: hands the reserved org's reservation straight back", async () => {
    DemoModeTestAccess.set(true)
    const key = `demo:spend-reserve:${reservedOrgId}`
    // A bare pre check holds a reservation: what the gate must give back.
    const bare = await preCheck(reservedOrgId)
    expect(bare.allowed).toBe(true)
    expect(Number(await redis.get(key))).toBeGreaterThan(0)
    await redis.del(key)

    expect(await routineCreditGate(reservedOrgId)).toBeNull()
    expect(await redis.get(key)).toBeNull()

    expect(await routineCreditGate(normalOrgId)).toBeNull()
    expect(await redis.get(`demo:spend-reserve:${normalOrgId}`)).toBeNull()
  })
})
