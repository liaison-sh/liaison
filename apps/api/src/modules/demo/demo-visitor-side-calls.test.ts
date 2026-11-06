// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo visitor's paid calls OUTSIDE a turn: dictation, and the side calls
// (compaction, checkpoint briefs, the magic wand, ticket summaries) that all
// take a `preCheck` and settle through `finalizeUsage({ demo })` or
// `meterSideCall`. Real gate, real Redis, real ledger; only the
// speech provider is a stub.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Drop the visitor reservation from `transcribe`'s `start`: the verified
//    dictation gets no key (resolveKey refuses) and the test fails.
//  * Drop the `credit.demo` branch from `meterSideCall`: the side
//    call's hold is never settled and the ledger stays at 0.
//  * Drop the `finally` settle from consolidation's `defaultFlush`: a
//    checkpoint flush that sent nothing keeps its step reservation, and the
//    visitor's ledger keeps a full step max with no call behind it.
//  * Drop the `finalizeUsage` from a metered `runMemoryFlush`: the flush that
//    ran is not recorded as the org's usage.
//  * Drop the visitor-without-a-meter check from `runMemoryFlush`: a
//    visitor's flush runs under another call's hold.
//  * Drop `UpstreamNoAnswerError` from `notServed`: a dictation whose
//    connection closed before any answer is billed at its reserved max.
//  * Drop the `signal.aborted` test in `callOpenRouter`: a dictation the
//    caller cut off after its audio left is released instead of billed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createServer, type Socket } from "node:net"
import { generateText } from "ai"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey, env } from "~/lib/env"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { CompactionTestAccess, runMemoryFlush } from "~/modules/agent/context/compaction"
import {
  finalizeUsage,
  meterSideCall,
  preCheck,
  visitorStepBase,
} from "~/modules/agent/credits/credit-meter"
import { flushRegion, type RegionMessage } from "~/modules/agent/memory/consolidation"
import { resolveSideCallModel } from "~/modules/agent/providers/side-call-model"
import { maximumSecondsOf } from "~/modules/assist/audio-duration"
import { defaultProofreadDeps } from "~/modules/assist/proofread-service"
import {
  defaultTranscribeDeps,
  type TranscribeDeps,
  TranscribeError,
  transcribe,
  UpstreamError,
} from "~/modules/assist/transcribe-service"
import { findTranscriptionModel } from "~/modules/assist/transcription-models"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import {
  DemoBudgetTestAccess,
  type DemoSpendIdentity,
  reserveVisitorStep,
  snapshot,
} from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { microEurOfUsd, visitorRequestInputMicroEur } from "~/modules/demo/demo-spend-ceiling"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

type EnvKey = keyof typeof env
function setEnv<K extends EnvKey>(key: K, value: (typeof env)[K]): () => void {
  const target = env as Record<K, (typeof env)[K]>
  const saved = target[key]
  target[key] = value
  return () => {
    target[key] = saved
  }
}

const BOX_KEY = "sk-or-box-key-side-calls"
const MODEL = findTranscriptionModel("openrouter/qwen/qwen3-asr-1.7b")

/** A sent call billed at what it held: its output, and its short request's input. */
function expectHeldInFull(used: number): void {
  expect(used).toBeGreaterThan(visitorStepBase())
  expect(used).toBeLessThanOrEqual(visitorStepBase() + visitorRequestInputMicroEur(1_000))
}

