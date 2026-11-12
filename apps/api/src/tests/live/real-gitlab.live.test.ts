// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live check of the GitLab app (bundled-apps/gitlab) against real gitlab.com.
 *
 * Requires GITLAB_TEST_TOKEN, a read-only PAT (read_api + read_repository).
 * GITLAB_TEST_GROUP names the group the list and search reads use (default
 * the public `gitlab-examples`); the project reads use a small public
 * project. Without the token the whole file skips (the default in CI); it is
 * run by hand through the `live` suite.
 *
 * The app's handlers run as they do in the sandbox, over a `ctx.fetch` that
 * adds the token the way the host does (a bearer header, only to gitlab.com).
 */

import { describe, expect, it } from "bun:test"
import type { GitlabCtx } from "../../../../../bundled-apps/gitlab/src/client"
import { syncGitlabFolder } from "../../../../../bundled-apps/gitlab/src/knowledge"
import { verifyGitlab } from "../../../../../bundled-apps/gitlab/src/provisioning"
import {
  gitlabListProjects,
  gitlabListTree,
  gitlabReadFile,
} from "../../../../../bundled-apps/gitlab/src/tools"

const TOKEN = process.env.GITLAB_TEST_TOKEN
const GROUP = process.env.GITLAB_TEST_GROUP || "gitlab-examples"
/** gitlab-examples/gitlab-game-demo: public, small, a `doc` folder of Markdown. */
const PROJECT = "23764176"
const TIMEOUT = 60_000

function liveCtx(): GitlabCtx {
  return {
    async fetch(url, opts) {
      if (new URL(url).hostname !== "gitlab.com") throw new Error(`egress refused: ${url}`)
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) }
      if (opts?.auth) headers.Authorization = `Bearer ${TOKEN}`
      const res = await fetch(url, { method: opts?.method ?? "GET", headers, redirect: "manual" })
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.text(),
      }
    },
    connections: {
      getSettings: async () => JSON.stringify({ values: { group: GROUP }, missing: [] }),
    },
  }
}

describe.skipIf(!TOKEN)("gitlab app: live (real gitlab.com)", () => {
  it(
    "verify reads the token owner and the group",
    async () => {
      const out = await verifyGitlab({}, liveCtx())
      expect(out.problems).toEqual([])
      expect(out.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "lists the group's projects",
    async () => {
      const out = (await gitlabListProjects({}, liveCtx())) as { projects: unknown[] }
      expect(Array.isArray(out.projects)).toBe(true)
      expect(out.projects.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    "lists a tree and reads a file of a public project",
    async () => {
      const tree = (await gitlabListTree({ project: PROJECT }, liveCtx())) as {
        entries: Array<{ path: string }>
      }
      expect(tree.entries.some((e) => e.path === "README.md")).toBe(true)
      const file = (await gitlabReadFile(
        { project: PROJECT, path: "README.md", startLine: 1, endLine: 3 },
        liveCtx(),
      )) as { content: string; url: string }
      expect(file.content.length).toBeGreaterThan(0)
      expect(file.url).toContain("gitlab-examples/gitlab-game-demo/-/blob/")
    },
    TIMEOUT,
  )

  it(
    "syncs a folder to the end of a pass",
    async () => {
      let cursor: unknown = null
      const docs: string[] = []
      for (let page = 0; page < 20; page++) {
        const out = await syncGitlabFolder(
          {
            sourceId: "live",
            kind: "folder",
            config: { ref: `${PROJECT}:master:doc` },
            cursor: cursor as never,
          },
          liveCtx(),
        )
        docs.push(...(out.documents?.upsert ?? []).map((d) => d.externalId))
        cursor = out.nextCursor
        if (out.done) break
      }
      expect(docs).toContain(`${PROJECT}:master:doc/index.md`)
    },
    TIMEOUT,
  )
})
