// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step stopped mid-stream is billed by OpenRouter but never reports its usage
// to the turn. The OpenRouter model names the generation, and its cost is read
// from OpenRouter's record into the org's usage (live demo, 2026-10-24: the org
// ledger fell short of the key's bill by such steps).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the abort listener in `unreportedGenerationFetch`: a stopped stream
//    names nothing and the first test fails.
//  * Report every stream: the completed stream's test fails.
//  * Write the row from the tokens instead of `total_cost`: the ledger test fails.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { streamText } from "ai"
import { sql } from "~/db"
import { createOpenRouterModel } from "~/modules/agent/providers/openrouter"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  recordUnreportedGenerations,
  UnreportedGenerationsTestAccess,
} from "./unreported-generations"

const MODEL = "deepseek/deepseek-v4.1-flash"
const STOPPED_ID = "gen-stopped-1"
const DONE_ID = "gen-done-1"
const RECORDED_COST_USD = 0.0042

function chunk(id: string, body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: MODEL, ...body })}\n\n`
}

describe("a stream stopped before its usage", () => {
  let server: ReturnType<typeof Bun.serve>
  let savedBase: string | undefined
  let savedDelays: number[]
  let orgId: string
  let generationReads = 0

  beforeAll(async () => {
    await acquireTestLock()
    savedDelays = UnreportedGenerationsTestAccess.delays
    UnreportedGenerationsTestAccess.delays = [50, 50]
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/generation")) {
          generationReads++
          // The record appears only on the second read, as it does seconds after a stop.
          if (generationReads === 1) return new Response("not yet", { status: 404 })
          return Response.json({
            data: {
              id: url.searchParams.get("id"),
              total_cost: RECORDED_COST_USD,
              native_tokens_prompt: 1_200,
              native_tokens_completion: 30,
            },
          })
        }
        const body = (await req.json()) as { messages: Array<{ content: unknown }> }
        const done = JSON.stringify(body.messages).includes("finish")
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const id = done ? DONE_ID : STOPPED_ID
            controller.enqueue(
              encoder.encode(
                chunk(id, {
                  choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
                }),
              ),
            )
            if (!done) return // hangs: the caller stops it
            controller.enqueue(
              encoder.encode(
                chunk(id, {
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 1,
                    total_tokens: 11,
                    cost: 0.00001,
                  },
                }),
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    savedBase = process.env.OPENROUTER_BASE_URL
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`
    orgId = (await ensureOrg({ slug: "unreported-generations", name: "Unreported" })).orgId
    // ensureOrg installs every app: past the 5 s hook default on a loaded machine.
  }, 60_000)

  afterAll(async () => {
    server?.stop(true)
    UnreportedGenerationsTestAccess.delays = savedDelays
    if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL
    else process.env.OPENROUTER_BASE_URL = savedBase
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${orgId}::uuid`
    await releaseTestLock()
  })

  async function run(prompt: string, stopAfterFirstText: boolean): Promise<string[]> {
    const heard: string[] = []
    const model = createOpenRouterModel("sk-or-test-key", MODEL, {
      onUnreportedGeneration: (id) => heard.push(id),
    })
    const abort = new AbortController()
    const result = streamText({ model, prompt, abortSignal: abort.signal, maxRetries: 0 })
    try {
      for await (const part of result.fullStream) {
        if (stopAfterFirstText && part.type === "text-delta") abort.abort("timeout")
      }
    } catch {
      // the stop
    }
    await Bun.sleep(20)
    return heard
  }

  it("names the generation of a stream the caller stopped before its usage", async () => {
    expect(await run("stop me", true)).toEqual([STOPPED_ID])
  })

  it("names nothing for a stream that reported its usage", async () => {
    expect(await run("finish please", false)).toEqual([])
  })

  it("writes the stopped generation's usage row at the cost OpenRouter recorded", async () => {
    await recordUnreportedGenerations(orgId, {
      generationIds: [STOPPED_ID, STOPPED_ID],
      apiKey: "sk-or-test-key",
      modelId: `openrouter/${MODEL}`,
      keySource: "byok",
      userId: "system",
    })
    const rows = await sql<{ input_tokens: number; output_tokens: number; raw_cost: string }[]>`
      SELECT input_tokens, output_tokens, raw_cost FROM kernel.credit_transactions
      WHERE org_id = ${orgId}::uuid`
    // Once, though named twice; read again after the record was not there yet.
    expect(rows.length).toBe(1)
    expect(generationReads).toBe(2)
    expect(rows[0]?.input_tokens).toBe(1_200)
    expect(rows[0]?.output_tokens).toBe(30)
    // raw_cost is EUR: the recorded dollars at the pricing sync's rate (about 1.0 to 1.3).
    const eur = Number(rows[0]?.raw_cost)
    expect(eur).toBeGreaterThan(RECORDED_COST_USD / 1.4)
    expect(eur).toBeLessThan(RECORDED_COST_USD)
  })
})