describe("a demo visitor's paid calls outside a turn", () => {
  let org: string
  let savedKey: string | undefined
  const identities = new Map<string, DemoSpendIdentity>()
  const restores: Array<() => void> = []

  beforeAll(async () => {
    await acquireTestLock()
    savedKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = BOX_KEY
    org = (await ensureOrg({ slug: "visitor-side-calls", name: "Visitor" })).orgId
    await markOrgAsDemo(org, visitorMarker(24))
    DemoBudgetTestAccess.setVerifiedIdentity(async (o) => identities.get(o) ?? null)
  })
  afterAll(async () => {
    DemoModeTestAccess.set(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    registerDemoAlertMailer(null)
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = savedKey
    await releaseTestLock()
  })
  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.()
    identities.clear()
    invalidateDemoMarker()
    await sql`UPDATE kernel.organizations SET settings = settings - 'providerKeys' WHERE id = ${org}::uuid`
    await sql`DELETE FROM kernel.demo_spend`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${org}::uuid`
    await clearRedisPatterns(["demo:*"])
  })

  function spendOn(): DemoSpendIdentity {
    DemoModeTestAccess.set(true)
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    restores.push(setEnv("LIAISON_DEMO_MAIL_CAPTURE", true))
    registerDemoAlertMailer(async () => {})
    const id = { emailNormalized: `side-${Date.now()}@example.com`, network: "192.0.2.0/24" }
    identities.set(org, id)
    return id
  }

  function dictationDeps(seen: { keys: string[] }): TranscribeDeps {
    if (!MODEL) throw new Error("model missing")
    return {
      ...defaultTranscribeDeps,
      resolvePlan: async () => ({ model: MODEL, hedge: null }),
      callProvider: async (call) => {
        seen.keys.push(call.apiKey)
        return { text: "bonjour", seconds: 4, costUsd: undefined }
      },
      clean: async (input) => ({ cleaned: input.text, cleanModel: null }),
      log: { warn: () => {}, error: () => {} },
    }
  }

  const clip = new Uint8Array(4_000)
  const dictate = (d: TranscribeDeps) =>
    transcribe(
      {
        orgId: org,
        userId: "system",
        audio: clip,
        contentType: "audio/webm",
        clean: false,
        signal: new AbortController().signal,
      },
      d,
    )

  it("meters a verified visitor's dictation on the box key through a reservation", async () => {
    const id = spendOn()
    const seen = { keys: [] as string[] }
    const result = await dictate(dictationDeps(seen))
    expect(result.raw).toBe("bonjour")
    expect(seen.keys).toEqual([BOX_KEY])
    // 4 seconds at the derivation block's worst price per second.
    expect((await snapshot(id)).usedMicroEur).toBe(4 * 7)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })

  it("refuses an unverified visitor's dictation with the code, and calls no provider", async () => {
    spendOn()
    identities.clear()
    const seen = { keys: [] as string[] }
    let refused: unknown = null
    try {
      await dictate(dictationDeps(seen))
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(TranscribeError)
    expect((refused as TranscribeError).code).toBe("demo_verification_required")
    expect(seen.keys).toEqual([])
  })

  it("lifts the cap for a visitor with its own OpenRouter key: its key, box spend 0", async () => {
    const id = spendOn()
    const encrypted = encryptSecret(
      "sk-or-visitor-own",
      byokEncryptionKey,
      CryptoContext.byokApiKey,
    )
    await withPrivilegedDb(org, "test-byok", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('providerKeys', jsonb_build_object('openrouter',
            jsonb_build_object('encrypted', ${encrypted}::text)))
        WHERE id = ${org}::uuid`)
    })
    const seen = { keys: [] as string[] }
    await dictate(dictationDeps(seen))
    expect(seen.keys).toEqual(["sk-or-visitor-own"])
    expect((await snapshot(id)).usedMicroEur).toBe(0)
  })

  it("runs a verified visitor on a MANAGED edition without the credit balance (zero by design)", async () => {
    const { _setEdition } = await import("~/lib/edition")
    spendOn()
    _setEdition("managed")
    // A demo org's balance is zero by design (zeroDemoOrgCredits).
    await sql`UPDATE kernel.credit_balances SET included_balance = 0, purchased_balance = 0
      WHERE org_id = ${org}::uuid`
    try {
      const seen = { keys: [] as string[] }
      await dictate(dictationDeps(seen))
      expect(seen.keys).toEqual([BOX_KEY])
      const credit = await preCheck(org, null, { turn: true })
      expect(credit.allowed).toBe(true)
      if (credit.allowed) await credit.demo?.finish(0)
    } finally {
      _setEdition(null)
    }
  })

  it("reserves a side call on the pin and settles it through finalizeUsage", async () => {
    const id = spendOn()
    const credit = await preCheck(org, null)
    if (!credit.allowed) throw new Error(credit.reason)
    expect(credit.providerKey).toBe(BOX_KEY)
    expect(credit.demo?.reservation).not.toBeNull()
    await finalizeUsage(org, {
      model: credit.model,
      inputTokens: 10_000,
      outputTokens: 500,
      keySource: credit.keySource,
      userId: "system",
      demo: credit.demo,
    })
    // 10,000 x 267,739 / 1e6 + 500 x 1,070,951 / 1e6, each rounded up.
    expect((await snapshot(id)).usedMicroEur).toBe(2_678 + 536)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })

  it("settles a checkpoint-style side call, and gives the hold back when it produced nothing", async () => {
    const id = spendOn()
    const used = await preCheck(org, null)
    if (!used.allowed) throw new Error(used.reason)
    await meterSideCall(org, used, { inputTokens: 1_000, outputTokens: 100 })
    expect((await snapshot(id)).usedMicroEur).toBe(268 + 108)
    const empty = await preCheck(org, null)
    if (!empty.allowed) throw new Error(empty.reason)
    await meterSideCall(org, empty, null)
    expect((await snapshot(id)).usedMicroEur).toBe(268 + 108)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })
  // What OpenRouter billed is what the visitor's budget and the org's usage both hold. A
  // checkpoint brief priced from its tokens at the catalogue price, and written to no usage
  // row, left the org ledger short of the key's bill (live demo, 2026-10-24).
  it("settles a side call at the cost OpenRouter reported, and records it as the org's usage", async () => {
    const id = spendOn()
    const credit = await preCheck(org, null)
    if (!credit.allowed) throw new Error(credit.reason)
    const reportedUsd = 0.00123
    await meterSideCall(
      org,
      credit,
      { inputTokens: 100_000, outputTokens: 2_000 },
      { openrouter: { usage: { cost: reportedUsd } } },
    )
    expect((await snapshot(id)).usedMicroEur).toBe(microEurOfUsd(reportedUsd))
    const rows = await sql<{ input_tokens: number; raw_cost: string }[]>`
      SELECT input_tokens, raw_cost FROM kernel.credit_transactions WHERE org_id = ${org}::uuid`
    expect(rows.length).toBe(1)
    expect(rows[0]?.input_tokens).toBe(100_000)
    // raw_cost is in EUR: the reported dollars at the pricing sync's rate, never the tokens'
    // catalogue estimate (100,000 x 0.30 USD/M alone would be 0.03 USD).
    expect(Number(rows[0]?.raw_cost)).toBeGreaterThan(0)
    expect(Number(rows[0]?.raw_cost)).toBeLessThan(reportedUsd * 1.5)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })

  it("records a visitor's side call on its OWN key as the org's usage too, with no box spend", async () => {
    const id = spendOn()
    await withPrivilegedDb(org, "test-set-byok", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('providerKeys',
          jsonb_build_object('openrouter', jsonb_build_object('encrypted',
            ${encryptSecret("sk-or-visitor-own", byokEncryptionKey, CryptoContext.byokApiKey)}::text)))
        WHERE id = ${org}::uuid`)
    })
    invalidateDemoMarker()
    const credit = await preCheck(org, null)
    if (!credit.allowed) throw new Error(credit.reason)
    expect(credit.keySource).toBe("byok")
    expect(credit.demo).toBeUndefined()
    await meterSideCall(
      org,
      credit,
      { inputTokens: 5_000, outputTokens: 100 },
      { openrouter: { usage: { cost: 0.0004 } } },
    )
    const rows = await sql<{ type: string; input_tokens: number }[]>`
      SELECT type, input_tokens FROM kernel.credit_transactions WHERE org_id = ${org}::uuid`
    expect(rows.map((r) => ({ type: r.type, input_tokens: r.input_tokens }))).toEqual([
      { type: "byok_usage", input_tokens: 5_000 },
    ])
    expect((await snapshot(id)).usedMicroEur).toBe(0)
  })

  // ── A SENT REQUEST IS BILLED ─────────────────────────────────────────────

  /** A stub OpenRouter: hangs every request (`hang`) or answers 500. */
  function stubOpenRouter(mode: "hang" | "error") {
    const saved = process.env.OPENROUTER_BASE_URL
    let requests = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++
        if (mode === "error") return new Response("upstream down", { status: 500 })
        return new Promise<Response>(() => {})
      },
    })
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`
    restores.push(() => {
      server.stop(true)
      if (saved === undefined) delete process.env.OPENROUTER_BASE_URL
      else process.env.OPENROUTER_BASE_URL = saved
    })
    return { requests: () => requests }
  }

  it("bills a magic-wand call aborted after it was sent at its reserved max", async () => {
    const id = spendOn()
    const upstream = stubOpenRouter("hang")
    const abort = new AbortController()
    setTimeout(() => abort.abort("client went away"), 300)
    let failed: unknown = null
    try {
      await defaultProofreadDeps.complete({
        system: "fix it",
        prompt: "helo wrld",
        orgId: org,
        userId: "system",
        signal: abort.signal,
        maxRetries: 0,
      })
    } catch (err) {
      failed = err
    }
    expect(failed).not.toBeNull()
    expect(upstream.requests()).toBe(1)
    expectHeldInFull((await snapshot(id)).usedMicroEur)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })

  it("bills a checkpoint-style side call whose provider failed after the send at its max", async () => {
    const id = spendOn()
    const upstream = stubOpenRouter("error")
    const credit = await preCheck(org, null)
    if (!credit.allowed) throw new Error(credit.reason)
    const model = await resolveSideCallModel(credit)
    await generateText({ model, prompt: "brief", maxRetries: 0 }).catch(() => undefined)
    expect(upstream.requests()).toBe(1)
    // The caller read no usage (what checkpoint.ts does on a failure).
    await meterSideCall(org, credit, null)
    expectHeldInFull((await snapshot(id)).usedMicroEur)
  })

  function failingDictation(err: unknown): TranscribeDeps {
    if (!MODEL) throw new Error("model missing")
    return {
      ...dictationDeps({ keys: [] }),
      callProvider: async () => {
        throw err
      },
    }
  }

  it("bills a dictation aborted after its audio was sent at its reserved max", async () => {
    const id = spendOn()
    await dictate(failingDictation(new DOMException("aborted", "AbortError"))).catch(
      () => undefined,
    )
    const reserved = Math.ceil(maximumSecondsOf(clip.byteLength, "audio/webm")) * 7
    expect((await snapshot(id)).usedMicroEur).toBe(reserved)
  })

  it("releases a dictation OpenRouter refused (4xx): nothing was billed", async () => {
    const id = spendOn()
    await dictate(failingDictation(new UpstreamError(400, "bad audio"))).catch(() => undefined)
    expect((await snapshot(id)).usedMicroEur).toBe(0)
  })

  // ── A DICTATION IS RESERVED ON ITS BYTES ─────────────────────────────────

  /** A WAV whose header says 1 s of 16 kB/s audio, followed by `extra` bytes. */
  function wavClaimingOneSecond(extra: number): Uint8Array {
    const out = new Uint8Array(44 + extra)
    const view = new DataView(out.buffer)
    const tag = (at: number, s: string) => {
      for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i)
    }
    tag(0, "RIFF")
    view.setUint32(4, 36 + extra, true)
    tag(8, "WAVE")
    tag(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 8_000, true)
    view.setUint32(28, 16_000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    tag(36, "data")
    view.setUint32(40, 16_000, true)
    return out
  }

  function dictateWav(audio: Uint8Array, d: TranscribeDeps) {
    return transcribe(
      {
        orgId: org,
        userId: "system",
        audio,
        contentType: "audio/wav",
        clean: false,
        signal: new AbortController().signal,
      },
      d,
    )
  }

  it("reserves a large upload whose header claims 1 s at what its bytes can hold", async () => {
    const id = spendOn()
    const reserved: number[] = []
    const seen = { keys: [] as string[] }
    const base = dictationDeps(seen)
    const d: TranscribeDeps = {
      ...base,
      // The provider reports neither seconds nor cost.
      callProvider: async () => ({ text: "bonjour", seconds: null, costUsd: undefined }),
      spend: {
        ...base.spend,
        reserveVisitorStep: async (o, u, max, who) => {
          reserved.push(max)
          return reserveVisitorStep(o, u, max, who)
        },
      },
    }
    const audio = wavClaimingOneSecond(1_500_000)
    await dictateWav(audio, d)
    const bound = Math.ceil(maximumSecondsOf(audio.byteLength, "audio/wav")) * 7
    expect(reserved).toEqual([bound])
    expect(bound).toBeGreaterThan(1_000 * 7)
    expect((await snapshot(id)).usedMicroEur).toBe(bound)
  })

  it("refuses an upload whose bytes could hold more than the reservation cap, before any call", async () => {
    spendOn()
    let calls = 0
    const d: TranscribeDeps = {
      ...dictationDeps({ keys: [] }),
      callProvider: async () => {
        calls++
        return { text: "x", seconds: 1, costUsd: undefined }
      },
    }
    const err = await dictateWav(wavClaimingOneSecond(3_000_000), d).catch((e) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect((err as TranscribeError).code).toBe("too_large")
    expect(calls).toBe(0)
  })

  // ── WHAT IS NOT BILLED IS NOT COUNTED ───────────────────────────────────

  /** An OpenRouter that reads the request and closes the connection without answering. */
  async function closingOpenRouter(): Promise<{ requests: () => number }> {
    const saved = process.env.OPENROUTER_BASE_URL
    let requests = 0
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once("data", () => {
        requests++
        setTimeout(() => socket.destroy(), 20)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`
    restores.push(() => {
      for (const s of sockets) s.destroy()
      server.close()
      if (saved === undefined) delete process.env.OPENROUTER_BASE_URL
      else process.env.OPENROUTER_BASE_URL = saved
    })
    return { requests: () => requests }
  }

  function openRouterDictation(): TranscribeDeps {
    return { ...dictationDeps({ keys: [] }), callProvider: defaultTranscribeDeps.callProvider }
  }

  it("releases a dictation whose connection closed before OpenRouter answered", async () => {
    const id = spendOn()
    const upstream = await closingOpenRouter()
    const err = await dictate(openRouterDictation()).catch((e) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect(upstream.requests()).toBe(1)
    expect((await snapshot(id)).usedMicroEur).toBe(0)
    expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
  })

  it("still bills a dictation the caller cut off after its audio left at its reserved max", async () => {
    const id = spendOn()
    const upstream = stubOpenRouter("hang")
    const abort = new AbortController()
    setTimeout(() => abort.abort("client went away"), 300)
    await transcribe(
      {
        orgId: org,
        userId: "system",
        audio: clip,
        contentType: "audio/webm",
        clean: false,
        signal: abort.signal,
      },
      openRouterDictation(),
    ).catch(() => undefined)
    expect(upstream.requests()).toBe(1)
    const reserved = Math.ceil(maximumSecondsOf(clip.byteLength, "audio/webm")) * 7
    expect((await snapshot(id)).usedMicroEur).toBe(reserved)
  })

  function visitorRegion(): RegionMessage[] {
    return [
      {
        id: crypto.randomUUID(),
        content: "The Tuesday pickup window moved to 16:00.",
        createdAt: new Date(),
        requiredScopes: [],
        disclosureList: null,
        authorType: "user",
        authorId: null,
      },
      {
        id: crypto.randomUUID(),
        content: "Noted.",
        createdAt: new Date(),
        requiredScopes: [],
        disclosureList: null,
        authorType: "agent",
        authorId: null,
      },
    ]
  }

  // Live demo, 2026-10-27: each checkpoint advance of a visitor's thread flushed its region
  // through a pre check whose step reservation nothing settled. The hold expired counted at
  // its worst cost: two advances put 2 x 28,381 µEUR on one visitor with no call behind them.
  async function withFlushAgent(run: (agentId: string, threadId: string) => Promise<void>) {
    const agentId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const tag = agentId.slice(0, 8)
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${agentId}, ${org}, 'role', ${`flushvis${tag}`}, 'Flush', '["*"]'::jsonb)`
    try {
      await run(agentId, threadId)
    } finally {
      CompactionTestAccess.setMemoryFlushGenerate()
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${org}::uuid`
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${org}::uuid AND agent_id = ${agentId}::uuid`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}::uuid`
    }
  }

  it("gives a checkpoint flush's hold back when the flush sent nothing", async () => {
    const id = spendOn()
    await withFlushAgent(async (agentId, threadId) => {
      let generated = 0
      // The flush runs without a model call (the seam stands in for one that wrote nothing).
      CompactionTestAccess.setMemoryFlushGenerate(async () => {
        generated++
      })
      const result = await flushRegion(
        { orgId: org, agentId, threadId, closeReason: "checkpoint" },
        visitorRegion(),
      )
      expect(result.flushed).toBe(true)
      expect(generated).toBe(1)
      expect((await snapshot(id)).usedMicroEur).toBe(0)
      expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
    })
  })

  it("settles a visitor's checkpoint flush at what OpenRouter billed, and records it", async () => {
    const id = spendOn()
    const saved = process.env.OPENROUTER_BASE_URL
    const costUsd = 0.00031
    let requests = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++
        return Response.json({
          id: "gen-flush",
          object: "chat.completion",
          created: 1,
          model: "deepseek/deepseek-v4.1-flash-1017",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Nothing durable to save." },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 12,
            total_tokens: 1_212,
            cost: costUsd,
          },
        })
      },
    })
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`
    restores.push(() => {
      server.stop(true)
      if (saved === undefined) delete process.env.OPENROUTER_BASE_URL
      else process.env.OPENROUTER_BASE_URL = saved
    })
    await withFlushAgent(async (agentId, threadId) => {
      const result = await flushRegion(
        { orgId: org, agentId, threadId, closeReason: "checkpoint" },
        visitorRegion(),
      )
      expect(result.flushed).toBe(true)
      expect(requests).toBe(1)
      expect((await snapshot(id)).usedMicroEur).toBe(microEurOfUsd(costUsd))
      expect(await redis.keys(`${REDIS_PREFIX}demo:b:r:*`)).toEqual([])
      const rows = await sql<{ input_tokens: number }[]>`
        SELECT input_tokens FROM kernel.credit_transactions WHERE org_id = ${org}::uuid`
      expect(rows.map((r) => r.input_tokens)).toEqual([1_200])
    })
  })

  it("runs no visitor memory flush without a meter of its own (compaction's summary hold)", async () => {
    spendOn()
    let generated = 0
    CompactionTestAccess.setMemoryFlushGenerate(async () => {
      generated++
    })
    // The summary's pre check, passed on WITHOUT its demo meter (as runCompaction does).
    const credit = await preCheck(org, null)
    if (!credit.allowed) throw new Error(credit.reason)
    try {
      const ran = await runMemoryFlush({
        orgId: org,
        actor: { actorType: "system", orgId: org, purpose: "job", scopes: ["*"] },
        model: null,
        tainted: false,
        messages: [{ role: "user", content: "remember this" }],
        inputBudgetTokens: 10_000,
        requiredScopes: [],
        credit: { model: credit.model, keySource: credit.keySource },
      })
      expect(ran).toBe(false)
      expect(generated).toBe(0)
    } finally {
      CompactionTestAccess.setMemoryFlushGenerate()
      await meterSideCall(org, credit, null)
    }
  })
})
