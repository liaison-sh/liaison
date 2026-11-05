// SPDX-License-Identifier: FSL-1.1-ALv2
// GitLab connector — browser E2E + visual golden.
//
// Drives the real user flow end-to-end:
//   1. Seed an org-owned `gitlab` credentials connection ({token, group},
//      AES-encrypted) directly into kernel.connected_accounts.
//   2. Register a mock-GitLab project whose `docs/` tree contains one markdown
//      manual, then POST /api/knowledge/synced-sources with a GitLab folderRef
//      (`<projectId>:main:docs`) — the route's listFolder precheck hits the
//      mock. Drive the worker's reconcile path inline (real resolveAdapter
//      gitlab branch → mock REST → knowledge document upsert).
//   3. Browser: authenticated page → Knowledge workspace → search the manual
//      title → assert the synced manual surfaces as
//      `knowledge-search-result-document-<id>`.
//   4. Visual golden of the result card (dark mode forced by config; timestamps
//      masked).

import { expect, test } from "./fixtures/test"
import { reconcileSyncedSourceInline, searchKnowledge } from "./helpers/knowledge-seed"
import { seedGitlabConnection } from "./helpers/seed"

const TIME_MASK = /minutes? ago|just now|hours? ago|days? ago|yesterday|ago/i

/**
 * Knowledge docs are indexed by an async durable consumer → BullMQ job
 * pipeline. Poll the federated-search endpoint until the doc appears so the
 * UI search assertion doesn't race the indexer.
 */
async function waitForKnowledgeIndex(
  env: Parameters<typeof searchKnowledge>[0],
  token: string,
  docId: string,
  query: string,
  deadlineMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const res = await searchKnowledge(env, token, query)
      if (res.hits.some((r) => r.sourceEntityId === docId)) return
    } catch {
      // Transient — retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Doc ${docId} was not indexed for query "${query}" within ${deadlineMs}ms`)
}

test("[GitLab] connector: seed creds → sync manual → search → visual", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  test.skip(!env.mockGitlab, "mock GitLab server did not start in this worker")
  if (!env.mockGitlab) return

  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  // Unique per-run manual title so the search query is deterministic.
  const manualTitle = `GitLab Manual ${suffix || "default"}`
  const manualBody = `# ${manualTitle}\n\nThis manual was synced from a GitLab repository.\n`
  const projectId = "123"
  const branch = "main"

  env.mockGitlab.resetFixtures()
  env.mockGitlab.resetRequestLog()
  // One project; its docs/ tree holds a single markdown manual.
  env.mockGitlab.setProject({
    id: projectId,
    pathWithNamespace: "acme/handbook",
    defaultBranch: branch,
    files: [
      {
        path: "docs/manual.md",
        blobId: "blobsha0001",
        body: manualBody,
        lastCommitId: "commit-aaaa-1111",
      },
    ],
  })

  // Org-owned gitlab credentials so the worker's resolveAdapter resolves a token.
  await seedGitlabConnection(env, world.org.id, qa.admin.id, {
    group: "acme",
  })

  // Create an org-shared synced source via the real HTTP route — the listFolder
  // precheck calls the mock GitLab tree endpoint.
  const folderRef = `${projectId}:${branch}:docs`
  const createRes = await fetch(`${env.serverUrl}/api/knowledge/synced-sources`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({
      appName: "gitlab",
      folderRef,
      displayName: `GitLab Handbook ${suffix || "default"}`,
      syncIntervalSeconds: 3600,
      scope: "organization",
      defaultSensitivity: "internal",
    }),
  })
  expect(createRes.status, await createRes.clone().text()).toBe(201)
  const createJson = (await createRes.json()) as {
    data: { id: string; rootCollectionId: string; ownerUserId: string | null }
  }
  const source = createJson.data
  expect(source.id).toBeTruthy()
  expect(source.ownerUserId).toBeNull() // org-shared

  // The precheck must have hit the mock GitLab tree — proves the listFolder ran
  // against the connection's credentials, not bypassed.
  expect(
    env.mockGitlab.requestLog.some((r) => r.path.includes("/repository/tree")),
    `mock-gitlab requestLog: ${JSON.stringify(env.mockGitlab.requestLog, null, 2)}`,
  ).toBe(true)

  // Drive the worker's reconcile path inline (deterministic; real resolveAdapter
  // gitlab branch + mock REST + DB writes).
  const stats = await reconcileSyncedSourceInline(env, qa.admin.token, source.id)
  expect(stats, `reconcile stats: ${JSON.stringify(stats, null, 2)}`).toMatchObject({
    status: "ok",
    documentsUpserted: 1,
  })

  // The materialised document — its title is the file basename.
  const docsRes = await fetch(`${env.serverUrl}/api/knowledge/documents`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  })
  expect(docsRes.status).toBe(200)
  const docsJson = (await docsRes.json()) as {
    data: Array<{ id: string; title: string; syncedSourceId?: string | null }>
  }
  const manualDoc = docsJson.data.find(
    (d) => d.title === "manual.md" && d.syncedSourceId === source.id,
  )
  expect(manualDoc, `documents: ${JSON.stringify(docsJson.data, null, 2)}`).toBeTruthy()
  const docId = manualDoc!.id

  // Wait for the async indexer to surface the synced doc to federated search.
  await waitForKnowledgeIndex(env, qa.admin.token, docId, "manual")

  // ── Browser journey ─────────────────────────────────────────────────────
  await page.getByTestId("activity-knowledge").click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible({ timeout: 15_000 })

  // Search the synced manual by title; the federated sidebar search returns the
  // GitLab-synced document with the entity-typed testid.
  await page.getByTestId("knowledge-sidebar-search-input").fill("manual")
  const resultCard = page.getByTestId(`knowledge-search-result-document-${docId}`)
  await expect(resultCard).toBeVisible({ timeout: 15_000 })

  // ── Visual golden — the search result card, timestamps masked ────────────
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await expect(resultCard).toHaveScreenshot("gitlab-synced-manual-search-result.png", {
    maxDiffPixelRatio: 0.02,
    mask: [resultCard.locator(`text=${TIME_MASK}`)],
  })
})
