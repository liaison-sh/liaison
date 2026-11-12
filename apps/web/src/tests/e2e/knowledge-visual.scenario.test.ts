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
