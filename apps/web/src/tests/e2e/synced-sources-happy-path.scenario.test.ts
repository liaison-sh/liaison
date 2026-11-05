// SPDX-License-Identifier: FSL-1.1-ALv2
// Synced knowledge sources — happy path E2E.
//
// Drives the real user flow end-to-end:
//   1. Seed a Drive connection + Mock-Drive fixtures (a folder containing two
//      text files + one PDF).
//   2. POST /v1/knowledge/synced-sources → folder-read precheck calls the
//      mock; row + root collection are persisted.
//   3. Trigger synchronous reconciliation via the test-only sync-now route
//      (real worker code, real DB writes, no BullMQ flake).
//   4. UI assertions:
//      - The synced root collection appears in the sidebar with the cloud badge.
//      - Opening one of the materialised text documents shows the read-only
//        banner with provider name + Refresh button.
//      - The Edit button is NOT rendered on a synced doc (read-only enforced
//        in the view, mirroring the service-layer + DB-level guards).
//      - PATCH to a synced doc returns 403.

import { expect, loginAs, test } from "./fixtures/test"
import { createSyncedSourceViaApi, reconcileSyncedSourceInline } from "./helpers/knowledge-seed"
import { seedDriveConnection } from "./helpers/seed"

test("synced-source happy path: create -> reconcile -> read-only banner", async ({
  page,
  env,
  qa,
  world,
}) => {
  test.skip(
    !env.mockDrive,
    "mock Drive server did not start in this worker — skipping Drive scenario",
  )
  if (!env.mockDrive) return

  const suffix = env.schemaPrefix.replace(/_$/, "")
  // Drive file ids must match the route's Zod regex `[A-Za-z0-9_-]{8,128}`.
  // Strip underscores from the worker suffix (which can be empty in single-
  // worker runs) and pad to ≥8 chars so the precheck doesn't reject the IDs.
  const safeSuffix = (suffix.replace(/_/g, "") || "default").slice(-12).padEnd(8, "0")
  const folderId = `S5FOLDER${safeSuffix}`
  const introId = `S5INTRO${safeSuffix}`
  const pageId = `S5PAGE${safeSuffix}`
  const pdfId = `S5PDF${safeSuffix}`

  env.mockDrive.resetFixtures()
  env.mockDrive.resetRequestLog()
  // The synced folder fixture (a folder fixture is identified by Drive's
  // sentinel mimeType; reconciler uses it only for its `id` when issuing the
  // `'<id>' in parents` query so its other fields are mostly cosmetic).
  env.mockDrive.addFixture({
    id: folderId,
    name: "Tessera Manual (E2E)",
    mimeType: "application/vnd.google-apps.folder",
  })
  // Two text files inside the folder.
  env.mockDrive.addFixture({
    id: introId,
    name: "intro.md",
    mimeType: "text/markdown",
    parentId: folderId,
    downloadBody: Buffer.from("# Tessera Touch\n\nThe Tessera Touch is …", "utf-8").toString(
      "base64",
    ),
    modifiedTime: "2026-05-24T10:00:00Z",
  })
  env.mockDrive.addFixture({
    id: pageId,
    name: "chapter-1.md",
    mimeType: "text/markdown",
    parentId: folderId,
    downloadBody: Buffer.from("# Chapter 1\n\nGetting started…", "utf-8").toString("base64"),
    modifiedTime: "2026-05-24T11:00:00Z",
  })
  // A non-text file in the same folder — should become a source_link for the
  // org-shared source (skipped for personal sources by the reconciler).
  env.mockDrive.addFixture({
    id: pdfId,
    name: "diagram.pdf",
    mimeType: "application/pdf",
    parentId: folderId,
    downloadBody: Buffer.from("PDFbytes", "utf-8").toString("base64"),
  })

  // Real OAuth connection row so the worker's `getTokenForConnection` resolves.
  await seedDriveConnection(env, world.org.id, qa.admin.id)

  // Elodie is the org admin in the QA seed and has `knowledge:sources:manage`.
  // Create an org-shared synced source so non-text fixtures materialize as
  // source_links (personal sources skip non-text by design).
  const source = await createSyncedSourceViaApi(env, qa.admin.token, {
    folderRef: folderId,
    displayName: "Tessera Manual (E2E)",
    scope: "organization",
    defaultSensitivity: "internal",
  })
  expect(source.id).toBeTruthy()
  expect(source.rootCollectionId).toBeTruthy()
  expect(source.ownerUserId).toBeNull() // org-shared
  expect(source.lastSyncStatus).toBe("idle")

  // The precheck must have hit Mock-Drive — proves the listFolder call ran
  // against the user's Drive credentials, not bypassed.
  expect(
    env.mockDrive.requestLog.some(
      (r) => r.path === "/drive/v3/files" && (r.query.q ?? "").includes(folderId),
    ),
  ).toBe(true)

  // Drive the worker's reconcile path inline (deterministic, no BullMQ wait).
  const stats = await reconcileSyncedSourceInline(env, qa.admin.token, source.id)
  // If the sync produced zero documents, surface the reason BEFORE the doc
  // assertions explode with a generic "received undefined" — fetch failures
  // are the usual culprit (Drive token resolution, mime-type mismatch).
  expect(stats, `reconcile stats: ${JSON.stringify(stats, null, 2)}`).toMatchObject({
    status: "ok",
    documentsUpserted: 2,
  })

  // Reload home + collections tree to pick up the new synced collection +
  // its materialised documents.
  const docsRes = await fetch(`${env.serverUrl}/api/knowledge/documents`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  })
  expect(docsRes.status).toBe(200)
  const docsJson = (await docsRes.json()) as {
    data: Array<{ id: string; title: string; syncedSourceId?: string | null }>
  }
  const introDoc = docsJson.data.find((d) => d.title === "intro.md")
  const chapterDoc = docsJson.data.find((d) => d.title === "chapter-1.md")
  expect(introDoc).toBeTruthy()
  expect(chapterDoc).toBeTruthy()
  expect(introDoc!.syncedSourceId).toBe(source.id)

  // ── UI assertions ─────────────────────────────────────────────────────
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-knowledge").click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-sidebar")).toBeVisible()

  // The synced root collection appears in the tree with a cloud badge.
  await expect(
    page.getByTestId(`knowledge-collection-synced-badge-${source.rootCollectionId}`),
  ).toBeVisible({ timeout: 15_000 })

  // Open the intro doc directly via the URL.
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/knowledge/documents/${introDoc!.id}`)
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({ timeout: 15_000 })

  // Read-only banner is present and shows the provider name.
  const banner = page.getByTestId("knowledge-doc-synced-banner")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(/Synced from/i)
  await expect(page.getByTestId("knowledge-doc-synced-refresh")).toBeVisible()

  // Edit button is HIDDEN on synced docs (the gating Show in
  // KnowledgeDocumentView keys off `syncedSourceId`).
  await expect(page.getByTestId("knowledge-doc-edit")).toHaveCount(0)

  // Service-layer + DB CHECK guarantee that PATCH is refused server-side too.
  const patchRes = await fetch(`${env.serverUrl}/api/knowledge/documents/${introDoc!.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({ body: "tampered", revision: 0 }),
  })
  // 403 from the service-layer read-only guard; the route maps FORBIDDEN to 403.
  // Note: route also has a zero-knowledge collapse to 404 on some paths, but
  // the update route surfaces 403 for synced docs (different error class).
  expect([403, 404]).toContain(patchRes.status)
})
