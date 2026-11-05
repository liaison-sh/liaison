// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge "Create knowledge from…" — conversational flow + live home feed.
//
// 1. The CTA no longer opens a full-screen `agent:chat` tab, and since P4c-T11
//    it no longer seeds a side panel either: off a Home surface it calls
//    `discussWithPersonalAgent` (personal-dm-store), which resolves the ONE
//    conversation with the personal agent and posts the user's intent into it
//    as a normal message. The dock brings that conversation up as an expanded
//    tab. We assert the injected user turn renders there; the agent's LLM
//    reply is deliberately not asserted — the injected turn is the UX
//    contract, the reply content is model-dependent.
// 2. The home "Recently touched" feed is live: a document created server-side
//    (outbox → WS `knowledge:document:create` → `handleKnowledgeDocumentWsEvent`
//    → `loadKnowledgeHome`) appears without any reload or navigation.

import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"

test("knowledge create-from CTA opens the personal agent DM in the dock and the home feed updates live", async ({
  page,
  env,
  qa,
}) => {
  const suffix = env.schemaPrefix.replace(/_$/, "")

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-knowledge").click()
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible()

  // 1. CTA → the personal agent DM as an expanded dock tab, carrying the
  //    injected turn `discussWithPersonalAgent` posts.
  await page.getByTestId("knowledge-home-create-from-cta").click()

  const dockTab = page.locator("[data-dock-tab]")
  await expect(dockTab).toBeVisible({ timeout: 10_000 })
  await expect(dockTab).toHaveAttribute("data-expanded", "true")
  await expect(
    dockTab
      .getByTestId("message-row")
      .filter({ hasText: "I want to discuss Create knowledge from" }),
  ).toBeVisible({ timeout: 10_000 })

  // The knowledge tab stays active — no full-screen agent:chat tab replaced it.
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible()

  // 2. Live "Recently touched": create a doc server-side; the WS create event
  //    must surface it in the open home feed with no reload.
  const title = `Create Panel Live ${suffix}`
  const doc = await createKnowledgeDocument(env, qa.admin.token, {
    title,
    body: "live-feed e2e",
    documentScope: "personal",
  })
  await expect(page.getByTestId(`knowledge-recent-${doc.id}`)).toBeVisible({ timeout: 15_000 })
})
