// SPDX-License-Identifier: FSL-1.1-ALv2
// The signed Control→cell API (`/api/cloud/*`, managed edition only): every
// endpoint refuses an unsigned, mis-signed, stale, replayed or tampered request
// with a 401 and no side effect; `POST /orgs` is idempotent on (slug, owner
// email) and never renames; `POST /orgs/:id/handoff` mints a one-time sign-in
// link bound to the owner, the org and the org's host, confirmed by a click.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import type { AiModelsSettings } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ConsoleEmailProvider, getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { orgIdForSlug } from "~/lib/org-host"
import { redis } from "~/lib/redis"
import {
  resolveModelForPreCheck,
  selectAutoModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import * as catalogueModule from "~/modules/agent/credits/openrouter-catalogue"
import { OPENROUTER_CATALOGUE_CACHE_KEY } from "~/modules/agent/credits/openrouter-catalogue"
import { CREATE_ANSWER_BUDGET_MS, createCloudOrgWithinBudget } from "~/modules/cloud/create-org"
import { ensureManagedDefaultModels } from "~/modules/cloud/default-models"
import { CLOUD_CREATE_ORG_ENDPOINT, claimOutcome, completeOutcome } from "~/modules/cloud/outcomes"
import { CLOUD_RATE_LIMIT_PER_MINUTE } from "~/modules/cloud/verify"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { listMailProviders } from "~/modules/mail/provider-settings"
import { markOrgDeleting } from "~/modules/org/purge/deleting"
import { purgeOrg } from "~/modules/org/purge/purge-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "a1".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)
const WRONG_KEY = deriveControlToCellKey("b2".repeat(32))
const TEMPLATE = "https://{slug}.cells.test"
const CELL = "https://cell-1-origin.cells.test"

const mutableEnv = env as { LIAISON_EDITION?: string; LIAISON_ORG_HOST_TEMPLATE?: string }
const savedEdition = mutableEnv.LIAISON_EDITION
const savedTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE

const now = () => Math.floor(Date.now() / 1000)

interface SendOptions {
  key?: string
  messageId?: string
  ts?: number
  /** Sign this path instead of the one requested. */
  signPath?: string
  /** Sign this body instead of the one sent. */
  signBody?: string
  /** Replace the signed message id header after signing. */
  headerMessageId?: string
  unsigned?: boolean
}

/** One Control→cell request; returns the response and the exact headers sent. */
async function send(path: string, body: unknown, opts: SendOptions = {}) {
  const raw = JSON.stringify(body)
  const messageId = opts.messageId ?? randomUUID()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (!opts.unsigned) {
    Object.assign(
      headers,
      signControlRequest(opts.key ?? CONTROL_KEY, {
        method: "POST",
        path: opts.signPath ?? path,
        body: opts.signBody ?? raw,
        messageId,
        ts: opts.ts ?? now(),
      }),
    )
  }
  if (opts.headerMessageId) headers["x-control-message-id"] = opts.headerMessageId
  const res = await app.request(`${CELL}${path}`, { method: "POST", headers, body: raw })
  return { res, headers, raw, messageId }
}

async function resend(path: string, raw: string, headers: Record<string, string>) {
  return await app.request(`${CELL}${path}`, { method: "POST", headers, body: raw })
}

const orgBody = (over: Record<string, unknown> = {}) => ({
  slug: "acme-tools",
  name: "Acme Tools",
  ownerEmail: "Owner@Acme.test",
  ownerName: "Olive Owner",
  plan: "base",
  locale: "en",
  ...over,
})

async function counts() {
  const [o] = await sql`SELECT count(*)::int AS n FROM kernel.organizations`
  const [u] = await sql`SELECT count(*)::int AS n FROM kernel.users`
  const [r] = await sql`SELECT count(*)::int AS n FROM kernel.cloud_request_outcomes`
  return { orgs: o.n as number, users: u.n as number, outcomes: r.n as number }
}

async function createOrg(over: Record<string, unknown> = {}) {
  const { res } = await send("/api/cloud/orgs", orgBody(over))
  expect(res.status).toBe(200)
  return (await res.json()) as { ok: true; orgId: string; slug: string }
}

async function ownerId(email: string): Promise<string> {
  const [row] = await sql`SELECT id FROM kernel.users WHERE email = ${email.toLowerCase()}`
  return row.id as string
}

function verifyAt(host: string, body: Record<string, unknown>) {
  return app.request(`https://${host}/api/auth/magic-link/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function linkParams(url: string) {
  const u = new URL(url)
  return {
    host: u.host,
    challengeId: u.searchParams.get("challengeId") ?? "",
    token: u.searchParams.get("token") ?? "",
  }
}

beforeAll(async () => {
  await acquireTestLock()
  _setEdition(null)
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  await withSystemDb("test-cloud-identity", (db) => writeIdentity(db, identity))
})

afterAll(async () => {
  mutableEnv.LIAISON_EDITION = savedEdition
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  _setEdition(null)
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await withSystemDb("test-cloud-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(async () => {
  mutableEnv.LIAISON_EDITION = "managed"
  await clearRedisPatterns(["cloud:*", "magic:*", "magic-verify-rate:*"])
})

describe("self-hosted", () => {
  test("/api/cloud/* does not exist (404), even signed", async () => {
    mutableEnv.LIAISON_EDITION = "self_hosted"
    const before = await counts()
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "self-hosted-x" }))
    expect(res.status).toBe(404)
    const { res: handoff } = await send(`/api/cloud/orgs/${randomUUID()}/handoff`, {
      orgId: randomUUID(),
    })
    expect(handoff.status).toBe(404)
    expect(await counts()).toEqual(before)
  })
})

describe("401 matrix: POST /api/cloud/orgs", () => {
  const path = "/api/cloud/orgs"
  const body = () => orgBody({ slug: "matrix-org", ownerEmail: "matrix@acme.test" })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.cloud_request_outcomes`
  })

  const refused = async (run: () => Promise<Response>) => {
    const before = await counts()
    const res = await run()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: "unauthorized" })
    expect(await counts()).toEqual(before)
  }

  test("unsigned", () => refused(async () => (await send(path, body(), { unsigned: true })).res))
  test("bad signature (another key)", () =>
    refused(async () => (await send(path, body(), { key: WRONG_KEY })).res))
  test("stale ts (301 s old)", () =>
    refused(async () => (await send(path, body(), { ts: now() - 301 })).res))
  test("ts too far ahead (301 s)", () =>
    refused(async () => (await send(path, body(), { ts: now() + 301 })).res))
  test("swapped message id", () =>
    refused(async () => (await send(path, body(), { headerMessageId: randomUUID() })).res))
  test("swapped path (signed for another endpoint)", () =>
    refused(
      async () =>
        (await send(path, body(), { signPath: `/api/cloud/orgs/${randomUUID()}/handoff` })).res,
    ))
  test("tampered body", () =>
    refused(
      async () =>
        (await send(path, body(), { signBody: JSON.stringify(orgBody({ slug: "other-org" })) }))
          .res,
    ))
  test("swapped org id (body orgId differs from the one the signature covers)", () =>
    refused(
      async () =>
        (
          await send(path, body(), {
            signBody: JSON.stringify({ ...body(), orgId: randomUUID() }),
          })
        ).res,
    ))
  test("replay of the exact attempt", async () => {
    const first = await send(path, body())
    expect(first.res.status).toBe(200)
    await refused(() => resend(path, first.raw, first.headers))
  })
})

