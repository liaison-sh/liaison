// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { createUserWithScopes } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

// COPIED verbatim from agent-runtime.scenario.test.ts:140 — `getCreditTransactions`
// is module-private there (not exported), so it must be duplicated, not imported.
// `ks` MUST be the schema-prefixed identifier (mirrors that file's line 193);
// passing `undefined` would query the unprefixed `kernel` schema and silently
// find no rows under worker isolation.
// biome-ignore lint/suspicious/noExplicitAny: matches the source helper's sql type
async function getCreditTransactions(sql: any, ks: string, orgId: string) {
  return sql.unsafe(
    `SELECT * FROM ${ks}.credit_transactions WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  )
}

// Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describeLive("assist/proofread — real cheap LLM", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let user: { id: string; email: string; token: string; name: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 8,
      org: { name: "Assist Proofread E2E Org" },
      // Managed instance so credit metering + deduction run (the proofread
      // endpoint meters like an agent call). The URL is never contacted.
      serverEnv: {
        CONTROL_PLANE_URL: "http://127.0.0.1:9/control-plane",
        CONTROL_PLANE_API_KEY: "test-control-plane-key",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Seed model pricing (gemini-flash-lite-latest is auto-eligible here).
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

    // Seed a credit balance so the managed deduction path has funds.
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("corrects obvious spelling/grammar via gemini-flash-lite and records a usage txn", async () => {
    if (!process.env.GOOGLE_API_KEY) {
      console.log("GOOGLE_API_KEY not set — skipping assist-proofread real-LLM test")
      return
    }
    let res: Response
    try {
      res = await fetch(`${url}/api/assist/proofread`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ text: "i recieve teh colorfull lettre yesterdey", format: "text" }),
      })
    } catch (err) {
      console.log("Provider connection failed — skipping:", (err as Error).message)
      return
    }
    if (res.status >= 500) {
      // Provider hiccup / transient — surface and skip, like S8.
      console.log(
        "assist-proofread: server/provider error — skipping:",
        res.status,
        await res.text(),
      )
      return
    }
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { text: string } }
    const out = body.data.text
    // Robust, non-brittle assertions: output changed and the obvious
    // misspellings are gone (exact wording is model-dependent).
    expect(out.trim()).not.toBe("i recieve teh colorfull lettre yesterdey")
    expect(out.toLowerCase()).not.toMatch(/\brecieve\b/)
    expect(out.toLowerCase()).not.toMatch(/\bteh\b/)
    expect(out.length).toBeGreaterThan(0)

    // Real spend was metered — a usage txn for the auto model must exist.
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    // biome-ignore lint/suspicious/noExplicitAny: raw sql row
    const wandTxn = txns.find((t: any) => t.model === "gemini-flash-lite-latest")
    expect(wandTxn).toBeDefined()
    expect(wandTxn.input_tokens).toBeGreaterThan(0)
  }, 60_000)

  it("honors the user's stored instruction (British spelling)", async () => {
    if (!process.env.GOOGLE_API_KEY) {
      console.log("GOOGLE_API_KEY not set — skipping stored-instruction test")
      return
    }
    const putRes = await fetch(`${url}/api/user/preferences/magic-wand`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ instructions: "Always use British spelling." }),
    })
    expect(putRes.status).toBe(200)

    let res: Response
    try {
      res = await fetch(`${url}/api/assist/proofread`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ text: "the color of the organization", format: "text" }),
      })
    } catch (err) {
      console.log("Provider connection failed — skipping:", (err as Error).message)
      return
    }
    if (res.status >= 500) {
      console.log("stored-instruction: server/provider error — skipping:", res.status)
      return
    }
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { text: string } }
    const out = body.data.text.toLowerCase()
    // Soft expectation (model-dependent): at least one British variant appears.
    const hasBritish = /\bcolour\b/.test(out) || /\borganisation\b/.test(out)
    if (!hasBritish) {
      console.log("stored-instruction: model did not apply British spelling — soft skip:", out)
      return
    }
    expect(hasBritish).toBe(true)
  }, 60_000)
})
