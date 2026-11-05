// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T51 (A50), the chat dock lane: after a cold resume the chat still shows
// the whole conversation while the agent is fed the brief plus the tail, and
// the reader is told where that boundary sits. The boundary is not decoration:
// it has to MOVE when the checkpoint moves, or it lies about what the agent is
// reading a day later.
//
// (web-13 is already the approval visual lane, so this lane takes web-14.)
//
// BOUND, stated plainly: the advance here is written as the cold path writes
// it (the next checkpoint version for this agent and thread, carrying the new
// `uptoMessageId`), with the agent's last turn stamped 61 minutes back so the
// row is the one a cold resume would produce. Driving a REAL cold resume end
// to end would need a live model key to run the summarizer inside the api
// process, which this headless lane does not have: the summarizer hook
// (`CheckpointTestAccess.setSummarizer`) is in-process and the api runs in its own
// process here. What this scenario does assert for real is the product
// behaviour the task is about: the browser, after the conversation moves,
// re-reads the thread and repositions the row.

import { expect, loginAs, test } from "./fixtures/test"

const MESSAGE_COUNT = 10

test("the boundary moves after a cold resume advance", async ({ page, env, world }) => {
  const ks = `${env.schemaPrefix}kernel`
  const sql = env.db.sql
  const orgId = world.org.id

  await page.setViewportSize({ width: 1440, height: 900 })
  await loginAs(page, env, "admin@test.com", "12345678")

  const [viewer] = (await sql.unsafe(`SELECT id FROM "${ks}".users WHERE email = $1`, [
    "admin@test.com",
  ])) as unknown as Array<{ id: string }>
  if (!viewer) throw new Error("the signed in user is not in this worker's schema")

  const handle = `ctx-boundary-${Date.now().toString(36)}`
  const [agent] = (await sql.unsafe(
    `INSERT INTO "${ks}".agents (org_id, kind, handle, display_name)
     VALUES ($1, 'role', $2, 'Logistics') RETURNING id`,
    [orgId, `@${handle}`],
  )) as unknown as Array<{ id: string }>
  const agentId = agent!.id

  // A DM: the viewer and exactly one agent. Nothing else has one boundary.
  const [thread] = (await sql.unsafe(
    `INSERT INTO "${ks}".threads (id, org_id, handle, type, created_by)
     VALUES (gen_random_uuid(), $1, $2, 'agent_chat', $3) RETURNING id`,
    [orgId, handle, viewer.id],
  )) as unknown as Array<{ id: string }>
  const threadId = thread!.id
  await sql.unsafe(
    `INSERT INTO "${ks}".thread_participants (thread_id, user_id, org_id, participant_type)
     VALUES ($1, $2, $3, 'user')`,
    [threadId, viewer.id, orgId],
  )
  await sql.unsafe(
    `INSERT INTO "${ks}".thread_participants (thread_id, agent_id, org_id, participant_type)
     VALUES ($1, $2, $3, 'agent')`,
    [threadId, agentId, orgId],
  )

  const messageIds: string[] = []
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    // The agent's own last turn is the oldest of the scripted rows and is
    // stamped 61 minutes back: past the 60 minute warm window, so the next
    // turn on this thread is a cold one.
    const isAgentTurn = i === MESSAGE_COUNT - 1
    const [row] = (await sql.unsafe(
      `INSERT INTO "${ks}".messages
         (id, thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '{}', now() - interval '61 minutes' + ($7 || ' seconds')::interval)
       RETURNING id`,
      [
        threadId,
        orgId,
        viewer.id,
        isAgentTurn ? "agent" : "user",
        isAgentTurn ? agentId : null,
        `scripted row ${i}`,
        String(i),
      ],
    )) as unknown as Array<{ id: string }>
    messageIds.push(row!.id)
  }

  const firstBoundary = messageIds[2]
  await sql.unsafe(
    `INSERT INTO "${ks}".agent_thread_checkpoints
       (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
     VALUES ($1, $2, $3, $4, 'The first three rows, summarized.', '{}', 100, 1)`,
    [orgId, agentId, threadId, firstBoundary],
  )

  // `localhost`, not `127.0.0.1`: `loginAs` signs in on that host and the auth
  // cookie is host scoped, so the other spelling lands back on the login page.
  const viteUrl = `http://localhost:${env.ports[1]}`
  await page.goto(`${viteUrl}/threads/${threadId}`)

  const boundary = page.getByTestId("agent-context-boundary")
  await expect(boundary).toBeVisible({ timeout: 20_000 })
  await expect(boundary).toHaveText(
    "Earlier messages are summarized for Logistics. It can search them.",
  )
  await expect(boundary).toHaveAttribute("data-upto-message-id", firstBoundary)
  // Exactly one, and every message is still on screen: nothing is hidden by it.
  await expect(boundary).toHaveCount(1)
  await expect(page.getByText("scripted row 0")).toBeVisible()
  await expect(page.getByText(`scripted row ${MESSAGE_COUNT - 2}`)).toBeVisible()

  // The advance a cold resume writes: the next version for this (agent,
  // thread), carrying the new boundary.
  const secondBoundary = messageIds[MESSAGE_COUNT - 2]
  await sql.unsafe(
    `INSERT INTO "${ks}".agent_thread_checkpoints
       (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
     VALUES ($1, $2, $3, $4, 'Everything up to the tail, summarized.', '{}', 180, 2)`,
    [orgId, agentId, threadId, secondBoundary],
  )

  // The advance emits no thread event, so the boundary moves on the next read:
  // the read the browser does once the conversation itself moves.
  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("and where were we")
  await page.keyboard.press("Enter")

  await expect(page.getByText("and where were we")).toBeVisible({ timeout: 20_000 })
  await expect(boundary).toHaveAttribute("data-upto-message-id", secondBoundary, {
    timeout: 20_000,
  })
  await expect(boundary).toHaveCount(1)
  await expect(boundary).toHaveText(
    "Earlier messages are summarized for Logistics. It can search them.",
  )
})