describe("401 matrix: POST /api/cloud/orgs/:id/handoff", () => {
  let orgId = ""
  let owner = ""
  const path = () => `/api/cloud/orgs/${orgId}/handoff`

  beforeAll(async () => {
    await clearRedisPatterns(["cloud:*"])
    ;({ orgId } = await createOrg({ slug: "handoff-matrix", ownerEmail: "hm@acme.test" }))
    owner = await ownerId("hm@acme.test")
  })

  const refused = async (run: () => Promise<Response>) => {
    const before = await counts()
    const res = await run()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: "unauthorized" })
    expect(await counts()).toEqual(before)
    // No challenge minted for the owner.
    expect(await redis.get(`magic:user:${owner}`)).toBeNull()
  }

  test("unsigned", () =>
    refused(async () => (await send(path(), { orgId }, { unsigned: true })).res))
  test("bad signature", () =>
    refused(async () => (await send(path(), { orgId }, { key: WRONG_KEY })).res))
  test("stale ts", () =>
    refused(async () => (await send(path(), { orgId }, { ts: now() - 301 })).res))
  test("swapped message id", () =>
    refused(async () => (await send(path(), { orgId }, { headerMessageId: randomUUID() })).res))
  test("swapped path (signed for another org's handoff)", () =>
    refused(
      async () =>
        (await send(path(), { orgId }, { signPath: `/api/cloud/orgs/${randomUUID()}/handoff` }))
          .res,
    ))
  test("tampered body", () =>
    refused(
      async () =>
        (await send(path(), { orgId }, { signBody: JSON.stringify({ orgId: randomUUID() }) })).res,
    ))
  test("swapped org id: a validly signed body naming another org than the path", async () => {
    const before = await counts()
    const { res } = await send(path(), { orgId: randomUUID() })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: "org_mismatch" })
    expect(await counts()).toEqual(before)
    expect(await redis.get(`magic:user:${owner}`)).toBeNull()
  })
  test("replay of the exact attempt mints nothing new", async () => {
    const first = await send(path(), { orgId })
    expect(first.res.status).toBe(200)
    const pointer = await redis.get(`magic:user:${owner}`)
    expect(pointer).not.toBeNull()
    const before = await counts()
    const res = await resend(path(), first.raw, first.headers)
    expect(res.status).toBe(401)
    expect(await counts()).toEqual(before)
    expect(await redis.get(`magic:user:${owner}`)).toBe(pointer)
  })
})

