// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 S2 — Personal note isolation (spec §478).
//
// Elodie creates a personal Knowledge doc. Amina — who shares the same org
// but isn't a participant — must NOT see it through any of the four surfaces:
//   1. Knowledge workspace UI search (federated `/api/knowledge/search`)
//   2. Kernel global `/api/search`
//   3. Direct GET `/api/knowledge/documents/:id` (zero-knowledge 404 envelope)
//   4. Sandbox agent path — knowledge `search` tool via `/api/apps/run-tool`

import { expect, loginAs, test } from "./fixtures/test"
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
  throw new Error(
    `Doc ${docId} did not surface for owner via /api/knowledge/search within ${deadlineMs}ms`,
  )
}

test("personal-note-isolation", async ({ page, env, qa, world }) => {
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const title = `Elodie Private Note ${suffix}`
  const body = "secret"

  // 1. Elodie creates a private personal doc via API.
  const doc = await createKnowledgeDocument(env, qa.admin.token, {
    title,
    body,
    documentScope: "personal",
  })

  // 2. Wait for the indexer pipeline — proves admin CAN find it before
  //    we assert amina CANNOT.
  await waitForIndex(env, qa.admin.token, doc.id, title)

  // 3. SURFACE 1 — UI search as amina. Amina opens Knowledge → Search and
  //    types the title. The result list must NOT contain the admin's doc.
  await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
  await page.getByTestId("activity-knowledge").click()
  await page.getByTestId("knowledge-sidebar-search-input").fill(title)
  // 250ms debounce + indexer round-trip; give the loading state time to
  // settle to "no results" rather than racing it.
  await page.waitForTimeout(2_000)
  await expect(page.getByTestId(`knowledge-search-result-document-${doc.id}`)).toHaveCount(0)
  await expect(page.locator('[data-testid^="knowledge-search-result-document-"]')).toHaveCount(0)

  // 4. SURFACE 2 — Kernel /api/search as amina. The mention-popup queries
  //    this surface; assert the admin's doc id is excluded.
  const kernelSearchRes = await fetch(
    `${env.serverUrl}/api/search?q=${encodeURIComponent(title)}&limit=20`,
    { headers: { authorization: `Bearer ${qa.amina.token}` } },
  )
  const kernelBodyText = await kernelSearchRes.text()
  expect(kernelSearchRes.status, kernelBodyText).toBe(200)
  const kernelJson = JSON.parse(kernelBodyText) as {
    data: { entities?: Array<{ id: string; entityType: string }> }
  }
  const kernelEntities = kernelJson.data.entities ?? []
  expect(kernelEntities.every((e) => e.id !== doc.id)).toBe(true)

  // 5. SURFACE 3 — REST GET as amina → zero-knowledge 404 (T23).
  const restRes = await fetch(`${env.serverUrl}/api/knowledge/documents/${doc.id}`, {
    headers: { authorization: `Bearer ${qa.amina.token}` },
  })
  expect(restRes.status).toBe(404)
  const restJson = (await restRes.json()) as { error: { message: string } }
  expect(restJson.error.message).toMatch(/not.found/i)

  // 6. SURFACE 4 — Federated knowledge search as amina. This is the same
  //    code path agents take through the sandbox RPC bridge (which calls
  //    `registerDefaultKnowledgeSources` + federated search per request).
  //    Verify the secret body and doc id never appear in the response.
  const aminaFedRes = await searchKnowledge(env, qa.amina.token, title)
  expect(aminaFedRes.hits.every((h) => h.sourceEntityId !== doc.id)).toBe(true)
  const aminaFedPayload = JSON.stringify(aminaFedRes)
  expect(aminaFedPayload).not.toContain(doc.id)
  expect(aminaFedPayload).not.toContain(body)

  // 7. SURFACE 5 — per-tab routing. Isolation must hold even if amina
  //    directly navigates (or bookmark-shares) the per-document URL: the
  //    tab's `validateEntity` hook 404s and evicts, so the document view
  //    never renders and no `knowledge:document` tab survives.
  await page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${doc.id}`)
  await expect(page.getByTestId("knowledge-document-view")).toHaveCount(0, {
    timeout: 10_000,
  })
  await expect(
    page.locator('[data-testid="tabstrip"] [data-tab-type="knowledge:document"]'),
  ).toHaveCount(0)

  void world
})
