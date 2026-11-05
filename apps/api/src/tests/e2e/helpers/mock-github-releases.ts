// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"

/**
 * Mock GitHub releases server for Phase 14 E2E.
 *
 * Mirrors the inbound contract that production calls via
 *   GET ${GITHUB_API_BASE}/repos/mathieufro/liaison/releases?per_page=30
 * with no auth (public endpoint). Used by `apps/api/src/modules/admin/version-check.ts`.
 *
 * Each call records a request entry so tests can assert cache behavior and
 * opt-out short-circuits.
 */

export interface FakeGitHubReleasesRequest {
  method: string
  path: string
}

export interface FakeRelease {
  tag: string
  name?: string
  htmlUrl?: string
  draft?: boolean
  prerelease?: boolean
}

export interface FakeGitHubReleasesHandle {
  url: string
  port: number
  setLatest: (opts: { tag: string; htmlUrl?: string }) => void
  /** Replaces the whole list (newest first, as GitHub returns it). */
  setReleases: (releases: FakeRelease[]) => void
  setStatus: (status: number) => void
  getRequests: () => FakeGitHubReleasesRequest[]
  resetRequests: () => void
  kill: () => Promise<void>
}

export async function startFakeGitHubReleases(
  port: number,
  opts: { latest?: string; htmlUrl?: string } = {},
): Promise<FakeGitHubReleasesHandle> {
  let tag = opts.latest ?? "v0.1.1"
  let htmlUrl = opts.htmlUrl ?? `https://github.com/mathieufro/liaison/releases/tag/${tag}`
  let statusCode = 200
  let list: FakeRelease[] | null = null
  const requests: FakeGitHubReleasesRequest[] = []

  const app = new Hono()

  app.use("*", async (c, next) => {
    requests.push({ method: c.req.method, path: new URL(c.req.url).pathname })
    return next()
  })

  app.get("/__health", (c) => c.json({ ok: true }))

  app.get("/repos/mathieufro/liaison/releases", (c) => {
    if (statusCode >= 400) {
      return c.json({ message: "rate limited" }, statusCode as 400)
    }
    const releases = list ?? [{ tag, htmlUrl }]
    return c.json(
      releases.map((r) => ({
        tag_name: r.tag,
        name: r.name ?? r.tag,
        html_url: r.htmlUrl ?? `https://github.com/mathieufro/liaison/releases/tag/${r.tag}`,
        draft: r.draft ?? false,
        prerelease: r.prerelease ?? false,
      })),
    )
  })

  app.all("*", (c) => c.json({ message: "not found" }, 404))

  const server = Bun.serve({ fetch: app.fetch, port })

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/__health`)
      if (r.ok) break
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 20))
  }

  return {
    url,
    port,
    setReleases: (releases) => {
      list = releases
    },
    setLatest: ({ tag: t, htmlUrl: u }) => {
      list = null
      tag = t
      if (u !== undefined) htmlUrl = u
      else htmlUrl = `https://github.com/mathieufro/liaison/releases/tag/${tag}`
    },
    setStatus: (status) => {
      statusCode = status
    },
    getRequests: () => [...requests],
    resetRequests: () => {
      requests.length = 0
    },
    kill: async () => {
      server.stop(true)
    },
  }
}
