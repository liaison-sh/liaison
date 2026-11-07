// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ai_models_get` / `ai_models_set` through the real tool path: the read leaks
// no key hint, a change parks one approval card, and once approved it runs the
// settings page's own checks (ai-models-routes.test.ts covers those in depth).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { OPENROUTER_CATALOGUE_CACHE_KEY } from "~/modules/agent/credits/openrouter-catalogue"
import {
  aiModelsSetRefusal,
  handleAiModelsGet,
  handleAiModelsSet,
} from "~/modules/agent/tools/ai-models-tools"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { testCallRateLimitKey } from "~/modules/settings/ai-models-admin"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import {
  type OpenAICompatibleStub,
  STUB_OPENROUTER_CATALOGUE,
  startOpenAICompatibleStub,
} from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const UPSTREAM = STUB_OPENROUTER_CATALOGUE[0]!.id
const KEY = `openrouter/${UPSTREAM}`
const ENV_VARS = ["OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "GOOGLE_API_KEY"]

let admin: minimal.Session
let threadId: string
let stub: OpenAICompatibleStub
const savedEnv: Record<string, string | undefined> = {}

async function orgModels(): Promise<any> {
  const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${admin.orgId}`
  return (row?.settings as { ai?: { models?: unknown } })?.ai?.models ?? {}
}

const agentCall = (params: unknown, scopes: string[] = ["*"]) =>
  executeToolCore({
    toolName: "kernel:ai_models_set",
    orgId: admin.orgId,
    actor: {
      actorType: "user" as const,
      userId: admin.userId,
      orgId: admin.orgId,
      scopes,
      dimensionGrants: {},
    },
    params,
    threadId,
    origin: "in-app-agent",
  })

describe("ai_models_get and ai_models_set", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ENV_VARS) savedEnv[k] = process.env[k]
    stub = startOpenAICompatibleStub({ catalogue: STUB_OPENROUTER_CATALOGUE })
    process.env.OPENROUTER_BASE_URL = `${stub.url}/api/v1`
    process.env.OPENROUTER_API_KEY = "test-placeholder-openrouter"
    process.env.GOOGLE_API_KEY = "test-placeholder-google"
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    admin = await minimal.adminSession((await createTestOrg()).id)
    threadId = await minimal.thread(admin.orgId, admin.userId)
    await ensureAppsForOrg(admin.orgId)
    await redis.del(testCallRateLimitKey(admin.orgId))
  })

  afterAll(async () => {
    stub.stop()
    for (const k of ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    await releaseTestLock()
  })

  it("reads the settings and searches OpenRouter, with no key hint", async () => {
    const res: any = await handleAiModelsGet({ openRouterSearch: "deepseek" }, admin)
    expect(res.auto.modelKey).toBeNull()
    expect(res.openRouter.models.map((m: any) => m.upstreamId)).toContain(UPSTREAM)
    expect(res.openRouter.models[0].added).toBe(false)
    expect(JSON.stringify(res)).not.toContain("maskedHint")
  })

  it("on a managed cell a read carries a multiplier against Auto, never a price", async () => {
    _setEdition("managed")
    try {
      const res: any = await handleAiModelsGet({ openRouterSearch: "deepseek" }, admin)
      expect(res.openRouter.models.length).toBeGreaterThan(0)
      for (const m of [...res.models, ...res.openRouter.models]) {
        expect(m).toHaveProperty("multiplier")
        expect(m).not.toHaveProperty("inputCostPerM")
        expect(m).not.toHaveProperty("outputCostPerM")
      }
    } finally {
      _setEdition(null)
    }
  })

  it("an agent's change parks one approval card and changes nothing yet", async () => {
    const res = await agentCall({ defaultReasoningLevel: "low" })
    expect("blocked" in res).toBe(true)
    const [card] = await sql`
      SELECT summary FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:ai_models_set' AND status = 'pending'`
    expect(String(card?.summary?.title ?? "")).toBe("Change the organization's AI models")
    expect(JSON.stringify(card?.summary?.lines)).toContain("Default reasoning level: low.")
    expect((await orgModels()).defaultReasoningLevel).toBeUndefined()
  })

  it("is not offered to someone without kernel:org:admin", async () => {
    const res = await agentCall({ defaultReasoningLevel: "low" }, ["kernel:threads:read"])
    expect("blocked" in res).toBe(false)
    expect((await orgModels()).defaultReasoningLevel).toBeUndefined()
  })

  it("answers an empty request at once", async () => {
    expect(await aiModelsSetRefusal({}, admin)).toMatchObject({ code: "nothing_to_change" })
    expect(await aiModelsSetRefusal({ defaultReasoningLevel: "low" }, admin)).toBeNull()
  })

  it("adds a model after its test call, makes it Auto and sets the level in one call", async () => {
    const res: any = await handleAiModelsSet(
      { addFromOpenRouter: UPSTREAM, autoModelKey: KEY, defaultReasoningLevel: "high" },
      admin,
    )
    expect(res).toMatchObject({ added: KEY, autoModelKey: KEY, defaultReasoningLevel: "high" })
    const models = await orgModels()
    expect(models.autoModelKey).toBe(KEY)
    expect(models.defaultReasoningLevel).toBe("high")
    expect(models.added.map((m: any) => m.key)).toEqual([KEY])
  })

  it("adding a model already in the list is not an error", async () => {
    const res: any = await handleAiModelsSet({ addFromOpenRouter: UPSTREAM }, admin)
    expect(res).toEqual({ added: null })
  })

  it("keeps the page's refusals", async () => {
    expect(await handleAiModelsSet({ enable: ["no-such-model"] }, admin)).toMatchObject({
      code: "unknown_model",
    })
    expect(await handleAiModelsSet({ disable: [KEY] }, admin)).toMatchObject({
      code: "auto_model",
    })
    expect((await orgModels()).autoModelKey).toBe(KEY)
  })
})
