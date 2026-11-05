// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live integration test for the GitLab connector.
 *
 * Requires:
 *   GITLAB_TEST_TOKEN  — a read-only GitLab PAT (scopes: read_api, read_repository)
 *   GITLAB_TEST_GROUP  — group path or numeric id (e.g. "my-group" or "12345")
 *
 * When GITLAB_TEST_TOKEN is absent the entire suite is skipped — this is the
 * default state in CI (token unset); the user fills it in when they want to
 * exercise the real API.
 *
 * No database is required. This test drives makeGitlabFetchers / createGitlabAdapter
 * directly against live gitlab.com (or GITLAB_API_BASE_URL if overridden) with no
 * mocks and no OutboundFetchTestAccess.setFetch.
 */

import { describe, expect, it } from "bun:test"
import { createGitlabAdapter } from "~/apps/gitlab/adapter"
import { makeGitlabFetchers } from "~/apps/gitlab/gitlab-rest"
import type { KnowledgeActor } from "~/apps/knowledge/service"

// ---------------------------------------------------------------------------
// Gate — the whole file is a no-op when the token is absent
// ---------------------------------------------------------------------------

const TOKEN = process.env.GITLAB_TEST_TOKEN
const GROUP_ID = process.env.GITLAB_TEST_GROUP

// Generous timeout for real-network tests
const TIMEOUT = 30_000

// A minimal stub actor — the adapter uses it only for scope / org checks that
// are DB-coupled; the pure client/adapter calls tested here do not hit those
// code paths so the values are not meaningful.
const ACTOR: KnowledgeActor = {
  orgId: "test-org",
  userId: "test-user",
  scopes: ["knowledge:read"],
  dimensionGrants: {},
}