describe("POST /api/cloud/orgs creates the org (S7)", () => {
  beforeEach(async () => {
    await sql`DELETE FROM kernel.cloud_request_outcomes`
  })

  test("creates the org, its owner as an active passwordless admin, credits, tier and caps", async () => {
    const orgId = randomUUID()
    const { res } = await send(
      "/api/cloud/orgs",
      orgBody({
        orgId,
        slug: "fresh-org",
        ownerEmail: "Fresh@Acme.test",
        plan: "pro",
        locale: "fr",
        includedCredits: "33",
        caps: { seats: 3, storageGb: 5 },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, orgId, slug: "fresh-org" })
    const [org] =
      await sql`SELECT name, tier, default_locale, caps FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.name).toBe("Acme Tools")
    expect(org.tier).toBe("business")
    expect(org.default_locale).toBe("fr")
    expect(org.caps).toEqual({ seats: 3, storageGb: 5 })
    const users = await sql`
      SELECT u.email, u.status, u.password_hash, r.name AS role
      FROM kernel.users u
      JOIN kernel.user_roles ur ON ur.user_id = u.id
      JOIN kernel.roles r ON r.id = ur.role_id
      WHERE u.org_id = ${orgId}`
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      email: "fresh@acme.test",
      status: "active",
      password_hash: null,
      role: "admin",
    })
    const [credits] =
      await sql`SELECT included_balance::text AS inc FROM kernel.credit_balances WHERE org_id = ${orgId}`
    expect(Number(credits.inc)).toBe(33)
  })

  test("the same request twice (retry, and a new message id) returns the same org; one org", async () => {
    const before = await counts()
    const first = await send("/api/cloud/orgs", orgBody({ slug: "twice-org" }))
    expect(first.res.status).toBe(200)
    const firstBody = await first.res.json()
    // Control's retry: same message id, fresh ts.
    const retry = await send("/api/cloud/orgs", orgBody({ slug: "twice-org" }), {
      messageId: first.messageId,
      ts: now() + 1,
    })
    expect(retry.res.status).toBe(200)
    expect(await retry.res.json()).toEqual(firstBody)
    const again = await send("/api/cloud/orgs", orgBody({ slug: "twice-org" }))
    expect(again.res.status).toBe(200)
    expect(await again.res.json()).toEqual(firstBody)
    const after = await counts()
    expect(after.orgs).toBe(before.orgs + 1)
    expect(after.users).toBe(before.users + 1)
  })

  test("a retry never renames the org", async () => {
    const { orgId } = await createOrg({ slug: "keep-name", name: "Original" })
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "keep-name", name: "Renamed" }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { orgId: string }).orgId).toBe(orgId)
    const [org] = await sql`SELECT name FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.name).toBe("Original")
  })

  test("the same slug for a different owner → 409 slug_taken, no write", async () => {
    await createOrg({ slug: "taken-org", ownerEmail: "first@acme.test" })
    const before = await counts()
    const { res } = await send(
      "/api/cloud/orgs",
      orgBody({ slug: "taken-org", ownerEmail: "second@acme.test" }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: "slug_taken" })
    expect(await counts()).toEqual(before)
    const rows = await sql`SELECT 1 FROM kernel.users WHERE email = 'second@acme.test'`
    expect(rows).toHaveLength(0)
  })

  test("a slug an org already holds outside the cloud API → 409, no write", async () => {
    await seedOrgRow({ name: "Ops", slug: "existing-ops" })
    const before = await counts()
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "existing-ops" }))
    expect(res.status).toBe(409)
    expect(await counts()).toEqual(before)
  })

  test("a new org resolves on its host at once, even after its host was looked up before", async () => {
    // A request on the host before the org exists (the router or a browser
    // racing the signup) must not keep the new org unknown there.
    expect(await orgIdForSlug("early-org")).toBeNull()
    const { orgId } = await createOrg({ slug: "early-org" })
    expect(await orgIdForSlug("early-org")).toBe(orgId)
  })

  test("deleting the org frees its slug: the stored reply goes with it", async () => {
    const { orgId } = await createOrg({ slug: "gone-org", ownerEmail: "first@gone.test" })
    await markOrgDeleting(orgId)
    await purgeOrg(orgId, {
      reason: "test-cloud-purge",
      settle: false,
      verify: false,
      externalDeps: { deleteObjects: async () => 0 },
    })
    const rows = await sql`
      SELECT 1 FROM kernel.cloud_request_outcomes WHERE endpoint = 'POST /orgs' AND idem_key = 'gone-org'`
    expect(rows).toHaveLength(0)
    // Another owner may now take the slug, and gets a new org.
    const again = await createOrg({ slug: "gone-org", ownerEmail: "second@gone.test" })
    expect(again.orgId).not.toBe(orgId)
  })

  test("an invalid body → 400 invalid_request, no write", async () => {
    const before = await counts()
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "Bad Slug" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, code: "invalid_request" })
    expect(await counts()).toEqual(before)
  })

  test("past the per-minute budget, a signed request is refused (429); unsigned ones never count", async () => {
    const minute = Math.floor(Date.now() / 60_000)
    await redis.set(`cloud:rate:${minute}`, String(CLOUD_RATE_LIMIT_PER_MINUTE), "EX", 120)
    await redis.set(`cloud:rate:${minute + 1}`, String(CLOUD_RATE_LIMIT_PER_MINUTE), "EX", 120)
    const unsigned = await send("/api/cloud/orgs", orgBody(), { unsigned: true })
    expect(unsigned.res.status).toBe(401)
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "rate-org" }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ ok: false, code: "rate_limited" })
  })
})

