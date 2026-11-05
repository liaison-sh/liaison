// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge document "Share" feature — Google-Drive-style sharing dialog.
//
// Drives the full UI journey against the real running app + backend:
//   New document (sidebar +) → open → Share button → dialog →
//   set general access + add a person as Viewer → Save → reopen + ASSERT
//   persisted → change access to "Anyone can edit" + person to Editor →
//   Save → reopen + ASSERT both persisted.
//
// Cross-user RLS visibility is covered by the backend integration tests
// (apps/api/src/apps/knowledge/sharing.integration.test.ts); this E2E is about
// the UI journey + persistence round-trip in a real browser.

import { expect, loginAs, test } from "./fixtures/test"

test("[Knowledge] document share dialog persists general access + per-person roles", async ({
  page,
  env,
  qa,
  world,
}) => {
  // Second seeded user for the member picker. Amina Cherif exists in the QA org.
  const amina = qa.amina
  expect(amina.id).toBeTruthy()

  // 1. Log in as Elodie (the QA admin) and open Knowledge.
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-knowledge").click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible()

  // 2. Create a new document via the sidebar "+" (New document) control. The
  //    button creates an org-scoped "Untitled" doc and opens it in its own tab.
  await page.getByRole("button", { name: /new document/i }).click()
  await expect(page.getByTestId("knowledge-document-view")).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/knowledge\/documents\/[^/]+$/)

  // 3. Open the Share dialog.
  await page.getByTestId("knowledge-share-button").click()
  const dialog = page.getByTestId("knowledge-share-dialog")
  await expect(dialog).toBeVisible()
  // Wait past the loading state (sharing + members resources resolve).
  await expect(page.getByTestId("knowledge-share-add-person")).toBeVisible({ timeout: 10_000 })

  // 4. Add Amina as a person (defaults to Viewer) FIRST — picking from the
  //    picker closes its dropdown overlay, which otherwise floats over the
  //    general-access section below it. Then set general access to Restricted.
  await dialog.getByTestId("knowledge-share-add-person").click()
  await dialog.getByTestId("knowledge-share-add-person").fill("Amina")
  await dialog.getByTestId(`knowledge-share-add-option-${amina.id}`).click()

  // The person row appears with the default Viewer role.
  const personRow = dialog.getByTestId(`knowledge-share-person-${amina.id}`)
  await expect(personRow).toBeVisible()
  await expect(dialog.getByTestId(`knowledge-share-person-role-${amina.id}`)).toHaveValue("viewer")

  await dialog.getByTestId("knowledge-share-access-none").click()
  await expect(dialog.getByTestId("knowledge-share-access-none")).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  await dialog.getByTestId("knowledge-share-save").click()
  await expect(dialog).not.toBeVisible()

  // 5. Reopen and ASSERT persistence: Restricted selected + Amina listed as Viewer.
  await page.getByTestId("knowledge-share-button").click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("knowledge-share-add-person")).toBeVisible({ timeout: 10_000 })

  await expect(dialog.getByTestId("knowledge-share-access-none")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(dialog.getByTestId(`knowledge-share-person-${amina.id}`)).toBeVisible()
  await expect(dialog.getByTestId(`knowledge-share-person-role-${amina.id}`)).toHaveValue("viewer")

  // 6. Change general access to "Anyone can edit", change Amina to Editor, Save.
  //    Dismiss the add-people dropdown first (it may auto-open on the input's
  //    focus and float over the general-access section below it).
  await dialog.getByText("General access").click()
  await dialog.getByTestId("knowledge-share-access-editor").click()
  await expect(dialog.getByTestId("knowledge-share-access-editor")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await dialog.getByTestId(`knowledge-share-person-role-${amina.id}`).selectOption("editor")

  await dialog.getByTestId("knowledge-share-save").click()
  await expect(dialog).not.toBeVisible()

  // Reopen and ASSERT both persisted.
  await page.getByTestId("knowledge-share-button").click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("knowledge-share-add-person")).toBeVisible({ timeout: 10_000 })

  await expect(dialog.getByTestId("knowledge-share-access-editor")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(dialog.getByTestId("knowledge-share-access-none")).toHaveAttribute(
    "aria-pressed",
    "false",
  )
  await expect(dialog.getByTestId(`knowledge-share-person-${amina.id}`)).toBeVisible()
  await expect(dialog.getByTestId(`knowledge-share-person-role-${amina.id}`)).toHaveValue("editor")

  // 7. Belt-and-suspenders: the backend reflects the same state.
  const res = await fetch(
    `${env.serverUrl}/api/knowledge/documents/${page.url().split("/").pop()}/sharing`,
    { headers: { authorization: `Bearer ${qa.admin.token}` } },
  )
  expect(res.status).toBe(200)
  const json = (await res.json()) as {
    data: { orgAccess: string; shares: Array<{ userId: string; role: string }> }
  }
  expect(json.data.orgAccess).toBe("editor")
  expect(json.data.shares).toContainEqual({ userId: amina.id, role: "editor" })

  // Suppress unused-world warning — fixture must be required to seed the QA org.
  void world
})
