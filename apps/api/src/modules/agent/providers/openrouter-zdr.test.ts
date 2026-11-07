// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The privacy notice of a managed cell promises zero data retention on every AI
// call. Each request says so itself: it does not rest on an account setting.
// Every way out to OpenRouter is listed here (`withManagedZdr`, openrouter.ts);
// the guard below refuses a new way round it. A self-hosted request is unchanged.
//
// Mutations that fail here:
//  * Drop `withManagedZdr` from openRouterFetch: dictation and any REST body lose `zdr`.
//  * Drop `managedZdrFetch` from createOpenRouterModel: chat turns lose it.
//  * Drop it from openRouterThreadFetch: the idle compaction's brief loses it.
//  * Apply it regardless of the edition: the self-hosted bodies gain it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { generateText } from "ai"
import { _setEdition } from "~/lib/edition"
import {
  createOpenRouterModel,
  openRouterBaseURL,
  openRouterFetch,
  openRouterThreadFetch,
} from "~/modules/agent/providers/openrouter"

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      object: "chat.completion",
      created: 1,
      model: "m/x",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

// A real server: the requests as they leave, over the wire.
let bodies: Array<Record<string, unknown>> = []
let server: ReturnType<typeof Bun.serve>
const savedBase = process.env.OPENROUTER_BASE_URL

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (req.method === "POST") bodies.push((await req.json()) as Record<string, unknown>)
      else getsSeen += 1
      return completion()
    },
  })
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`
})
afterAll(() => {
  server.stop(true)
  if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL
  else process.env.OPENROUTER_BASE_URL = savedBase
})
let getsSeen = 0
beforeEach(() => {
  bodies = []
  getsSeen = 0
})
afterEach(() => {
  _setEdition(null)
})

const paths: Array<[string, () => Promise<unknown>]> = [
  [
    "a chat turn with no thread",
    () => generateText({ model: createOpenRouterModel("sk-or-test", "m/x"), prompt: "hi" }),
  ],
  [
    "a thread's turn",
    () =>
      generateText({
        model: createOpenRouterModel("sk-or-test", "m/x", { sessionId: "t-zdr-1" }),
        prompt: "hi",
      }),
  ],
  [
    "the idle compaction's brief",
    () =>
      openRouterThreadFetch("sk-or-test", "t-zdr-2")(`${openRouterBaseURL()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m/x", messages: [{ role: "user", content: "hi" }] }),
      }),
  ],
  [
    "dictation",
    () =>
      openRouterFetch("/audio/transcriptions", {
        apiKey: "sk-or-test",
        body: {
          model: "m/asr",
          input_audio: { data: "AA==", format: "webm" },
          provider: { data_collection: "deny" },
        },
      }),
  ],
  [
    "a direct chat completion",
    () =>
      openRouterFetch("/chat/completions", {
        apiKey: "sk-or-test",
        body: { model: "m/x", messages: [{ role: "user", content: "hi" }] },
      }),
  ],
]

describe("zero data retention on every OpenRouter request", () => {
  for (const [name, send] of paths) {
    it(`managed: ${name} asks for it, beside the routing it already had`, async () => {
      _setEdition("managed")
      await send()
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect((body.provider as Record<string, unknown>).zdr).toBe(true)
      }
    })

    it(`self-hosted: ${name} is unchanged`, async () => {
      _setEdition(null)
      await send()
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect((body.provider as Record<string, unknown> | undefined)?.zdr).toBeUndefined()
      }
    })
  }

  it("managed: a chat turn keeps its data policy and parameter routing", async () => {
    _setEdition("managed")
    await generateText({ model: createOpenRouterModel("sk-or-test", "m/x"), prompt: "hi" })
    expect(bodies[0]!.provider).toMatchObject({
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    })
  })

  it("a GET stays a GET", async () => {
    _setEdition("managed")
    await openRouterFetch("/models")
    expect(getsSeen).toBe(1)
    expect(bodies).toEqual([])
  })
})

describe("guard: no way out to OpenRouter around the zero-retention choke", () => {
  const root = join(import.meta.dir, "../../..")
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : sources(p)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
    })
  const files = sources(root)
  const using = (pattern: RegExp) =>
    files
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .sort()

  it("only the provider module builds the OpenRouter SDK client", () => {
    expect(using(/\bcreateOpenRouter\(/)).toEqual(["modules/agent/providers/openrouter.ts"])
  })

  it("the only raw uses of the base URL are reads and the thread fetch's own", () => {
    // Anything else that posts to OpenRouter goes through openRouterFetch, or the
    // request would not carry `zdr` on a managed cell.
    expect(using(/\bopenRouterBaseURL\(\)/)).toEqual([
      "cli/provisioners/byok.ts", // GET /key
      "modules/agent/context/warm-compaction.ts", // through openRouterThreadFetch
      "modules/agent/credits/openrouter-catalogue.ts", // the /models URL, for a message
      "modules/agent/providers/openrouter.ts",
      "modules/settings/ai-keys-routes.ts", // GET /key
    ])
  })
})