describe("POST /api/cloud/orgs while another attempt is creating the same org", () => {
  beforeEach(async () => {
    await sql`DELETE FROM kernel.cloud_request_outcomes`
  })

  test("an attempt that died after the org's commit is finished by the resume, its apps and views included", async () => {
    const ownerEmail = "died@acme.test"
    const slug = "died-org"
    // The org committed; what ensureOrg does after that never ran. Its default views stand for
    // the tail: they are the one part nothing else heals later.
    const { orgId } = await ensureOrg({ slug, name: "Died", credits: { initial: "0" } })
    await sql`DELETE FROM kernel.saved_views WHERE org_id = ${orgId}`
    expect(await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, slug, ownerEmail)).toEqual({
      kind: "claimed",
      resumed: false,
    })
    await sql`
      UPDATE kernel.cloud_request_outcomes SET claimed_at = now() - interval '1 hour'
      WHERE endpoint = ${CLOUD_CREATE_ORG_ENDPOINT} AND idem_key = ${slug}`
    const { res } = await send("/api/cloud/orgs", orgBody({ slug, ownerEmail }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { orgId: string }).orgId).toBe(orgId)
    const [{ count: after }] = await sql`
      SELECT count(*)::int AS count FROM kernel.saved_views WHERE org_id = ${orgId}`
    expect(after).toBeGreaterThan(0)
  })

  test("a retry joins the running create and answers its reply, not 503", async () => {
    const ownerEmail = "join@acme.test"
    expect(await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, "join-org", ownerEmail)).toEqual({
      kind: "claimed",
      resumed: false,
    })
    const orgId = randomUUID()
    const finished = Bun.sleep(400).then(() =>
      completeOutcome(CLOUD_CREATE_ORG_ENDPOINT, "join-org", 200, {
        ok: true,
        orgId,
        slug: "join-org",
      }),
    )
    const { res } = await send("/api/cloud/orgs", orgBody({ slug: "join-org", ownerEmail }))
    await finished
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, orgId, slug: "join-org" })
  })

  test("past the answer budget it says busy, in time for the caller's deadline, and the work goes on", async () => {
    const ownerEmail = "slow@acme.test"
    const req = {
      slug: "slow-org",
      name: "Slow",
      ownerEmail,
      ownerName: "Slow",
      plan: "base" as const,
      locale: "en",
    }
    const realCatalogue = catalogueModule.getOpenRouterCatalogue
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = spyOn(catalogueModule, "getOpenRouterCatalogue").mockImplementation(async () => {
      await held
      return []
    })
    const defaults = env as { LIAISON_MANAGED_DEFAULT_MODELS?: string }
    const saved = defaults.LIAISON_MANAGED_DEFAULT_MODELS
    defaults.LIAISON_MANAGED_DEFAULT_MODELS = "vendor/held-model"
    try {
      const started = Date.now()
      const first = await createCloudOrgWithinBudget(req, 300)
      expect(first).toEqual({ status: 503, reply: { ok: false, code: "busy" } })
      expect(Date.now() - started).toBeLessThan(CREATE_ANSWER_BUDGET_MS)
      // The caller's retry joins; the first run finishes behind it and both read one org.
      const joined = createCloudOrgWithinBudget(req, 20_000)
      release()
      const second = await joined
      expect(second.status).toBe(200)
      const [{ n }] =
        await sql`SELECT count(*)::int AS n FROM kernel.organizations WHERE slug = 'slow-org'`
      expect(n).toBe(1)
    } finally {
      release()
      spy.mockRestore()
      defaults.LIAISON_MANAGED_DEFAULT_MODELS = saved
      expect(catalogueModule.getOpenRouterCatalogue).toBe(realCatalogue)
    }
  })

  test("the answer budget stays under the 10 s deadline of a sandbox call", () => {
    expect(CREATE_ANSWER_BUDGET_MS).toBeLessThanOrEqual(8_000)
  })
})

