// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import pino from "pino"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { aiKeysRoutes } from "~/modules/settings/ai-keys-routes"

const NO_KEY_ORG = "00000000-0000-0000-0000-0000000a0001"
const WITH_KEY_ORG = "00000000-0000-0000-0000-0000000a0002"
const SAVE_ORG = "00000000-0000-0000-0000-0000000a0003"

function testApp(orgId: string, scopes: string[] = ["kernel:org:admin"]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-0000000a00ff")
    c.set("orgId", orgId)
    c.set("scopes", scopes as any)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/settings/ai/keys", aiKeysRoutes)
  return app
}

const realFetch = globalThis.fetch

describe("ai-keys routes — re-validate", () => {
  beforeAll(async () => {
    const encrypted = encryptSecret(
      "sk-stored-anthropic",
      byokEncryptionKey,
      CryptoContext.byokApiKey,
    )
    const settings = JSON.stringify({
      providerKeys: {
        anthropic: {
          encrypted,
          maskedHint: "ropic",
          validatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${NO_KEY_ORG}, 'AiKeys NoKey', 'aikeys-nokey') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${WITH_KEY_ORG}, 'AiKeys WithKey', 'aikeys-withkey', ${settings}::jsonb) ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.organizations WHERE id IN (${NO_KEY_ORG}, ${WITH_KEY_ORG})`
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("returns 404 when no key is stored for the provider", async () => {
    const res = await testApp(NO_KEY_ORG).request("/api/settings/ai/keys/openai/validate", {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })

  it("re-validates a stored key and refreshes validatedAt", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch

    const before = await testApp(WITH_KEY_ORG).request("/api/settings/ai/keys")
    const beforeList = (
      (await before.json()) as {
        data: Array<{ provider: string; validatedAt: string }>
      }
    ).data
    const beforeAt = beforeList.find((k) => k.provider === "anthropic")!.validatedAt

    const res = await testApp(WITH_KEY_ORG).request("/api/settings/ai/keys/anthropic/validate", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { provider: string; validatedAt: string }
    }
    expect(data.provider).toBe("anthropic")
    expect(typeof data.validatedAt).toBe("string")
    expect(new Date(data.validatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeAt).getTime(),
    )
  })

  it("returns 400 when the provider rejects the stored key", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch
    const res = await testApp(WITH_KEY_ORG).request("/api/settings/ai/keys/anthropic/validate", {
      method: "POST",
    })
    expect(res.status).toBe(400)
  })

  it("returns 502 when the provider API is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const res = await testApp(WITH_KEY_ORG).request("/api/settings/ai/keys/anthropic/validate", {
      method: "POST",
    })
    expect(res.status).toBe(502)
  })
})

// Regression: the SAVE path (POST /) was previously untested — the existing suite
// pre-seeds keys via raw SQL and only exercises re-validate. The save handler's
// `jsonb_build_object(${provider}, …)` passed the provider as a bare, untyped
// parameter, so Postgres raised 42P18 "could not determine data type of parameter"
// and EVERY key-save 500'd (the headline BYOK feature was fully broken). The fix
// casts it to `${provider}::text`.
describe("ai-keys routes — save (POST /)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SAVE_ORG}, 'AiKeys Save', 'aikeys-save') ON CONFLICT (id) DO NOTHING`
  })
  afterAll(async () => {
    await sql`DELETE FROM kernel.organizations WHERE id = ${SAVE_ORG}`
  })

  // Restore the real global fetch after EVERY test. Both tests below overwrite
  // `globalThis.fetch` (the last one with a 401-returning stub); without this the
  // poisoned fetch leaks past this file and breaks every later file in the flat
  // unit `bun test` run that relies on the real global fetch (e.g. the bulk-blob
  // sandbox suite, which 401'd on its local fixture server). `afterEach` always
  // runs, even when a test throws.
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("saves a validated provider key (200), persists ENCRYPTED, and never leaks plaintext", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    const PLAINTEXT = "sk-ant-save-regression-1234XY"

    const res = await testApp(SAVE_ORG).request("/api/settings/ai/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: PLAINTEXT }),
    })
    const bodyText = await res.text()
    expect(res.status).toBe(200) // regression: was 500 (42P18 on the untyped provider param)
    expect(bodyText).not.toContain(PLAINTEXT) // response exposes only the masked hint
    const { data } = JSON.parse(bodyText) as { data: { provider: string; maskedHint: string } }
    expect(data.provider).toBe("anthropic")
    expect(data.maskedHint).toBe(PLAINTEXT.slice(-6))

    // Stored at rest as ciphertext, never plaintext.
    const [row] = await sql<{ entry: { encrypted: string; maskedHint: string } }[]>`
      SELECT settings->'providerKeys'->'anthropic' AS entry FROM kernel.organizations WHERE id = ${SAVE_ORG}`
    expect(row.entry.encrypted).toBeTruthy()
    expect(row.entry.encrypted).not.toContain(PLAINTEXT)
    expect(row.entry.maskedHint).toBe(PLAINTEXT.slice(-6))

    // GET exposes only the masked hint — no plaintext, no ciphertext.
    const list = await testApp(SAVE_ORG).request("/api/settings/ai/keys")
    const listText = await list.text()
    expect(listText).not.toContain(PLAINTEXT)
    expect(listText).not.toContain(row.entry.encrypted)
    expect(listText).toContain(PLAINTEXT.slice(-6))
  })

  it("an unreachable provider is logged without the key, even when the error carries the URL", async () => {
    // Google's check puts the key in the URL's query string, and a failed fetch
    // can carry that URL on the error (its message, Bun's `path`).
    const KEY = "AIza-unreachable-LOGLEAK-5678"
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        throw Object.assign(new TypeError(`Unable to connect: ${url}`), { path: url })
      },
      { preconnect: realFetch.preconnect },
    )
    const stream: unknown = Reflect.get(rootLogger, pino.symbols.streamSym)
    if (!stream || typeof stream !== "object") throw new Error("no log stream")
    const original: unknown = Reflect.get(stream, "write")
    if (typeof original !== "function") throw new Error("log stream cannot write")
    const lines: string[] = []
    Reflect.set(stream, "write", (chunk: unknown) => {
      lines.push(String(chunk))
      return Reflect.apply(original, stream, [chunk])
    })
    try {
      const res = await testApp(SAVE_ORG).request("/api/settings/ai/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google", apiKey: KEY }),
      })
      expect(res.status).toBe(502)
      expect(await res.text()).not.toContain(KEY)
    } finally {
      Reflect.set(stream, "write", original)
    }
    expect(lines.some((l) => l.includes("unreachable"))).toBe(true)
    for (const line of lines) expect(line).not.toContain(KEY)
  })

  it("rejects an invalid key (400) without persisting anything", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch
    const res = await testApp(SAVE_ORG).request("/api/settings/ai/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-invalid" }),
    })
    expect(res.status).toBe(400)
    const [row] = await sql<{ entry: unknown }[]>`
      SELECT settings->'providerKeys'->'openai' AS entry FROM kernel.organizations WHERE id = ${SAVE_ORG}`
    expect(row.entry).toBeNull()
  })
})

