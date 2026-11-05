// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 V1 — Visual goldens for the Knowledge surfaces.
//
// Component-cropped goldens; per the calm-UI rule, capture steady states
// only — never loading flicker. Single-source goldens (local-only / Drive-
// only) instead of blended to avoid RRF tie-break drift.
//
// Following admin-roles-views-bulk-visual conventions: maxDiffPixelRatio: 0.02 — the same
// tolerance used by the existing admin-user-section-identity baseline.

import { expect, test } from "./fixtures/test"
import { createKnowledgeDocument, searchKnowledge } from "./helpers/knowledge-seed"
import { seedDriveConnection } from "./helpers/seed"

async function waitForIndex(
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
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Doc ${docId} not indexed for query "${query}"`)
}

test("visual: knowledge home populated", async ({ authenticatedPage, env, qa }) => {
  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  // Seed one personal doc so the recently-touched feed isn't empty.
  await createKnowledgeDocument(env, qa.admin.token, {
    title: `V1 home seed ${suffix}`,
    body: "seed",
    documentScope: "personal",
  })

  await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
  await expect(page.getByTestId("knowledge-home")).toBeVisible({ timeout: 15_000 })
  // Post-refresh: calm IA — single recently-touched feed + primary CTA.
  // The stat-card grid (`knowledge-home-sections`) is gone; counts moved into
  // the conditional Needs-review filter chip and the Unfiled sidebar entry.
  await expect(page.getByTestId("knowledge-home-recently-touched")).toBeVisible()
  await expect(page.getByTestId("knowledge-home-create-from-cta")).toBeVisible()
  // Settle one tick for the home payload + feed render.
  await page.waitForTimeout(1_000)

  // The recently-touched feed reflects every doc seeded into the shared
  // worker schema — height-nondeterministic across runs. Scope the golden
  // to the primary CTA region which is layout-stable: header text + button.
  await expect(page.getByTestId("knowledge-home-create-from-cta")).toHaveScreenshot(
    "phase11-knowledge-home-create-cta.png",
    { maxDiffPixelRatio: 0.02 },
  )
})

test("visual: knowledge search results (local-only)", async ({ authenticatedPage, env, qa }) => {
  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const title = `V1 Local Search ${suffix}`

  const doc = await createKnowledgeDocument(env, qa.admin.token, {
    title,
    body: "v1 local body",
    documentScope: "personal",
  })
  await waitForIndex(env, qa.admin.token, doc.id, title)

  await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
  await page.getByTestId("knowledge-sidebar-search-input").fill(title)
  // Inline federated-search hit lands in the sidebar (`[data-search-hit]`).
  await expect(page.locator("[data-search-hit]").first()).toBeVisible({
    timeout: 15_000,
  })

  // Full viewport: sidebar with inline hits + populated home
  await expect(page).toHaveScreenshot("phase11-knowledge-search-full.png", {
    maxDiffPixelRatio: 0.02,
  })
})

test("visual: knowledge search results (drive-only)", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  test.skip(!env.mockDrive, "mock Drive server did not start in this worker")
  if (!env.mockDrive) return

  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const driveTitle = `V1 Drive Doc ${suffix}`

  env.mockDrive.resetFixtures()
  env.mockDrive.resetRequestLog()
  env.mockDrive.addFixture({
    id: `v1-drive-${suffix}`,
    name: driveTitle,
    mimeType: "application/vnd.google-apps.document",
    exportBody: "v1 drive body",
    webViewLink: `${env.mockDrive.url}/preview/v1-drive-${suffix}`,
  })

  await seedDriveConnection(env, world.org.id, qa.admin.id)
  const policyRes = await fetch(`${env.serverUrl}/api/knowledge/sources/google-drive`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({ broadSearchEnabled: true }),
  })
  expect(policyRes.status).toBe(200)

  await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
  await page.getByTestId("knowledge-sidebar-search-input").fill(driveTitle)
  // Drive hits return via the same inline-search path.
  await expect(page.locator("[data-search-hit]").first()).toBeVisible({
    timeout: 15_000,
  })

  // Full viewport: sidebar with inline Drive hits
  await expect(page).toHaveScreenshot("phase11-knowledge-search-drive-full.png", {
    maxDiffPixelRatio: 0.02,
  })
})

test("visual: knowledge document view (personal)", async ({ authenticatedPage, env, qa }) => {
  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const title = `V1 Doc View ${suffix}`

  const doc = await createKnowledgeDocument(env, qa.admin.token, {
    title,
    body: "Personal doc body for visual golden",
    documentScope: "personal",
  })
  await waitForIndex(env, qa.admin.token, doc.id, title)

  await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
  // Phase 11.2: open the doc via the sidebar's inline-search hit.
  await page.getByTestId("knowledge-sidebar-search-input").fill(title)
  await expect(page.locator("[data-search-hit]").first()).toBeVisible({
    timeout: 15_000,
  })
  await page.locator("[data-search-hit]").first().click()
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId("knowledge-doc-title")).toHaveText(title)

  // Full viewport: sidebar + document view
  await expect(page).toHaveScreenshot("phase11-knowledge-document-full.png", {
    maxDiffPixelRatio: 0.02,
  })
})

// Removed: "knowledge source settings (drive connected)" visual golden. The
// in-Knowledge source-settings surface is gone — connector auth/config now
// lives in `AdminIntegrations` (settings), and visual coverage for that
// surface belongs in a settings-scenario test rather than here.

test("visual: knowledge linked source view", async ({ authenticatedPage, env, qa, world }) => {
  test.skip(!env.mockDrive, "mock Drive server did not start in this worker")
  if (!env.mockDrive) return

  const page = authenticatedPage
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const driveTitle = `V1 Linked Source ${suffix}`
  const fixtureId = `v1-link-${suffix}`

  env.mockDrive.resetFixtures()
  env.mockDrive.addFixture({
    id: fixtureId,
    name: driveTitle,
    mimeType: "application/vnd.google-apps.document",
    exportBody: "linked source body",
    webViewLink: `${env.mockDrive.url}/preview/${fixtureId}`,
  })
  await seedDriveConnection(env, world.org.id, qa.admin.id)
  // Linking requires the adapter to verify the remote file is visible —
  // enable broad search so `getRemoteMetadata` reaches the mock.
  await fetch(`${env.serverUrl}/api/knowledge/sources/google-drive`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({ broadSearchEnabled: true }),
  })

  // Create the source-link directly via API.
  const linkRes = await fetch(`${env.serverUrl}/api/knowledge/source-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({
      source: "google-drive",
      externalId: fixtureId,
      title: driveTitle,
      url: `${env.mockDrive.url}/preview/${fixtureId}`,
    }),
  })
  expect(linkRes.status, await linkRes.clone().text()).toBe(201)
  const linkJson = (await linkRes.json()) as { data: { id: string } }
  const linkId = linkJson.data.id

  // Wait for the indexer to surface the new source_link.
  await waitForIndex(env, qa.admin.token, linkId, driveTitle)

  await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
  // Phase 11.2: inline sidebar search emits both document and source_link
  // hits with the legacy entity-typed testid.
  await page.getByTestId("knowledge-sidebar-search-input").fill(driveTitle)
  const row = page.locator(`[data-testid="knowledge-search-result-source_link-${linkId}"]`).first()
  await row.waitFor({ state: "visible", timeout: 15_000 })
  await row.click()
  await expect(page.getByTestId("knowledge-linked-source-view")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId("knowledge-linked-title")).toHaveText(driveTitle)

  // Full viewport: sidebar + linked source view
  await expect(page).toHaveScreenshot("phase11-knowledge-linked-source-full.png", {
    maxDiffPixelRatio: 0.02,
  })
})