describe("POST /api/cloud/orgs gives the org the server's default models (D20)", () => {
  const MODEL = "deepseek/deepseek-v4.1-flash"
  const catalogueModel = (upstreamId: string, over: Record<string, unknown> = {}) => ({
    upstreamId,
    displayName: upstreamId,
    contextWindow: 128000,
    inputCostPerM: "0.10",
    outputCostPerM: "0.40",
    tools: true,
    reasoningEfforts: [],
    canDisableReasoning: false,
    ...over,
  })
  const defaultsEnv = env as { LIAISON_MANAGED_DEFAULT_MODELS?: string }
  const savedDefaults = defaultsEnv.LIAISON_MANAGED_DEFAULT_MODELS
  const savedKey = process.env.OPENROUTER_API_KEY

  beforeEach(async () => {
    await sql`DELETE FROM kernel.cloud_request_outcomes`
    process.env.OPENROUTER_API_KEY = "sk-or-test-platform-key"
    await redis.set(
      OPENROUTER_CATALOGUE_CACHE_KEY,
      JSON.stringify([
        catalogueModel(MODEL),
        catalogueModel("vendor/second-model"),
        catalogueModel("vendor/no-tools", { tools: false }),
      ]),
    )
  })

  afterAll(async () => {
    defaultsEnv.LIAISON_MANAGED_DEFAULT_MODELS = savedDefaults
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = savedKey
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
  })

  test("a new org's Auto resolves to the first configured model on its first chat", async () => {
    defaultsEnv.LIAISON_MANAGED_DEFAULT_MODELS = `${MODEL}, vendor/second-model,vendor/no-tools`
    const { orgId } = await createOrg({ slug: "models-org", ownerEmail: "models@acme.test" })
    expect(await selectAutoModelForOrg(orgId, "test")).toEqual({
      provider: "openrouter",
      modelId: `openrouter/${MODEL}`,
    })
    const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    const models = (row.settings as { ai?: { models?: AiModelsSettings } }).ai?.models ?? {}
    expect((models.added ?? []).map((m) => [m.upstreamId, m.enabled])).toEqual([
      [MODEL, true],
      ["vendor/second-model", true],
    ])
    // A resumed creation runs it again: nothing is added twice, Auto stays.
    const again = await ensureManagedDefaultModels(orgId)
    expect(again.auto).toBeNull()
    const [after] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    const afterModels = (after.settings as { ai?: { models?: AiModelsSettings } }).ai?.models
    expect(afterModels?.added?.length).toBe(2)
    expect(afterModels?.autoModelKey).toBe(models.autoModelKey)
  })

  test("a creation that could not read the catalogue still gives the org its models on its first chat", async () => {
    defaultsEnv.LIAISON_MANAGED_DEFAULT_MODELS = MODEL
    const down = spyOn(catalogueModule, "getOpenRouterCatalogue").mockRejectedValue(
      new Error("catalogue unreachable"),
    )
    let orgId = ""
    try {
      ;({ orgId } = await createOrg({ slug: "late-models-org", ownerEmail: "late@acme.test" }))
    } finally {
      down.mockRestore()
    }
    const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    const models = (row.settings as { ai?: { models?: AiModelsSettings } }).ai?.models ?? {}
    expect(models.autoModelKey).toBeUndefined()

    // The catalogue is back: the first turn adds the models and runs on Auto.
    const resolved = await resolveModelForPreCheck(orgId, null, { turn: true })
    expect("model" in resolved).toBe(true)
    expect(await selectAutoModelForOrg(orgId, "test")).toEqual({
      provider: "openrouter",
      modelId: `openrouter/${MODEL}`,
    })
  })

  test("without the setting a new org gets no model", async () => {
    defaultsEnv.LIAISON_MANAGED_DEFAULT_MODELS = undefined
    const { orgId } = await createOrg({ slug: "no-models-org", ownerEmail: "none@acme.test" })
    const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    const models = (row.settings as { ai?: { models?: AiModelsSettings } }).ai?.models ?? {}
    expect(models.added ?? []).toEqual([])
    expect(models.autoModelKey).toBeUndefined()
  })
})

