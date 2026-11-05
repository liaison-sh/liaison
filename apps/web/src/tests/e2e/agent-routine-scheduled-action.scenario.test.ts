// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent App: Scheduled Action — the integration proof for one-shot routines +
 * agent to user notifications.
 *
 * A routine performs real tool calls: it reads a shared multi-participant
 * thread, posts a one-line summary into it with `threads_reply`, then calls
 * `notify_user`. We assert the real message landed, that every other thread
 * participant got a `thread_reply` attention row, that the owner got the
 * `agent_notification` row, and that the notification renders in the feed.
 *
 * Describe title is metachar-free per the Strobe regex memory rule.
 */
import { api } from "@liaison/test-helpers"
import { forceDarkMode, loginAsAmina } from "./agent-bootstrap"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import {
  clearAgentAppTables,
  expectRoutineRunSucceeds,
  pollUntil,
  restoreAgentAppBaseline,
  seedSharedThread,
} from "./helpers/agent-test-fixtures"
import { LIVE_LLM, LIVE_LLM_SKIP_REASON } from "./helpers/live-llm"

test.describe("Agent App: Scheduled Action", () => {
  // The routine's turn is NOT scripted: a real model reads the prompt and
  // chooses the tool calls (a routine run gets its own thread, which
  // `scriptAgentTurn` cannot name in advance). It runs only when asked for.
  test.skip(!LIVE_LLM, LIVE_LLM_SKIP_REASON)
  // This file calls clearAgentAppTables, which truncates the worker-shared
  // skills/routines seed. Restore the baseline so later files in the reused
  // Playwright worker still see it.
  test.afterAll(async ({ env }) => {
    await restoreAgentAppBaseline(env)
  })

  test("a routine performs real tool calls, posts to a shared thread, and notifies", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    const ks = `${env.schemaPrefix}kernel`

    // 1. Seed a shared thread with Amina (owner), Lucas, and Tobias.
    const threadId = await seedSharedThread(
      env,
      qa.amina.token,
      [qa.amina.id, qa.lucas.id, qa.tobias.id],
      "Scheduled action digest",
    )

    // 2. Create a routine owned by Amina that targets that thread in its prompt.
    const created = await api(env.serverUrl, "/api/agent/routines", {
      method: "POST",
      headers: { Authorization: `Bearer ${qa.amina.token}` },
      body: {
        name: "daily-thread-digest",
        description: "summarise + notify",
        kind: "recurring",
        cron: "0 8 * * *",
        timezone: "UTC",
        visibility: "personal",
        // The agent runs under the routine's declared scopes — it needs thread
        // read/write to use threads_read + threads_reply, and agent:memory for
        // notify_user. threads_reply is un-gated: agent posts are attributed
        // ("Routine {name}"), not impersonated, so no confirmation is needed.
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:agent:memory"],
        prompt:
          `Call the threads_reply tool with threadId "${threadId}" and content ` +
          `"Digest: shared thread reviewed." Then call the notify_user tool with ` +
          `summary "Digest posted".`,
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const routineId = (created.body as { data: { id: string } }).data.id

    // 3. Run it now — the real agent loop (no stub invoker). The worker creates
    //    its native routine output thread and runs the agent there.
    const run = await api(env.serverUrl, `/api/agent/routines/${routineId}/run-now`, {
      method: "POST",
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    expect(run.status, JSON.stringify(run.body)).toBe(202)

    // 4. Poll the routine run to a successful terminal status.
    await expectRoutineRunSucceeds(env, routineId)

    // 5. The shared thread received an agent-authored message, attributed to
    //    the routine — never to Amina the human.
    const msgs = (await env.db.sql.unsafe(
      `SELECT author_type, metadata FROM "${ks}".messages
       WHERE thread_id = $1 AND author_type = 'agent'`,
      [threadId],
    )) as unknown as Array<{
      author_type: string
      metadata: { agentAuthorLabel?: string } | null
    }>
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0]?.metadata?.agentAuthorLabel).toBe("Routine daily-thread-digest")

    // 6. Every other participant got a thread_reply attention row for the thread.
    for (const uid of [qa.lucas.id, qa.tobias.id]) {
      const rows = await pollUntil(
        async () => {
          const r = (await env.db.sql.unsafe(
            `SELECT count(*)::int AS n FROM "${ks}".attention_events
             WHERE user_id = $1 AND kind = 'thread_reply' AND entity_id = $2`,
            [uid, threadId],
          )) as unknown as Array<{ n: number }>
          return (r[0]?.n ?? 0) >= 1 ? r : null
        },
        { timeout: 30_000, interval: 1000, label: `thread-reply-row-${uid}` },
      )
      expect(rows[0].n).toBeGreaterThanOrEqual(1)
    }

    // 7. Amina got the agent_notification attention row.
    const notif = await pollUntil(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT summary FROM "${ks}".attention_events
           WHERE user_id = $1 AND kind = 'agent_notification'`,
          [qa.amina.id],
        )) as unknown as Array<{ summary: string }>
        return r.some((row) => row.summary === "Digest posted") ? r : null
      },
      { timeout: 30_000, interval: 1000, label: "agent-notification-row" },
    )
    expect(notif.some((r) => r.summary === "Digest posted")).toBe(true)

    // 8. Visual confirmation — Amina's attention feed shows the notification.
    await forceDarkMode(page)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await page.getByTestId("activity-home").click()
    await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })
    await expect(page.getByText("Digest posted")).toBeVisible({ timeout: 15_000 })
  })
})
