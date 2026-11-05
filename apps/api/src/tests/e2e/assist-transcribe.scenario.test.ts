// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIVE voice dictation (S2, S3, S5): a real spontaneous-speech recording (an
// AMI Meeting Corpus clip, CC BY 4.0, fixtures/dictation/clips.json) through
// the real server, the org's real transcription model on OpenRouter and the
// wand's clean-up. Paid (well under a cent): live only (LIAISON_E2E_LIVE_LLM=1).
import { afterAll, beforeAll, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { createUserWithScopes } from "@liaison/test-helpers"
import { type MustKeep, normalizeWords, scoreCleanup } from "~/modules/assist/dictation-scorer"
import { describeLive } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

interface Clip {
  file: string
  language: string
  reference: string
  fillers: string[]
  /** One spelling, or the accepted spellings of one term (the fixture convention). */
  mustKeep: MustKeep[]
}

/** The chat model the org adds from OpenRouter and makes its Auto model. */
const CLEANUP_UPSTREAM_ID = "google/gemini-3.1-flash-lite"

const FIXTURES = join(import.meta.dir, "fixtures", "dictation")
const clip = (JSON.parse(readFileSync(join(FIXTURES, "clips.json"), "utf8")) as { clips: Clip[] })
  .clips[0]
const audio = readFileSync(join(FIXTURES, clip.file))

/** Lowercase words joined by single spaces, padded: phrase lookup by word boundary. */
function norm(s: string): string {
  return ` ${normalizeWords(s).join(" ")} `
}

describeLive("assist/transcribe — real speech, real models", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let user: { id: string; email: string; token: string; name: string }

  beforeAll(async () => {
    const result = await setupScenario({ seed: 9, org: { name: "Assist Transcribe E2E Org" } })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerM,
          model.outputCostPerM,
          model.contextWindow,
          model.autoEligible,
          model.tierMinimum,
          model.source,
        ],
      )
    }
    // An OpenRouter-only org (the only provider key in the live env) runs its
    // chat models from OpenRouter: the admin adds one and makes it Auto, as
    // the AI models page does. The clean-up side call then runs on it.
    const admin = {
      Authorization: `Bearer ${world.admin.token}`,
      "Content-Type": "application/json",
    }
    const added = await fetch(`${url}/api/settings/ai/openrouter/models`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ upstreamId: CLEANUP_UPSTREAM_ID }),
    })
    expect(added.status).toBe(201)
    const auto = await fetch(`${url}/api/settings/ai/models`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ autoModelKey: `openrouter/${CLEANUP_UPSTREAM_ID}` }),
    })
    expect(auto.status).toBe(200)
    user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  async function dictate(query: string) {
    const res = await fetch(`${url}/api/assist/transcribe${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "audio/webm;codecs=opus" },
      body: audio,
    })
    const body = (await res.json()) as {
      data?: {
        raw: string
        cleaned: string
        model: string
        cleanModel: string | null
        cleanError?: true
        durationSeconds: number | null
      }
      error?: { code: string; message: string }
    }
    return { status: res.status, body }
  }

  it("transcribes the clip on the org's OpenRouter model", async () => {
    expect(process.env.OPENROUTER_API_KEY ?? "").toMatch(/^sk-or-/)
    const { status, body } = await dictate(`?clean=false&language=${clip.language}`)
    expect(body.error ?? null).toBeNull()
    expect(status).toBe(200)
    const raw = body.data?.raw ?? ""
    expect(raw.length).toBeGreaterThan(0)
    for (const word of ["laura", "project manager"]) expect(norm(raw)).toContain(` ${word} `)
    expect(body.data?.model).toStartWith("openrouter/")
  }, 90_000)

  it("cleans it up: shorter, no fillers, every must-keep word kept", async () => {
    const { status, body } = await dictate(`?clean=true&language=${clip.language}`)
    expect(status).toBe(200)
    const data = body.data!
    expect(data.cleanError ?? null).toBeNull()
    expect(data.cleanModel).toBe(`openrouter/${CLEANUP_UPSTREAM_ID}`)
    expect(data.cleaned.length).toBeLessThan(data.raw.length)
    // The S5 scorer the bake-off uses: no annotated filler left, and every
    // must-keep term present (stricter than S5, which forgives a term the
    // transcription itself missed).
    const score = scoreCleanup({
      raw: data.raw,
      cleaned: data.cleaned,
      fillers: clip.fillers,
      mustKeep: clip.mustKeep,
    })
    expect(score.fillersRemaining).toEqual([])
    expect(score.mustKeepMissing).toEqual([])
  }, 90_000)
})