describe("POST /api/cloud/orgs switches Gmail mailboxes on when the deployment has a Google client", () => {
  const googleEnv = env as { GMAIL_OAUTH_CLIENT_ID?: string; GMAIL_OAUTH_CLIENT_SECRET?: string }
  const savedId = googleEnv.GMAIL_OAUTH_CLIENT_ID
  const savedSecret = googleEnv.GMAIL_OAUTH_CLIENT_SECRET

  beforeEach(async () => {
    await sql`DELETE FROM kernel.cloud_request_outcomes`
  })

  afterAll(() => {
    googleEnv.GMAIL_OAUTH_CLIENT_ID = savedId
    googleEnv.GMAIL_OAUTH_CLIENT_SECRET = savedSecret
  })

  test("with the deployment Google client, Gmail is on for the new org", async () => {
    googleEnv.GMAIL_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com"
    googleEnv.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret"
    const { orgId } = await createOrg({ slug: "gmail-on-org", ownerEmail: "gmail-on@acme.test" })
    const [gmail] = await listMailProviders(orgId)
    expect(gmail).toMatchObject({
      id: "gmail",
      enabled: true,
      integrationConfigured: true,
      configurationSource: "deployment",
    })
  })

  test("without a Google client, Gmail stays off (nothing it could connect with)", async () => {
    googleEnv.GMAIL_OAUTH_CLIENT_ID = undefined
    googleEnv.GMAIL_OAUTH_CLIENT_SECRET = undefined
    const { orgId } = await createOrg({ slug: "gmail-off-org", ownerEmail: "gmail-off@acme.test" })
    const [gmail] = await listMailProviders(orgId)
    expect(gmail).toMatchObject({ id: "gmail", enabled: false, integrationConfigured: false })
  })
})

