// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.files_analyzeDocument: an app reads ONE of its own files with the org's media model, only
// when it declared the capability, judged on the `apps` media surface, and never another app's file.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import * as mediaTool from "~/modules/agent/media/media-analysis-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-0000-0000-0000000e3001"
const USER = "00000000-0000-0000-0000-0000000e3002"
const APP = "widgets"
const OWN = "00000000-0000-4000-8000-0000000e30a1"
const FOREIGN = "00000000-0000-4000-8000-0000000e30a2"
const IMAGE_ONLY_VIDEO = "00000000-0000-4000-8000-0000000e30a3"
const MISLABELLED = "00000000-0000-4000-8000-0000000e30a4"

function manifest(capabilities: string[]) {
  return { name: APP, schema: {}, events: {}, connections: {}, network: {}, capabilities }
}

const dialect = new PgDialect()

// The caller's transaction: its own PDF, another app's PDF, and its own video.
const tx = {
  execute: async (q: never) => {
    const text = JSON.stringify(dialect.sqlToQuery(q).params)
    if (text.includes(OWN)) return [{ app: APP, mime_type: "application/pdf" }]
    if (text.includes(FOREIGN)) return [{ app: "other", mime_type: "application/pdf" }]
    if (text.includes(IMAGE_ONLY_VIDEO)) return [{ app: APP, mime_type: "video/mp4" }]
    if (text.includes(MISLABELLED)) return [{ app: APP, mime_type: "application/octet-stream" }]
    return []
  },
  queueEvent: async () => {},
}

let spy: ReturnType<typeof spyOn>
let calls: Array<{ params: unknown; caller: unknown; opts: unknown }>

beforeEach(() => {
  calls = []
  spy = spyOn(mediaTool, "handleAnalyzeMedia").mockImplementation((async (
    params: unknown,
    caller: unknown,
    _deps: unknown,
    opts: unknown,
  ) => {
    calls.push({ params, caller, opts })
    return { summary: '{"tracking_number":"1Z"}', model: "m", analyzedAt: "x", cached: false }
  }) as never)
})
afterEach(() => spy.mockRestore())

function bridgeFor(capabilities: string[]) {
  return createRpcBridge(APP, USER, ORG, tx as never, manifest(capabilities) as never)
}

describe("ctx.files_analyzeDocument", () => {
  it("refuses an app that did not declare files.analyzeDocument", async () => {
    const bridge = bridgeFor([])
    await expect(
      bridge.files_analyzeDocument(JSON.stringify({ fileId: OWN, prompt: "q" })),
    ).rejects.toThrow(/files.analyzeDocument/)
    expect(calls).toHaveLength(0)
  })

  it("analyses the app's own PDF on the apps surface with the prompt as a briefing", async () => {
    const bridge = bridgeFor(["files.analyzeDocument"])
    const out = JSON.parse(
      await bridge.files_analyzeDocument(JSON.stringify({ fileId: OWN, prompt: "Read it." })),
    )
    expect(out).toEqual({ text: '{"tracking_number":"1Z"}', model: "m" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toEqual({ fileId: OWN, context: "Read it." })
    expect(calls[0]?.opts).toEqual({ surface: "apps", kinds: ["image", "document"] })
    expect(calls[0]?.caller).toMatchObject({ orgId: ORG })
  })

  it("never reads another app's file", async () => {
    const bridge = bridgeFor(["files.analyzeDocument"])
    const out = JSON.parse(
      await bridge.files_analyzeDocument(JSON.stringify({ fileId: FOREIGN, prompt: "q" })),
    )
    expect(out.error.code).toBe("not_found")
    expect(calls).toHaveLength(0)
  })

  it("judges the file by its bytes: the handler sniffs, limited to images and PDFs", async () => {
    const bridge = bridgeFor(["files.analyzeDocument"])
    // The stored mime type is a declaration, not the bytes: the handler sniffs and refuses a video
    // itself, so the slow video job is never reached from this seam.
    for (const fileId of [IMAGE_ONLY_VIDEO, MISLABELLED]) {
      await bridge.files_analyzeDocument(JSON.stringify({ fileId, prompt: "q" }))
    }
    expect(calls.map((c) => c.opts)).toEqual([
      { surface: "apps", kinds: ["image", "document"] },
      { surface: "apps", kinds: ["image", "document"] },
    ])
  })

  it("refuses a missing prompt", async () => {
    const bridge = bridgeFor(["files.analyzeDocument"])
    const noPrompt = JSON.parse(await bridge.files_analyzeDocument(JSON.stringify({ fileId: OWN })))
    expect(noPrompt.error.code).toBe("invalid_params")
    expect(calls).toHaveLength(0)
  })
})
