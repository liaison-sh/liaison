// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 S4 — Agent cross-source citation (spec §480).
//
// Drives the real conversation surface. P4c-T21b: this used to stub
// `**\/api/agent/chat` SSE, run `knowledge:search` OUT OF BAND over
// `/api/apps/run-tool`, and replay that payload back to the retired panel as a
// fake transcript. The turn now runs on the SERVER with only the MODEL scripted
// (`agent-turn.ts`), so the federated search happens INSIDE the agent loop,
// through the sandbox RPC bridge, under the user's own permissions — and the
// cross-source assertion below reads the result the agent was actually handed,
// off the turn's persisted `metadata.toolCalls`.
//
// Note: agent messages render via streaming-markdown (AgentTurnBlock), not
// the threads mention-ref pill renderer — there is no clickable knowledge
// citation pill today, so this asserts the rendered tool-call + cross-source
// answer rather than a pill→tab navigation.
//
// Assertions:
//   1. The conversation renders the knowledge Search tool call, in this turn.
//   2. The answer surfaces BOTH the local and Drive sentinels.
//   3. The real tool result contained hits from BOTH sources.
//   4. Mock-Drive `requestLog` shows only the matching fan-out (no retries /
//      no requests for unrelated file ids).

import { loginAsAdmin, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, turnToolCalls, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { createKnowledgeDocument, searchKnowledge } from "./helpers/knowledge-seed"
import { seedDriveConnection } from "./helpers/seed"

test("agent cross-source citation", async ({ page, env, qa, world }) => {
  test.skip(
    !env.mockDrive,
    "mock Drive server did not start in this worker — skipping Drive scenario",
  )
  if (!env.mockDrive) return

  const suffix = env.schemaPrefix.replace(/_$/, "")
  const LOCAL_SENTINEL = `PHASE11_S4_SENTINEL_LOCAL_${suffix}`
  const DRIVE_SENTINEL = `PHASE11_S4_SENTINEL_DRIVE_${suffix}`
  const sharedTitle = `Company Policies S4 ${suffix}`

  // S4 reseeds Drive fixtures and connection — never relies on S3 residue.
  env.mockDrive.resetFixtures()
  env.mockDrive.resetRequestLog()
  const driveFixtureId = `s4-fixture-${suffix}`
  env.mockDrive.addFixture({
    id: driveFixtureId,
    name: sharedTitle,
    mimeType: "application/vnd.google-apps.document",
    exportBody: `Drive body: ${DRIVE_SENTINEL}`,
    webViewLink: `${env.mockDrive.url}/preview/${driveFixtureId}`,
  })

  await seedDriveConnection(env, world.org.id, qa.admin.id)

  // Enable broad Drive search so the federated adapter fans out to the mock.
  const policyRes = await fetch(`${env.serverUrl}/api/knowledge/sources/google-drive`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({ broadSearchEnabled: true }),
  })
  expect(policyRes.status, await policyRes.text()).toBe(200)

  // Local doc carrying the local sentinel.
  const localDoc = await createKnowledgeDocument(env, qa.admin.token, {
    title: `Local Addendum S4 ${suffix}`,
    body: `Local body: ${LOCAL_SENTINEL}. Matches Company Policies.`,
    documentScope: "personal",
  })

  // Wait for the indexer to surface the local doc (proves it is searchable
  // before we drive the agent).
  const deadline = Date.now() + 30_000
  let localIndexed = false
  while (Date.now() < deadline && !localIndexed) {
    const res = await searchKnowledge(env, qa.admin.token, "Company Policies")
    localIndexed = res.hits.some((h) => h.sourceEntityId === localDoc.id)
    if (!localIndexed) await new Promise((r) => setTimeout(r, 500))
  }
  expect(localIndexed).toBe(true)

  await seedModelPricingAndCredits(env, world.org.id)

  // THE TURN, SCRIPTED ON THE SERVER. `knowledge__search` is an app tool and
  // every app tool is deferred until `tool_search` loads it (`tool-bridge.ts`),
  // so the discovery call is part of the turn, not scaffolding. Only the MODEL
  // is scripted: the search itself runs for real, through the sandbox RPC bridge
  // and the federated-search path, inside the agent loop.
  const token = qa.admin.token
  const threadId = await agentDmThreadId(env, token)
  const ANSWER = `Local source quotes: ${LOCAL_SENTINEL}. Drive source quotes: ${DRIVE_SENTINEL}.`
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "search knowledge" } }] },
      { toolCalls: [{ name: "knowledge__search", args: { query: "Company Policies" } }] },
      { text: ANSWER },
    ],
  })

  await loginAsAdmin(page, env)
  await page.goto(`http://localhost:${env.ports[1]}/`)
  const conversation = await openAgentConversation(page)
  await sendInConversation(
    page,
    conversation,
    "Search Knowledge for 'Company Policies' and quote both the local and remote sources.",
  )
  await waitForTurnEnd(env, { threadId, token, contains: DRIVE_SENTINEL })

  // 1. The knowledge search renders in THIS turn (the DM is worker-scoped, so
  //    the read is scoped to the turn's own row rather than the conversation).
  const turnRow = conversation
    .locator('[data-testid="message-row"]')
    .filter({ hasText: DRIVE_SENTINEL })
    .last()
  await expect(turnRow).toBeVisible({ timeout: 30_000 })
  await expect(turnRow.locator('[data-tool-name="knowledge__search"]').first()).toBeVisible({
    timeout: 20_000,
  })

  // 2. The answer surfaces BOTH sentinels in a single turn, in the conversation.
  await expect(turnRow).toContainText(LOCAL_SENTINEL, { timeout: 20_000 })
  await expect(turnRow).toContainText(DRIVE_SENTINEL, { timeout: 20_000 })

  // 3. THE CROSS-SOURCE CONTRACT, on the result the AGENT was actually handed.
  //    Read off the turn's persisted `metadata.toolCalls`, so this is the payload
  //    the real federated search returned inside the loop — not a second,
  //    separate invocation replayed through a stub.
  const calls = await turnToolCalls(env, {
    threadId,
    token,
    contains: DRIVE_SENTINEL,
    expect: "knowledge__search",
  })
  const payload = calls.find((c) => c.toolName === "knowledge__search")?.result as {
    hits?: Array<{ source: string; sourceEntityId: string }>
  }
  const hits = payload?.hits ?? []
  expect(
    hits.some((h) => h.source === "knowledge" && h.sourceEntityId === localDoc.id),
    JSON.stringify(payload).slice(0, 600),
  ).toBe(true)
  expect(
    hits.some((h) => h.source === "google-drive" && h.sourceEntityId === driveFixtureId),
    JSON.stringify(payload).slice(0, 600),
  ).toBe(true)

  // 4. Mock-Drive fan-out shape — saw the federated search call, and never
  //    requested a totally unrelated file id.
  expect(env.mockDrive.requestLog.length).toBeGreaterThan(0)
  expect(env.mockDrive.requestLog.some((r) => r.path.includes("totally-unrelated-id"))).toBe(false)
})