// An OpenRouter key is what `web_search` runs on when the org has no Exa key
// (S13), so saving one must advertise the tool in the same request, and
// removing it must take the tool away, with no restart. Drop either
// `refreshWebSearch` call from the routes and the matching assertion fails.
describe("ai-keys routes — an OpenRouter key re-registers web_search", () => {
  const OR_ORG = "00000000-0000-0000-0000-0000000a0004"
  const saved: Record<string, string | undefined> = {}
  beforeAll(async () => {
    for (const k of ["EXA_API_KEY", "OPENROUTER_API_KEY"]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OR_ORG}, 'AiKeys OR', 'aikeys-or') ON CONFLICT (id) DO NOTHING`
  })
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    toolRegistry.deleteByPrefix([OR_ORG])
    await sql`DELETE FROM kernel.organizations WHERE id = ${OR_ORG}`
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("saving the key registers kernel/web_search, deleting it unregisters it", async () => {
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    const { refreshWebSearchToolRegistration } = await import("~/modules/agent/tools/kernel-tools")
    await refreshWebSearchToolRegistration(OR_ORG)
    expect(toolRegistry.get([OR_ORG, "kernel", "web_search"])).toBeUndefined()

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    const res = await testApp(OR_ORG).request("/api/settings/ai/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", apiKey: "sk-or-v1-test-websearch" }),
    })
    expect(res.status).toBe(200)
    expect(toolRegistry.get([OR_ORG, "kernel", "web_search"])).toBeDefined()

    const del = await testApp(OR_ORG).request("/api/settings/ai/keys/openrouter", {
      method: "DELETE",
    })
    expect(del.status).toBe(204)
    expect(toolRegistry.get([OR_ORG, "kernel", "web_search"])).toBeUndefined()
  })
})
