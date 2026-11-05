// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import recorded from "./__fixtures__/openrouter-web-search.json"
import {
  MAX_CITATION_CONTENT_CHARS,
  mapOpenRouterCitations,
  OPENROUTER_WEB_SEARCH_MODEL,
  OpenRouterSearchError,
  openRouterWebSearch,
} from "./web-search-openrouter"

describe("mapOpenRouterCitations (recorded OpenRouter response)", () => {
  it("maps every url_citation to a result with title, url and content", () => {
    const hits = mapOpenRouterCitations(recorded, 10)
    expect(hits).toHaveLength(5)
    for (const h of hits) {
      expect(h.url).toStartWith("https://")
      expect(h.title.length).toBeGreaterThan(0)
      expect(h.content.length).toBeGreaterThan(0)
    }
    expect(hits.filter((h) => h.content.length >= 200).length).toBeGreaterThanOrEqual(3)
    // Ranked: first is the best.
    expect(hits[0].score).toBe(1)
    expect(hits[4].score).toBeLessThan(hits[3].score)
  })

  it("keeps at most `limit` results", () => {
    expect(mapOpenRouterCitations(recorded, 2)).toHaveLength(2)
  })

  // SK11: a citation's title and URL are written by the cited page (or by
  // whoever steered the search), so they are cleaned like web_fetch's title:
  // no control characters, no markup, a capped length; a URL that is not
  // http(s) is not a result.
  it("strips control characters and markup from a title and caps its length", () => {
    const body = {
      choices: [
        {
          message: {
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://a.example/\u0000x",
                  title: `Hi\u0007 <b>there</b><script>alert(1)</script>\u202e${"x".repeat(500)}`,
                  content: "c",
                },
              },
              { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "t" } },
              {
                type: "url_citation",
                url_citation: { url: "  https://b.example/ok  ", title: "B" },
              },
            ],
          },
        },
      ],
    }
    const hits = mapOpenRouterCitations(body, 10)
    expect(hits.map((h) => h.url)).toEqual(["https://a.example/x", "https://b.example/ok"])
    const title = hits[0]?.title ?? ""
    expect(title).not.toMatch(/[<>]/)
    const codes = [...title].map((ch) => ch.codePointAt(0) ?? 0)
    expect(codes.filter((c) => c < 0x20 || c === 0x7f || c === 0x202e)).toEqual([])
    expect(title.startsWith("Hi there")).toBe(true)
    expect(title.length).toBeLessThanOrEqual(200)
  })

  it("cuts a long excerpt, drops duplicate URLs and citations without a URL", () => {
    const body = {
      choices: [
        {
          message: {
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://a.example/", title: "A", content: "x".repeat(9000) },
              },
              {
                type: "url_citation",
                url_citation: { url: "https://a.example/", title: "A again", content: "dup" },
              },
              { type: "url_citation", url_citation: { url: "", title: "no url", content: "c" } },
              { type: "file", file: {} },
              { type: "url_citation", url_citation: { url: "https://b.example/", title: "B" } },
            ],
          },
        },
      ],
    }
    const hits = mapOpenRouterCitations(body, 10)
    expect(hits.map((h) => h.url)).toEqual(["https://a.example/", "https://b.example/"])
    expect(hits[0].content).toHaveLength(MAX_CITATION_CONTENT_CHARS)
    expect(hits[1].content).toBe("")
  })

  it("reads an answer without annotations as no results", () => {
    expect(mapOpenRouterCitations({ choices: [{ message: { content: "hi" } }] }, 5)).toEqual([])
    expect(mapOpenRouterCitations(null, 5)).toEqual([])
  })
})

describe("openRouterWebSearch (OpenRouter stubbed at HTTP)", () => {
  const seen: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = []
  let server: ReturnType<typeof Bun.serve>
  let fail = false
  const savedBase = process.env.OPENROUTER_BASE_URL

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: (await req.json()) as Record<string, unknown>,
        })
        if (fail) return Response.json({ error: { message: "rate limited" } }, { status: 429 })
        return Response.json(recorded)
      },
    })
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`
  })
  afterAll(() => {
    server.stop(true)
    if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL
    else process.env.OPENROUTER_BASE_URL = savedBase
  })

  it("sends the pinned request and returns the citations with the reported cost", async () => {
    const out = await openRouterWebSearch({ query: "news", numResults: 4, apiKey: "or-key" })
    const req = seen.at(-1)!
    expect(req.path).toBe("/api/v1/chat/completions")
    expect(req.auth).toBe("Bearer or-key")
    expect(req.body.model).toBe(OPENROUTER_WEB_SEARCH_MODEL)
    expect(req.body.plugins).toEqual([{ id: "web", engine: "exa", max_results: 4 }])
    // The routing, plus the host deny-list (LIAISON_OPENROUTER_IGNORE_HOSTS, default OpenInference).
    expect(req.body.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      ignore: ["OpenInference"],
    })
    expect(req.body.usage).toEqual({ include: true })
    expect(Number(req.body.max_tokens)).toBeLessThanOrEqual(30)
    expect(out.hits).toHaveLength(4)
    expect(out.costUsd).toBe(recorded.usage.cost)
    expect(out.inputTokens).toBe(recorded.usage.prompt_tokens)
    expect(out.outputTokens).toBe(recorded.usage.completion_tokens)
  })

  it("throws OpenRouterSearchError with the upstream message on an error status", async () => {
    fail = true
    try {
      await expect(
        openRouterWebSearch({ query: "news", numResults: 5, apiKey: "or-key" }),
      ).rejects.toThrow(OpenRouterSearchError)
      await expect(
        openRouterWebSearch({ query: "news", numResults: 5, apiKey: "or-key" }),
      ).rejects.toThrow(/429: rate limited/)
    } finally {
      fail = false
    }
  })
})
