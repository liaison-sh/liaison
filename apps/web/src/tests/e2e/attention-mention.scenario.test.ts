// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 PW-4] Mention → attention row → click → mark-read pipeline.
//
// End-to-end: Elodie sends a thread message mentioning Amina; the kernel
// translator writes a `kernel.attention_events` row for Amina with the thread
// as the target entity; Amina's Home renders an `attention-row-kernel-thread-
// <threadId>`; clicking opens `/threads/<threadId>` and the entity-opener
// fires `mark-read`, which causes the row to disappear from Home on refresh.
// Since D21 the row is Messages' Mentions filter, not Home: the scenario walks
// that surface and checks Home never lists the conversation.

import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

test("attention.mention-creates-row-and-mark-read", async ({ page, env, qa }) => {
  // 1. Elodie creates a thread with Amina and sends a mention message.
  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: "Phase 10 attention thread",
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "context" },
    },
  })
  expect(threadRes.status).toBe(200)
  const threadId: string = threadRes.body.data.id

  const sendRes = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
    token: qa.admin.token,
    body: {
      content: `@[${qa.amina.name}](user:${qa.amina.id}) — please review.`,
    },
  })
  expect(sendRes.status).toBe(200)

  // 2. Poll the attention-items API as Amina until the mention row appears.
  //    Budget: 30s (outbox poll = 100ms in test mode, translator is fast).
  const deadline = Date.now() + 30_000
  let mentionItem: { app: string; entity: string; entityId: string; kind: string } | null = null
  while (Date.now() < deadline) {
    const res = await fetch(`${env.serverUrl}/api/attention-items`, {
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    if (res.status === 200) {
      const body = (await res.json()) as {
        data?: { items?: Array<{ app: string; entity: string; entityId: string; kind: string }> }
      }
      const items = body.data?.items ?? []
      const hit = items.find((i) => i.entityId === threadId && i.kind === "mention")
      if (hit) {
        mentionItem = hit
        break
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  expect(mentionItem, `mention row never appeared for thread ${threadId}`).not.toBeNull()
  expect(mentionItem!.app).toBe("kernel")
  expect(mentionItem!.entity).toBe("thread")

  // 3. Log in as Amina and open Messages. Since D21 Home lists what is asked
  //    of her (decisions, alerts, queues); a kernel thread mention is a
  //    conversation, and conversations live in Messages, Mentions filter.
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.getByTestId("activity-messages").click()
  await page.waitForURL(/\/chats/, { timeout: 10_000 })
  const sidebar = page.locator('[data-testid="sidebar"]')
  await sidebar.getByTestId("chats-filter-mentions").click()

  // 4. The mentioned thread is listed under Mentions.
  const row = sidebar.locator(`[data-testid="thread-item"][data-thread-id="${threadId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })

  // 5. Click the row — the thread opens and its view marks the attention read.
  await row.click()
  await page.waitForURL((url) => url.pathname === `/threads/${threadId}`, { timeout: 10_000 })
  await expect(page.getByTestId("compose-editor").first()).toBeVisible({ timeout: 10_000 })

  // 6. Mark-read fires fire-and-forget from openEntity. Poll until the row
  //    is no longer returned by the API (budget 15 s).
  const clearedDeadline = Date.now() + 15_000
  let cleared = false
  while (Date.now() < clearedDeadline) {
    const res = await fetch(`${env.serverUrl}/api/attention-items`, {
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    if (res.status === 200) {
      const body = (await res.json()) as {
        data?: { items?: Array<{ entityId: string; kind: string }> }
      }
      const items = body.data?.items ?? []
      if (!items.some((i) => i.entityId === threadId && i.kind === "mention")) {
        cleared = true
        break
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  expect(cleared, "mention row was not cleared after open").toBe(true)

  // 7. Back on Messages' Mentions filter, the thread is no longer listed, and
  //    Home never showed it.
  await page.getByTestId("activity-messages").click()
  await sidebar.getByTestId("chats-filter-mentions").click()
  await expect(row).toHaveCount(0, { timeout: 10_000 })
  await page.getByTestId("activity-home").click()
  await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 })
  await expect(page.getByTestId(`attention-row-kernel-thread-${threadId}`)).toHaveCount(0)

  // Unified-surface guardrail — no parallel notifications surface leaks.
  const notifRes = await fetch(`${env.serverUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${qa.amina.token}` },
  })
  expect(notifRes.status).toBe(404)
})