describe.skipIf(!TOKEN)("gitlab connector — live (real gitlab.com)", () => {
  // Build the client once; every test below reuses it.
  const client = makeGitlabFetchers(async () => TOKEN!)

  // State discovered in the first test; later tests branch on whether it is set.
  let firstProjectId: number | undefined
  let firstProjectBranch: string | undefined

  // ---------------------------------------------------------------------------
  // 1. listProjects
  // ---------------------------------------------------------------------------

  it(
    "listProjects — returns an array; captures first project if any",
    async () => {
      if (!GROUP_ID) {
        console.log("GITLAB_TEST_GROUP unset — skipping listProjects assertion")
        return
      }
      const projects = await client.listProjects({ groupId: GROUP_ID })
      expect(Array.isArray(projects)).toBe(true)
      console.log(`listProjects: ${projects.length} project(s) in group "${GROUP_ID}"`)

      if (projects.length > 0) {
        const first = projects[0]
        expect(typeof first.id).toBe("number")
        expect(typeof first.path_with_namespace).toBe("string")
        expect(typeof first.default_branch).toBe("string")
        firstProjectId = first.id
        firstProjectBranch = first.default_branch
        console.log(`  → using project id=${firstProjectId} branch="${firstProjectBranch}"`)
      } else {
        console.log("  → group has no projects; downstream project tests will be skipped")
      }
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------------
  // 2. listTree (recursive)
  // ---------------------------------------------------------------------------

  it(
    "listTree — returns tree entries; validates entry shape",
    async () => {
      if (!firstProjectId || !firstProjectBranch) {
        console.log("No project discovered — skipping listTree")
        return
      }
      const { items } = await client.listTree({
        projectId: firstProjectId,
        ref: firstProjectBranch,
        recursive: true,
      })
      expect(Array.isArray(items)).toBe(true)
      console.log(`listTree: ${items.length} tree entry(-ies)`)

      // Validate entry shape for any entries present
      for (const entry of items.slice(0, 5)) {
        expect(typeof entry.id).toBe("string")
        expect(typeof entry.name).toBe("string")
        expect(typeof entry.path).toBe("string")
        expect(entry.type === "blob" || entry.type === "tree").toBe(true)
      }
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------------
  // 3. getFile — fetch a markdown blob if one exists
  // ---------------------------------------------------------------------------

  it(
    "getFile — decodes content and exposes last_commit_id",
    async () => {
      if (!firstProjectId || !firstProjectBranch) {
        console.log("No project discovered — skipping getFile")
        return
      }
      // Discover a markdown file
      const { items: treeItems } = await client.listTree({
        projectId: firstProjectId,
        ref: firstProjectBranch,
        recursive: true,
      })
      const mdEntry = treeItems.find((e) => e.type === "blob" && e.path.endsWith(".md"))

      if (!mdEntry) {
        console.log("No .md file found in project tree — skipping getFile")
        return
      }
      console.log(`getFile: fetching "${mdEntry.path}"`)
      const fileInfo = await client.getFile({
        projectId: firstProjectId,
        path: mdEntry.path,
        ref: firstProjectBranch,
      })

      // content is base64; non-empty means a real response came back
      expect(fileInfo.content.length).toBeGreaterThan(0)
      expect(typeof fileInfo.last_commit_id).toBe("string")
      expect(fileInfo.last_commit_id.length).toBeGreaterThan(0)
      expect(fileInfo.file_path).toBe(mdEntry.path)
      console.log(
        `  → blob_id=${fileInfo.blob_id} last_commit_id=${fileInfo.last_commit_id.slice(0, 8)}…`,
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------------
  // 4. Adapter path — listFolder + fetchRemoteContent
  // ---------------------------------------------------------------------------

  it(
    "adapter listFolder — returns direct children with etag on files",
    async () => {
      if (!firstProjectId || !firstProjectBranch) {
        console.log("No project discovered — skipping adapter listFolder")
        return
      }
      const adapter = createGitlabAdapter({ client })
      const folderRef = `${firstProjectId}:${firstProjectBranch}:`

      const result = await adapter.listFolder!({ folderRef }, ACTOR)
      expect(Array.isArray(result.items)).toBe(true)
      console.log(`adapter listFolder: ${result.items.length} direct child(-ren) at root`)

      for (const item of result.items.slice(0, 5)) {
        expect(item.kind === "file" || item.kind === "folder").toBe(true)
        expect(typeof item.externalId).toBe("string")
        expect(typeof item.name).toBe("string")
        if (item.kind === "file") {
          // etag (blob sha) must be present for files
          expect(typeof item.etag).toBe("string")
          expect(item.etag!.length).toBeGreaterThan(0)
        }
      }
    },
    TIMEOUT,
  )

  it(
    "adapter fetchRemoteContent — returns status:ok + non-empty text for a markdown file",
    async () => {
      if (!firstProjectId || !firstProjectBranch) {
        console.log("No project discovered — skipping adapter fetchRemoteContent")
        return
      }
      // Discover a markdown file
      const { items: treeItems } = await client.listTree({
        projectId: firstProjectId,
        ref: firstProjectBranch,
        recursive: true,
      })
      const mdEntry = treeItems.find((e) => e.type === "blob" && e.path.endsWith(".md"))
      if (!mdEntry) {
        console.log("No .md file found — skipping adapter fetchRemoteContent")
        return
      }

      const adapter = createGitlabAdapter({ client })
      const sourceEntityId = `${firstProjectId}:${firstProjectBranch}:${mdEntry.path}`
      console.log(`adapter fetchRemoteContent: entityId="${sourceEntityId}"`)

      const result = await adapter.fetchRemoteContent!({ sourceEntityId }, ACTOR)
      expect(result.status).toBe("ok")
      expect(typeof result.text).toBe("string")
      expect(result.text!.length).toBeGreaterThan(0)
      // Secret-redaction pass runs inside fetchRemoteContent; we just confirm
      // the output is non-empty text, not a specific redacted value.
      console.log(`  → text length=${result.text!.length} title="${result.title}"`)
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------------
  // 5. listReleases / listMilestones / listIssues — may all be empty
  // ---------------------------------------------------------------------------

  it(
    "listReleases — call succeeds and returns a well-shaped array",
    async () => {
      if (!firstProjectId) {
        console.log("No project discovered — skipping listReleases")
        return
      }
      const releases = await client.listReleases({ projectId: firstProjectId })
      expect(Array.isArray(releases)).toBe(true)
      console.log(`listReleases: ${releases.length} release(s)`)
      for (const rel of releases.slice(0, 3)) {
        expect(typeof rel.tag_name).toBe("string")
        expect(typeof rel.name).toBe("string")
        // If a release has milestone issue_stats, validate shape
        if (rel.milestones && rel.milestones.length > 0) {
          const ms = rel.milestones[0]
          if (ms.issue_stats) {
            expect(typeof ms.issue_stats.total).toBe("number")
            expect(typeof ms.issue_stats.closed).toBe("number")
          }
        }
      }
    },
    TIMEOUT,
  )

  it(
    "listMilestones — call succeeds and returns a well-shaped array",
    async () => {
      if (!firstProjectId) {
        console.log("No project discovered — skipping listMilestones")
        return
      }
      const milestones = await client.listMilestones({ projectId: firstProjectId })
      expect(Array.isArray(milestones)).toBe(true)
      console.log(`listMilestones: ${milestones.length} milestone(s)`)
      for (const ms of milestones.slice(0, 3)) {
        expect(typeof ms.id).toBe("number")
        expect(typeof ms.title).toBe("string")
        expect(typeof ms.state).toBe("string")
      }
    },
    TIMEOUT,
  )

  it(
    "listIssues — call succeeds and returns a well-shaped array",
    async () => {
      if (!firstProjectId) {
        console.log("No project discovered — skipping listIssues")
        return
      }
      const issues = await client.listIssues({ projectId: firstProjectId })
      expect(Array.isArray(issues)).toBe(true)
      console.log(`listIssues: ${issues.length} issue(s)`)
      for (const issue of issues.slice(0, 3)) {
        expect(typeof issue.iid).toBe("number")
        expect(typeof issue.title).toBe("string")
        expect(typeof issue.state).toBe("string")
        expect(Array.isArray(issue.labels)).toBe(true)
      }
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------------
  // 6. search scope=blobs — degrades gracefully when Advanced Search is off
  // ---------------------------------------------------------------------------

  it(
    "search blobs — succeeds or degrades without throwing",
    async () => {
      if (!GROUP_ID) {
        console.log("GITLAB_TEST_GROUP unset — skipping search test")
        return
      }
      const adapter = createGitlabAdapter({
        client,
        resolveDefaultGroupId: async () => GROUP_ID,
      })

      // searchRemote is always present on the adapter; it catches errors internally
      const result = await adapter.searchRemote(
        { query: "readme", limit: 5, filters: { groupId: GROUP_ID } },
        ACTOR,
      )

      // Must return a well-shaped result — either hits or a degraded state — never throw
      expect(Array.isArray(result.hits)).toBe(true)
      const state = result.status.state
      const validStates = ["complete", "skipped", "rate-limited", "error", "unauthorized"]
      expect(validStates.includes(state)).toBe(true)
      console.log(
        `search blobs: state="${state}" hits=${result.hits.length} message="${result.status.message ?? ""}"`,
      )
    },
    TIMEOUT,
  )
})
