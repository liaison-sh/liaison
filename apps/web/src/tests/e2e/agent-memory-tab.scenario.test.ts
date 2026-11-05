// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T31, the Memory tab journey at desktop width: edit MEMORY.md and a topic
// file in place, search the tree, then forget one conversation and prove the
// episode and the checkpoint are gone while every message stays.
//
// TWO OF THE THREE BACKEND CALLS THIS DRIVES DO NOT EXIST YET. The tree and
// file routes landed with batch C2
// (`apps/api/src/modules/agent/memory/memory-routes.ts`); the search and the
// forget routes the Memory tab calls are still missing:
//
//   GET  /api/agents/:agentId/memory/search?q=<query>   kernel:agent:memory:read
//        -> { hits: [{ kind, key, path?, description?, snippet, threadHandle?,
//                      messageId?, author?, date?, rowId?, requiredScopes,
//                      fusedScore }] }   (the REST counterpart of memory_search)
//   POST /api/agents/:agentId/memory/forget            kernel:agent:memory:write
//        body { threadHandle } -> { episodesDeleted, checkpointsDeleted }
//        deletes that thread's episode rows and its checkpoint versions FOR
//        THIS AGENT, leaves every message row untouched, writes one audit row.
//
// Until they land, this scenario fails at the search assertion, which is what
// a red end to end test is for. The UI degrades visibly rather than silently:
// a 404 renders `agent-memory-search-unavailable` and
// `agent-memory-forget-error`, never an empty result and never a success.

import { activeTabScope, openAgentTabByHandle } from "./agent-bootstrap"
import { expect, loginAs, test } from "./fixtures/test"

const THREAD_HANDLE = "logistics-memory-tab"
const EPISODE_PATH = `episodes/${THREAD_HANDLE}/2026-09-01.md`
const TOPIC_PATH = "project/carrier.md"
const MESSAGE_COUNT = 12