describe("POST /api/cloud/orgs/:id/handoff (S8)", () => {
  let orgId = ""
  const slug = "handoff-org"
  const host = "handoff-org.cells.test"
  const email = "handoff@acme.test"

  beforeAll(async () => {
    await clearRedisPatterns(["cloud:*"])
    ;({ orgId } = await createOrg({ slug, ownerEmail: email }))
  })

  const handoff = async (messageId?: string, ts?: number) => {
    const r = await send(`/api/cloud/orgs/${orgId}/handoff`, { orgId }, { messageId, ts })
    expect(r.res.status).toBe(200)
    const reply = (await r.res.json()) as { ok: true; url: string; expiresAt: string }
    return { ...reply, messageId: r.messageId }
  }

  test("returns a one-time link on the org's host that expires in 10 minutes", async () => {
    const before = Date.now()
    const reply = await handoff()
    const u = new URL(reply.url)
    expect(u.origin).toBe(`https://${host}`)
    expect(u.pathname).toBe("/login/magic")
    expect(u.searchParams.get("challengeId")).toBeTruthy()
    expect(u.searchParams.get("token")).toBeTruthy()
    const ttl = Date.parse(reply.expiresAt) - before
    expect(ttl).toBeGreaterThan(590_000)
    expect(ttl).toBeLessThanOrEqual(601_000)
  })

  test("the page first names the workspace and the account, and signs in only on Continue; second use refused", async () => {
    const { challengeId, token } = linkParams((await handoff()).url)
    const preview = await verifyAt(host, { challengeId, token })
    expect(preview.status).toBe(200)
    expect(preview.headers.get("set-cookie")).toBeNull()
    const { data } = (await preview.json()) as { data: Record<string, unknown> }
    expect(data).toEqual({
      confirmRequired: true,
      workspace: { name: "Acme Tools", slug },
      account: { email, name: "Olive Owner" },
    })

    const signedIn = await verifyAt(host, { challengeId, token, confirm: true })
    expect(signedIn.status).toBe(200)
    const body = (await signedIn.json()) as { data: { accessToken?: string } }
    expect(body.data.accessToken).toBeTruthy()
    expect(signedIn.headers.get("set-cookie") ?? "").toContain("liaison_rt")

    const again = await verifyAt(host, { challengeId, token, confirm: true })
    expect(again.status).toBe(401)
    expect(again.headers.get("set-cookie")).toBeNull()
  })

  test("verifying on any other host is refused, and the link still works on its own host", async () => {
    const { challengeId, token } = linkParams((await handoff()).url)
    // Another org's host reaches the verify route and is refused there (401);
    // a host that maps to no org never reaches it (the org-host gate, 404).
    for (const [other, status] of [
      ["other-org.cells.test", 401],
      ["cell-1-origin.cells.test", 404],
      ["localhost:3000", 404],
    ] as const) {
      const res = await verifyAt(other, { challengeId, token, confirm: true })
      expect(res.status).toBe(status)
      expect(res.headers.get("set-cookie")).toBeNull()
    }
    const ok = await verifyAt(host, { challengeId, token, confirm: true })
    expect(ok.status).toBe(200)
  })

  test("a handoff challenge refuses the 6-digit code path", async () => {
    const { challengeId, token } = linkParams((await handoff()).url)
    for (const code of ["000000", "123456"]) {
      const res = await verifyAt(host, { challengeId, code })
      expect(res.status).toBe(401)
    }
    const ok = await verifyAt(host, { challengeId, token, confirm: true })
    expect(ok.status).toBe(200)
  })

  test("a retry with the same message id returns the same link, stored encrypted, purged after 600 s", async () => {
    const first = await handoff()
    // Control's retry: same message id, fresh ts.
    const retry = await handoff(first.messageId, now() + 1)
    expect(retry.url).toBe(first.url)

    const rows = await sql`
      SELECT outcome_sealed, extract(epoch FROM expires_at - created_at)::int AS ttl
      FROM kernel.cloud_request_outcomes WHERE idem_key = ${first.messageId}`
    expect(rows).toHaveLength(1)
    const { token } = linkParams(first.url)
    expect(String(rows[0].outcome_sealed)).not.toContain(token)
    expect(rows[0].ttl).toBe(600)

    await sql`UPDATE kernel.cloud_request_outcomes
      SET expires_at = now() - interval '1 second' WHERE idem_key = ${first.messageId}`
    await handoff()
    const gone =
      await sql`SELECT 1 FROM kernel.cloud_request_outcomes WHERE idem_key = ${first.messageId}`
    expect(gone).toHaveLength(0)
  })

  test("a new message id mints a fresh link that supersedes the last", async () => {
    const first = linkParams((await handoff()).url)
    const second = linkParams((await handoff()).url)
    expect(second.challengeId).not.toBe(first.challengeId)
    const old = await verifyAt(host, { ...first, confirm: true })
    expect(old.status).toBe(401)
    const ok = await verifyAt(host, { ...second, confirm: true })
    expect(ok.status).toBe(200)
  })

  test("an unknown org → 404 not_found", async () => {
    const other = randomUUID()
    const { res } = await send(`/api/cloud/orgs/${other}/handoff`, { orgId: other })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, code: "not_found" })
  })
})

describe("emailed magic links keep one round trip", () => {
  test("a regular challenge needs no Continue, and is bound to the org's host too", async () => {
    const prev = getSystemEmailProvider()
    const capture = new ConsoleEmailProvider()
    setSystemEmailProvider(capture)
    try {
      const res = await app.request("https://handoff-org.cells.test/api/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "handoff@acme.test", orgSlug: "handoff-org" }),
      })
      expect(res.status).toBe(200)
    } finally {
      setSystemEmailProvider(prev)
    }
    const sent = capture.sent.at(-1)
    const link = (sent?.text ?? sent?.html ?? "").match(/https:\/\/[^\s"]+\/login\/magic\?[^\s"]+/)
    expect(link).not.toBeNull()
    const { host, challengeId, token } = linkParams((link?.[0] ?? "").replaceAll("&amp;", "&"))
    expect(host).toBe("handoff-org.cells.test")
    const foreign = await verifyAt("other-org.cells.test", { challengeId, token })
    expect(foreign.status).toBe(401)
    const res = await verifyAt(host, { challengeId, token })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken?: string } }
    expect(body.data.accessToken).toBeTruthy()
  })
})
