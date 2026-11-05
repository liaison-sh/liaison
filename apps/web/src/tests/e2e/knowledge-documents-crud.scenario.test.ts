// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 S1 — Local doc CRUD + search + open + attach + permissions (spec §477).
//
// The UI does not currently expose a create-doc form in KnowledgeWorkspace
// (the "Create personal note" button switches the view but does not seed a
// new row), so this scenario creates the doc via worker-token API and then
// drives every observable surface (home, search, open, attachment, scope
// badge, RLS) through the real UI + real backend.

import { expect, loginAs, test } from "./fixtures/test"
import {
  createKnowledgeDocument,
  loadKnowledgeHome,
  searchKnowledge,
} from "./helpers/knowledge-seed"

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
  deadlineMs = 20_000,
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

test("local-doc-crud-search-attach", async ({ page, env, qa, world }) => {
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const title = `Phase11 S1 Local Note ${suffix}`
  const body = "E2E body content"

  // 1. Server-side: create the personal doc with the admin's worker token.
  //    The `personal` aspect is `documentScope`; `sensitivity` is independent
  //    and defaults to "internal" for personal-scope docs (the shared schema
  //    only accepts public/internal/confidential/restricted as sensitivity).
  const doc = await createKnowledgeDocument(env, qa.admin.token, {
    title,
    body,
    documentScope: "personal",
  })

  // 2. Verify the doc appears under /api/knowledge/home → personal[].
  const home = (await loadKnowledgeHome(env, qa.admin.token)) as {
    data: { personal: Array<{ id: string; title: string }> }
  }
  const personal = home.data.personal ?? []
  expect(personal.some((row) => row.id === doc.id && row.title === title)).toBe(true)

  // 3. Login as admin and open Knowledge.
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-knowledge").click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible()

  // 3a. Wait for the indexer to pick up the new doc — the federated search
  //     surface depends on the durable consumer + BullMQ pipeline.
  await waitForKnowledgeIndex(env, qa.admin.token, doc.id, title)

  // 4. Navigate to Search; type the title and wait for the debounced (250ms)
  //    search to settle.
  await page.getByTestId("knowledge-sidebar-search-input").fill(title)

  const resultRow = page.getByTestId(`knowledge-search-result-document-${doc.id}`)
  await expect(resultRow).toBeVisible({ timeout: 10_000 })

  // 5. Click through — opens the document view via the entity-opener registry.
  await resultRow.click()
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId("knowledge-doc-title")).toHaveText(title, {
    timeout: 10_000,
  })
  // Read-mode body is the parsed/sanitized markdown view; the contenteditable
  // editor is opt-in (per-article tabs landed with click-to-edit), so the body
  // in read state lives in `knowledge-doc-body-rendered`.
  await expect(page.getByTestId("knowledge-doc-body-rendered")).toContainText(body)
  // Scope badge falls back to documentScope when sensitivity is null (the
  // path personal docs take). The badge text proves the doc is personal-scope.
  await expect(page.getByTestId("knowledge-doc-scope-badge")).toHaveText(/personal/i)

  // Tab-per-article: the opened document lives in its own dedicated tab
  // (data-tab-type exposed by TabBar), and the URL is the parameterized,
  // bookmarkable per-document route — not the singleton /knowledge home.
  await expect(page.locator('[data-testid="tabstrip"] [data-active="true"]')).toHaveAttribute(
    "data-tab-type",
    "knowledge:document",
  )
  await expect(page).toHaveURL(/\/knowledge\/documents\/[^/]+$/)

  // 6. Upload an attachment via the files API (presign → PUT → confirm) using
  //    the worker token; then reload the page so the FileList resource refetches.
  const fileName = `s1-attachment-${suffix}.txt`
  const fileContent = `phase11-s1-attachment-bytes-${suffix}`
  const presign = await fetch(`${env.serverUrl}/api/files/upload-url`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({
      app: "knowledge",
      entityType: "document",
      entityId: doc.id,
      filename: fileName,
      mimeType: "text/plain",
      sizeBytes: fileContent.length,
    }),
  })
  expect(presign.status).toBe(200)
  const presignJson = (await presign.json()) as {
    data: { uploadUrl: string; fileToken: string }
  }
  const put = await fetch(presignJson.data.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: fileContent,
  })
  expect(put.ok).toBe(true)
  const confirm = await fetch(`${env.serverUrl}/api/files/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({
      fileToken: presignJson.data.fileToken,
      disposition: "attachment",
    }),
  })
  expect(confirm.status).toBe(200)
  const confirmJson = (await confirm.json()) as {
    data: { id: string; filename: string; mimeType: string; sizeBytes: number }
  }
  expect(confirmJson.data.filename).toBe(fileName)
  expect(confirmJson.data.mimeType).toBe("text/plain")
  expect(confirmJson.data.sizeBytes).toBe(fileContent.length)

  await page.reload()
  // Bookmarkability: reloading the per-document URL restores the document tab
  // and view directly — not a redirect back to the singleton home.
  await expect(page).toHaveURL(/\/knowledge\/documents\/[^/]+$/)
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId(`file-list-item-${confirmJson.data.id}`)).toBeVisible({
    timeout: 10_000,
  })

  // 7. Backend-side files probe also returns the new row.
  const listRes = await fetch(
    `${env.serverUrl}/api/files?app=knowledge&entityType=document&entityId=${doc.id}`,
    { headers: { authorization: `Bearer ${qa.admin.token}` } },
  )
  expect(listRes.status).toBe(200)
  const listJson = (await listRes.json()) as { data: Array<{ id: string }> }
  expect(listJson.data.some((row) => row.id === confirmJson.data.id)).toBe(true)

  // 8. RLS spot-check: amina cannot read the admin's personal doc — the API must
  //    return the zero-knowledge 404 envelope (T23).
  const aminaRes = await fetch(`${env.serverUrl}/api/knowledge/documents/${doc.id}`, {
    headers: { authorization: `Bearer ${qa.amina.token}` },
  })
  expect(aminaRes.status).toBe(404)
  const aminaJson = (await aminaRes.json()) as { error: { message: string } }
  expect(aminaJson.error.message).toMatch(/not.found/i)

  // 9. Closing the active document tab returns to the singleton Knowledge
  //    home (/knowledge) — not a 404 or a dangling per-document URL.
  await page.locator('[data-testid="tabstrip"] [data-active="true"] [data-tab-close]').click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-home")).toBeVisible({
    timeout: 10_000,
  })

  // 10. H1 regression lock-in: the "Recent" row must open a real per-document
  //     tab even for a user who never opened the sidebar. Previously this
  //     short-circuited when the row wasn't pre-cached in the store.
  await page.getByTestId(`knowledge-recent-${doc.id}`).click()
  await expect(page.locator('[data-testid="tabstrip"] [data-active="true"]')).toHaveAttribute(
    "data-tab-type",
    "knowledge:document",
  )
  await expect(page).toHaveURL(/\/knowledge\/documents\/[^/]+$/)
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({
    timeout: 10_000,
  })

  // Suppress unused-world warning — fixture must be required to seed the QA org.
  void world
})
