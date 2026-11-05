// SPDX-License-Identifier: FSL-1.1-ALv2
// Synced knowledge sources — UX flows: F1 (add as tab) + I4 (archived banner).
//
// F1: per the project's "no popups for cognitive work" convention the add
// flow is a tab, not a modal. The Settings page's "+ Add source" must open
// a tab whose `urlPattern: /knowledge/settings/synced-sources/add` is the
// authoring surface. The integration tests prove the registration; this
// proves the user-visible navigation.
//
// I4: when a synced source is archived (e.g. another tab hit Remove in
// Settings) the open document's banner switches to "Source removed" and the
// Refresh button is disabled. This is driven by a WS event
// `knowledge:synced_source:archive`.

import { expect, loginAs, test } from "./fixtures/test"
import { createSyncedSourceViaApi, reconcileSyncedSourceInline } from "./helpers/knowledge-seed"
import { seedDriveConnection } from "./helpers/seed"

test("add-source flow opens as a dedicated tab (F1)", async ({ page, env, qa, world }) => {
  // Seed a Drive connection so the Settings page renders cleanly (the form
  // submission would otherwise fail SOURCE_UNAVAILABLE, but here we only test
  // navigation).
  await seedDriveConnection(env, world.org.id, qa.admin.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/settings/knowledge/synced-sources`)

  await expect(page.getByTestId("synced-sources-add-button")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("synced-sources-add-button").click()

  // The tab opens at the dedicated add URL — never as an inline form on the
  // settings page (the F1 regression).
  await expect(page).toHaveURL(/\/knowledge\/settings\/synced-sources\/add$/, { timeout: 10_000 })
  await expect(page.getByTestId("knowledge-synced-source-add-tab")).toBeVisible()
  await expect(page.getByTestId("synced-source-add-form")).toBeVisible()

  // Cancel closes the tab (rather than navigating somewhere).
  await page.getByTestId("synced-source-add-cancel").click()
  await expect(page.getByTestId("knowledge-synced-source-add-tab")).toHaveCount(0)
})

test("archived synced source shows 'Source removed' banner on open doc tab (I4)", async ({
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
  const safeSuffix = (suffix.replace(/_/g, "") || "default").slice(-12).padEnd(8, "0")
  const folderId = `I4FOLDER${safeSuffix}`
  const docId = `I4DOC${safeSuffix}`

  env.mockDrive.resetFixtures()
  env.mockDrive.addFixture({
    id: folderId,
    name: "Archive Test (E2E)",
    mimeType: "application/vnd.google-apps.folder",
  })
  env.mockDrive.addFixture({
    id: docId,
    name: "note.md",
    mimeType: "text/markdown",
    parentId: folderId,
    downloadBody: Buffer.from("# Note", "utf-8").toString("base64"),
  })

  await seedDriveConnection(env, world.org.id, qa.admin.id)

  const source = await createSyncedSourceViaApi(env, qa.admin.token, {
    folderRef: folderId,
    displayName: "Archive Test (E2E)",
    scope: "organization",
    defaultSensitivity: "internal",
  })
  await reconcileSyncedSourceInline(env, qa.admin.token, source.id)

  // Find the materialised doc.
  const docsRes = await fetch(`${env.serverUrl}/api/knowledge/documents`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  })
  const docsJson = (await docsRes.json()) as {
    data: Array<{ id: string; title: string; syncedSourceId?: string | null }>
  }
  const noteDoc = docsJson.data.find((d) => d.title === "note.md")
  expect(noteDoc).toBeTruthy()

  await loginAs(page, env, "admin@test.com", "12345678")
  // `page.url()` can end with a trailing slash after loginAs — derive the
  // origin via the URL constructor so we always produce a clean path join.
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/knowledge/documents/${noteDoc!.id}`)
  await expect(page.getByTestId("knowledge-doc-synced-banner")).toBeVisible({ timeout: 15_000 })
  // Default banner state: NOT archived, refresh enabled.
  await expect(page.getByTestId("knowledge-doc-synced-banner")).not.toHaveAttribute(
    "data-source-archived",
    "true",
  )
  await expect(page.getByTestId("knowledge-doc-synced-refresh")).toBeEnabled()

  // Archive the source out-of-band (as if from another tab or Settings page).
  const delRes = await fetch(`${env.serverUrl}/api/knowledge/synced-sources/${source.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${qa.admin.token}` },
  })
  expect(delRes.status).toBe(200)

  // The WS event `knowledge:synced_source:archive` propagates to the open tab
  // and the banner re-renders. The store flips `archivedSyncedSourceIds[id]`
  // on receipt; the banner becomes a data-source-archived="true" surface and
  // the Refresh button gets a `disabled` attribute.
  await expect(page.getByTestId("knowledge-doc-source-removed")).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByTestId("knowledge-doc-synced-banner")).toHaveAttribute(
    "data-source-archived",
    "true",
  )
  await expect(page.getByTestId("knowledge-doc-synced-refresh")).toBeDisabled()
})
