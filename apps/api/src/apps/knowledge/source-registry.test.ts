// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The default registry: one adapter per app that declares `knowledgeItems`,
// gated by the app's read scope and availability, waking the app's exports.

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import type { KnowledgeItemsDecl } from "~/modules/apps/app-registries"

const unavailable = new Set<string>()
const realOrgApps = { ...(await import("~/modules/apps/org-apps")) }
mock.module("~/modules/apps/org-apps", () => ({
  ...realOrgApps,
  primeOrgApps: async () => {},
  isAppUnavailableFor: (_org: string, app: string) => unavailable.has(app),
}))
// mock.module outlives this file: put the real module back for later files.
afterAll(() => {
  mock.module("~/modules/apps/org-apps", () => realOrgApps)
})

const { knowledgeItemsRegistry } = await import("~/modules/apps/app-registries")
const { registerDefaultKnowledgeSources, parseResolved, parseSearchAnswer } = await import(
  "~/apps/knowledge/source-registry"
)
const { CapLimitError } = await import("~/modules/org/caps")

const ORG = "org-items"
const actor = { orgId: ORG, userId: "u1", scopes: ["*"], dimensionGrants: {} }
type Call = { entry: string; input: Record<string, unknown>; userId: string }
const calls: Call[] = []
let answer: (entry: string, input: Record<string, unknown>) => unknown = () => null

function declare(app: string, decl: Partial<KnowledgeItemsDecl>) {
  knowledgeItemsRegistry.set([ORG, app], {
    decl: { searchByDefault: true, ...decl },
    dispatch: async (entry, input, tenant) => {
      calls.push({ entry, input, userId: tenant.userId })
      return answer(entry, input)
    },
  })
}

const build = (scopes: string[], searchPolicy?: Map<string, boolean>) =>
  registerDefaultKnowledgeSources({
    orgId: ORG,
    userId: "u1",
    scopes,
    ...(searchPolicy ? { searchPolicy } : {}),
  })

beforeAll(() => {
  declare("notes", { search: "searchNotes", resolve: "resolveNote", readScope: "notes:read" })
  declare("files", { search: "searchFiles", resolve: "resolveFile", searchByDefault: false })
  declare("links", { resolve: "resolveLink" })
})
afterEach(() => {
  calls.length = 0
  unavailable.clear()
  answer = () => null
})

describe("registerDefaultKnowledgeSources", () => {
  it("one adapter per declaring app the person reaches: read scope and availability gate it", async () => {
    const all = (await build(["notes:read"])).listEnabled(actor).map((a) => a.source)
    expect(all.sort()).toEqual(["files", "links", "notes"])
    const noScope = (await build(["knowledge:sources:read"])).listEnabled(actor)
    expect(noScope.map((a) => a.source).sort()).toEqual(["files", "links"])
    unavailable.add("files")
    const restricted = (await build(["notes:read"])).listEnabled(actor)
    expect(restricted.map((a) => a.source).sort()).toEqual(["links", "notes"])
  })

  it("search follows the org's policy, else the app's default", async () => {
    const searchable = async (policy?: Map<string, boolean>) =>
      (await build(["notes:read"], policy))
        .listEnabled(actor)
        .filter((a) => a.searchRemote)
        .map((a) => a.source)
        .sort()
    expect(await searchable()).toEqual(["notes"])
    expect(await searchable(new Map([["files", true]]))).toEqual(["files", "notes"])
    expect(await searchable(new Map([["notes", false]]))).toEqual([])
  })

  it("search wakes the app for the person and maps its results to hits", async () => {
    answer = () => ({
      results: [
        {
          id: "n1",
          title: "Pricing",
          entity: "file",
          snippet: "net 30",
          attributes: { url: "https://x.example/n1" },
        },
        { id: "n2", title: "Bad url", attributes: { url: "javascript:alert(1)" } },
      ],
      nextCursor: "c2",
    })
    const notes = (await build(["notes:read"])).listEnabled(actor).find((a) => a.source === "notes")
    const res = await notes!.searchRemote!(
      { query: "price", limit: 5, cursors: { notes: "c1" } },
      actor,
    )
    expect(calls).toEqual([
      { entry: "search", input: { query: "price", limit: 5, cursor: "c1" }, userId: "u1" },
    ])
    expect(res.hits.map((h) => [h.sourceEntityId, h.url ?? null, h.type])).toEqual([
      ["n1", "https://x.example/n1", "file"],
      ["n2", null, "item"],
    ])
    expect(res.status).toMatchObject({
      source: "notes",
      state: "complete",
      cursor: "c2",
      hitCount: 2,
    })
  })

  it("a day cap is a rate-limited status, not an error", async () => {
    answer = () => {
      throw new CapLimitError("appRunsPerDay" as never, 1, 1)
    }
    const notes = (await build(["notes:read"])).listEnabled(actor).find((a) => a.source === "notes")
    const res = await notes!.searchRemote!({ query: "x", limit: 5 }, actor)
    expect(res).toMatchObject({ hits: [], status: { state: "rate-limited" } })
  })

  it("resolve serves metadata (no text) and content (with text)", async () => {
    answer = (_e, input) =>
      input.ref === "gone"
        ? { found: false }
        : {
            found: true,
            title: "Sheet",
            url: "https://x.example/s",
            modifiedAt: "2026-01-01",
            text: "body",
          }
    const links = (await build([])).listEnabled(actor).find((a) => a.source === "links")!
    expect(links.searchRemote).toBeUndefined()
    expect(await links.getRemoteMetadata!({ sourceEntityId: "s1" }, actor)).toEqual({
      title: "Sheet",
      url: "https://x.example/s",
      modifiedAt: "2026-01-01",
    })
    expect(await links.getRemoteMetadata!({ sourceEntityId: "gone" }, actor)).toBeNull()
    expect(await links.fetchRemoteContent!({ sourceEntityId: "s1" }, actor)).toMatchObject({
      status: "available",
      text: "body",
    })
    expect(await links.fetchRemoteContent!({ sourceEntityId: "gone" }, actor)).toEqual({
      status: "not_found",
    })
    expect(calls.map((c) => [c.entry, c.input.content])).toEqual([
      ["resolve", false],
      ["resolve", false],
      ["resolve", true],
      ["resolve", true],
    ])
  })
})

describe("parseResolved / parseSearchAnswer", () => {
  it("an error answer or a non-object throws (a link never goes stale on a broken app)", () => {
    expect(() => parseResolved({ error: { code: "not_connected", message: "no" } })).toThrow(
      "not_connected",
    )
    expect(() => parseResolved("x")).toThrow()
    expect(parseResolved(null)).toBeNull()
    expect(parseResolved({ found: true, url: "ftp://x" })).toEqual({})
  })

  it("a search answer without results is no hits", () => {
    expect(parseSearchAnswer("a", { error: "x" })).toEqual({ hits: [] })
    expect(parseSearchAnswer("a", { results: [{ title: "no id" }] })).toEqual({ hits: [] })
  })
})
