// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fake `ctx` for the app's unit tests: a GitLab answering from a route table
// (`"<path or URL>" -> answer`), the connection's readable settings, and a
// record of every ctx.fetch call with the auth it named.

import type { FetchAnswer, GitlabCtx } from "./client"

export interface FakeCall {
  url: string
  auth?: unknown
  headers?: Record<string, string>
}

export type Route = FetchAnswer | ((url: string) => FetchAnswer)

export function json(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): FetchAnswer {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

export function fileAnswer(
  text: string,
  blobId = "blob-1",
  lastCommitId = "commit-1",
): FetchAnswer {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return json({ content: btoa(bin), blob_id: blobId, last_commit_id: lastCommitId, file_path: "x" })
}

export interface FakeOptions {
  routes?: Record<string, Route>
  /** The connection's settings answer; default: connected to group "acme". */
  settings?: { values: Record<string, string>; missing: string[] } | "throws"
}

const API = "https://gitlab.com/api/v4"

export function fakeCtx(opts: FakeOptions = {}) {
  const calls: FakeCall[] = []
  const routes = opts.routes ?? {}
  const settings = opts.settings ?? { values: { group: "acme" }, missing: [] }
  const ctx = {
    calls,
    async fetch(url: string, init?: { headers?: Record<string, string>; auth?: unknown }) {
      calls.push({ url, auth: init?.auth, headers: init?.headers })
      const key = url.startsWith(API) ? url.slice(API.length) : url
      const route = routes[key] ?? routes[url]
      if (!route) return json({ message: `404 no fake route for ${key}` }, {}, 404)
      return typeof route === "function" ? route(url) : route
    },
    connections: {
      async getSettings(name: string) {
        if (name !== "gitlab") throw new Error(`unknown connection ${name}`)
        if (settings === "throws") throw new Error("No connected account")
        return JSON.stringify(settings)
      },
    },
  }
  return ctx
}

export const asCtx = (ctx: ReturnType<typeof fakeCtx>): GitlabCtx => ctx as unknown as GitlabCtx