test("memory tab: edit MEMORY.md and a topic file in place, then forget a conversation", async ({
  page,
  env,
  world,
}) => {
  const ks = `${env.schemaPrefix}kernel`
  const sql = env.db.sql
  const orgId = world.org.id

  await loginAs(page, env, "admin@test.com", "12345678")

  const [viewer] = (await sql.unsafe(`SELECT id FROM "${ks}".users WHERE email = $1`, [
    "admin@test.com",
  ])) as unknown as Array<{ id: string }>
  if (!viewer) throw new Error("the signed in user is not in this worker's schema")

  // A role agent, its conversation, and the memory the conversation produced.
  const [agent] = (await sql.unsafe(
    `INSERT INTO "${ks}".agents (org_id, kind, handle, display_name)
     VALUES ($1, 'role', $2, 'Logistics')
     RETURNING id`,
    [orgId, `@${THREAD_HANDLE}`],
  )) as unknown as Array<{ id: string }>
  const agentId = agent!.id

  const [thread] = (await sql.unsafe(
    `INSERT INTO "${ks}".threads (id, org_id, handle, type, created_by)
     VALUES (gen_random_uuid(), $1, $2, 'thread', $3)
     RETURNING id`,
    [orgId, THREAD_HANDLE, viewer.id],
  )) as unknown as Array<{ id: string }>
  const threadId = thread!.id
  await sql.unsafe(
    `INSERT INTO "${ks}".thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
    [threadId, viewer.id, orgId],
  )
  // Posted through the API, not written straight into the table: the search box
  // reads verbatim transcript hits out of the search index, and only the real
  // message path puts a message there.
  const seededThread = { id: threadId, handle: THREAD_HANDLE, title: "Logistics" }
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    await world.threads.sendMessage(
      seededThread,
      world.admin,
      `the carrier account is 55123, message ${i}`,
    )
  }

  async function seedMemory(
    type: string,
    name: string,
    path: string,
    description: string,
    content: string,
    sourceThreadId: string | null,
  ) {
    await sql.unsafe(
      `INSERT INTO "${ks}".agent_memory
         (org_id, owner_agent_id, type, name, description, content, required_scopes, path,
          source_thread_id, source_kind)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8, 'agent')`,
      [orgId, agentId, type, name, description, content, path, sourceThreadId],
    )
  }
  // The index row the product writes is keyed ("_index", "_index"): that is the
  // conflict target every index write upserts on, and a row under another name
  // with the same MEMORY.md path collides on the path index instead.
  await seedMemory("_index", "_index", "MEMORY.md", "index", "- project/carrier.md\n", null)
  await seedMemory("project", "carrier", TOPIC_PATH, "The carrier account", "Account 55123.", null)
  await seedMemory(
    "episode",
    `${THREAD_HANDLE}/2026-09-01`,
    EPISODE_PATH,
    "Logistics, 1 September",
    "We agreed on the carrier account.",
    threadId,
  )
  await sql.unsafe(
    `INSERT INTO "${ks}".agent_thread_checkpoints
       (org_id, agent_id, thread_id, summary, required_scopes, token_estimate, version)
     VALUES ($1, $2, $3, 'A summary of the logistics conversation.', '{}', 100, 1)`,
    [orgId, agentId, threadId],
  )

  // The flat `/agent/profile/:id` screen is retired: memory is a TAB of the
  // agent's own page (P4c-T39), reached the way a person reaches it. The load
  // is deliberate: the agent directory is fetched once per page load and this
  // agent was seeded after sign-in, so the roster in the browser predates it.
  await page.goto(`http://localhost:${env.ports[1]}/`)
  await openAgentTabByHandle(page, `@${THREAD_HANDLE}`, "memory")
  // Every open tab stays mounted, so the assertions below name the tab in
  // front of the user rather than the whole page.
  const agentTab = activeTabScope(page)
  await expect(agentTab.getByTestId("agent-memory-tree")).toBeVisible({ timeout: 20_000 })

  // 0. Cards 38 and 40. The episodes group is "Earlier chats" (everything is
  // one conversation now, so "Past conversations" named nothing), and the
  // header's Forget needs a conversation to be about: it is absent with no file
  // open and while the New memory form is up.
  await expect(agentTab.getByTestId("agent-memory-group-episodes")).toHaveText("Earlier chats")
  await expect(agentTab.getByTestId("memory-forget-conversation")).toHaveCount(0)
  await agentTab.getByTestId("agent-memory-new").click()
  await expect(agentTab.getByTestId("agent-memory-create")).toBeVisible()
  await expect(agentTab.getByTestId("memory-forget-conversation")).toHaveCount(0)
  await agentTab.getByTestId("agent-memory-create-cancel").click()

  // 1. Edit MEMORY.md in place.
  await agentTab.getByTestId("agent-memory-file-MEMORY.md").click()
  await agentTab.getByTestId("agent-memory-edit").click()
  // The index is a technical file: written as its markdown source.
  await agentTab.getByTestId("agent-memory-source-toggle").click()
  await page.getByTestId("agent-memory-source").fill("- project/carrier.md: the carrier account\n")
  await agentTab.getByTestId("agent-memory-save").click()
  await expect(agentTab.getByTestId("agent-memory-save-error")).toHaveCount(0)
  // The editor closes only once the PATCH has come back (the draft is dropped
  // on success), so this is what says the write LANDED rather than that it was
  // merely started.
  await expect(agentTab.getByTestId("agent-memory-source")).toHaveCount(0)

  // 2. Edit one topic file in place.
  await agentTab.getByTestId(`agent-memory-file-${TOPIC_PATH}`).click()
  await agentTab.getByTestId("agent-memory-edit").click()
  await agentTab
    .getByTestId("agent-memory-editor-input")
    .fill("Account 55123, confirmed by a human.")
  await agentTab.getByTestId("agent-memory-save").click()
  await expect(agentTab.getByTestId("agent-memory-save-error")).toHaveCount(0)
  await expect(agentTab.getByTestId("agent-memory-editor-input")).toHaveCount(0)

  // 3. Both edits survive a reload, and the human stamp is on the row.
  await page.reload()
  await expect(agentTab.getByTestId("agent-memory-tree")).toBeVisible({ timeout: 20_000 })
  await agentTab.getByTestId(`agent-memory-file-${TOPIC_PATH}`).click()
  await expect(agentTab.getByTestId("agent-memory-body")).toContainText("confirmed by a human")
  const [topicRow] = (await sql.unsafe(
    `SELECT source_kind, content FROM "${ks}".agent_memory
      WHERE owner_agent_id = $1 AND path = $2`,
    [agentId, TOPIC_PATH],
  )) as unknown as Array<{ source_kind: string; content: string }>
  expect(topicRow?.source_kind).toBe("human")

  // 4. The search box, over the REST counterpart of memory_search.
  await agentTab.getByTestId("agent-memory-search-input").fill("carrier account")
  await agentTab.getByTestId("agent-memory-search-run").click()
  await expect(agentTab.getByTestId("agent-memory-search-results")).toBeVisible()
  await expect(agentTab.getByTestId("agent-memory-search-unavailable")).toHaveCount(0)
  await expect(agentTab.getByTestId("agent-memory-search-group-file")).toBeVisible()
  // The transcript leg reads the search index, which the message posts above
  // reach through the outbox: search again until it has caught up.
  await expect
    .poll(
      async () => {
        await agentTab.getByTestId("agent-memory-search-run").click()
        return await agentTab.getByTestId("agent-memory-search-group-transcript").count()
      },
      { timeout: 30_000, intervals: [1000, 2000, 3000] },
    )
    .toBeGreaterThan(0)
  await agentTab.getByTestId("agent-memory-search-clear").click()

  // 5. Forget this conversation, with its exact confirmation copy.
  await agentTab.getByTestId(`agent-memory-file-${EPISODE_PATH}`).click()
  await expect(agentTab.getByTestId("agent-memory-forget")).toHaveText("Forget this conversation")
  await agentTab.getByTestId("agent-memory-forget").click()
  await expect(agentTab.getByTestId("agent-memory-forget-confirm-text")).toHaveText(
    "This removes what Logistics remembers from this conversation. Messages stay.",
  )
  await agentTab.getByTestId("agent-memory-forget-confirm").click()
  await expect(agentTab.getByTestId("agent-memory-forget-result")).toBeVisible()
  await expect(agentTab.getByTestId("agent-memory-forget-error")).toHaveCount(0)

  // 6. What the forget did, read from the database rather than from the page.
  const [episodes] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${ks}".agent_memory
      WHERE owner_agent_id = $1 AND type = 'episode' AND source_thread_id = $2`,
    [agentId, threadId],
  )) as unknown as Array<{ n: number }>
  expect(episodes?.n).toBe(0)
  const [checkpoints] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${ks}".agent_thread_checkpoints
      WHERE agent_id = $1 AND thread_id = $2`,
    [agentId, threadId],
  )) as unknown as Array<{ n: number }>
  expect(checkpoints?.n).toBe(0)
  const [messages] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${ks}".messages WHERE thread_id = $1`,
    [threadId],
  )) as unknown as Array<{ n: number }>
  expect(messages?.n).toBe(MESSAGE_COUNT)
  const [audit] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${ks}".audit_log
      WHERE agent_id = $1 AND action = 'memory_thread_forgotten'`,
    [agentId],
  )) as unknown as Array<{ n: number }>
  expect(audit?.n).toBe(1)

  // The topic file and the index the forget must never touch are still there.
  const [survivors] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${ks}".agent_memory
      WHERE owner_agent_id = $1 AND path IN ('MEMORY.md', $2)`,
    [agentId, TOPIC_PATH],
  )) as unknown as Array<{ n: number }>
  expect(survivors?.n).toBe(2)
})
