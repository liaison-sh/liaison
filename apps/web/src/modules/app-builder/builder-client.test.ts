// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import {
  type BuilderApi,
  checkDraft,
  discardDraft,
  draftUiSource,
  getDraft,
  isCustomAppName,
  isRunId,
  listDrafts,
  listVersions,
  orderedFileNames,
  parseParams,
  previewDraft,
  previewEntries,
  publishDraft,
  readAppLogs,
  restoreVersion,
  uiComponents,
} from "./builder-client"

function fakeApi() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    rawGet: vi.fn(async () => new Response("export const X = 1")),
  } satisfies BuilderApi
}

const ID = "11111111-1111-4111-8111-111111111111"

describe("builder client", () => {
  it("calls each draft route with its shape", async () => {
    const api = fakeApi()
    await listDrafts(api)
    await getDraft(api, ID)
    await getDraft(api, ID, 3)
    await listVersions(api, ID)
    expect(api.get.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "/apps/builder/drafts",
      `/apps/builder/drafts/${ID}`,
      `/apps/builder/drafts/${ID}?n=3`,
      `/apps/builder/drafts/${ID}/versions`,
    ])

    await checkDraft(api, ID, 2)
    await previewDraft(api, ID, { n: 2, entry: { kind: "tool", name: "items_list" }, params: {} })
    await restoreVersion(api, ID, 1)
    await discardDraft(api, ID)
    await publishDraft(api, ID)
    expect(api.post.mock.calls.map((c) => (c as unknown[]).slice(0, 2))).toEqual([
      [`/apps/builder/drafts/${ID}/check`, { n: 2 }],
      [
        `/apps/builder/drafts/${ID}/preview`,
        { entry: { kind: "tool", name: "items_list" }, n: 2, params: {} },
      ],
      [`/apps/builder/drafts/${ID}/restore`, { n: 1 }],
      [`/apps/builder/drafts/${ID}/discard`, {}],
      [`/apps/builder/drafts/${ID}/publish`, {}],
    ])
  })

  it("reads the interface as text from the draft's ui.js", async () => {
    const api = fakeApi()
    expect(await draftUiSource(api, ID, 4)).toBe("export const X = 1")
    expect(api.rawGet).toHaveBeenCalledWith(`/apps/builder/drafts/${ID}/4/ui.js`, expect.anything())
  })

  it("passes the log filters as query params", async () => {
    const api = fakeApi()
    await readAppLogs(api, "tracker-oabcdef12")
    await readAppLogs(api, "tracker-oabcdef12", { level: "warn", runId: ID, limit: 50 })
    expect(api.get.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "/apps/tracker-oabcdef12/logs",
      `/apps/tracker-oabcdef12/logs?level=warn&runId=${ID}&limit=50`,
    ])
  })

  it("tells custom apps and run ids apart", () => {
    expect(isCustomAppName("tracker-oabcdef12")).toBe(true)
    expect(isCustomAppName("tickets")).toBe(false)
    expect(isRunId(ID)).toBe(true)
    expect(isRunId("abc")).toBe(false)
  })

  it("reads entries, interface components and file order from the files", () => {
    const files = {
      "README.md": "# x",
      "handlers.ts": "",
      "app.manifest.json": JSON.stringify({
        tools: { items_list: {}, items_add: {} },
        jobs: { nightly: {} },
        views: { tabTypes: { main: { component: "Main" }, other: { component: "Main" } } },
      }),
      "extra.ts": "",
    }
    expect(previewEntries(files)).toEqual([
      { kind: "tool", name: "items_list" },
      { kind: "tool", name: "items_add" },
      { kind: "job", name: "nightly" },
    ])
    expect(uiComponents(files)).toEqual(["Main"])
    expect(orderedFileNames(files)).toEqual([
      "app.manifest.json",
      "handlers.ts",
      "README.md",
      "extra.ts",
    ])
    expect(previewEntries({ "app.manifest.json": "{oops" })).toEqual([])
  })

  it("accepts only a JSON object as params", () => {
    expect(parseParams("")).toEqual({ ok: true, params: {} })
    expect(parseParams('{"limit":2}')).toEqual({ ok: true, params: { limit: 2 } })
    expect(parseParams("[1]")).toEqual({ ok: false })
    expect(parseParams("{")).toEqual({ ok: false })
  })
})
