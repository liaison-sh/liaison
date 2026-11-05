// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent entity-tagging browser E2E. The agent's reply carries a wire-format
// entity tag `@[Label](knowledge:document:<id>)` (the same syntax the compose
// bar serializes and the knowledge tools return as `mentionTag`). Clicking that
// tag in the conversation must open the REAL knowledge document, not a dead
// link. That is the user story the feature was built for: an agent-created
// finance doc referenced in chat is one click away.
//
// P4c-T21 retired the agent panel, and with it the two surfaces this scenario
// used to compare. There is ONE conversation now (`openAgentConversation`: a
// Home tab or an expanded dock tab), it IS the thread, and the panel's
// `a[href="knowledge:document:<id>"]` renderer went with the panel — the
// surviving render is `markdown-content.tsx`'s `[data-mention-ref]` pill, in
// the message list, on that one surface.
//
// P4c-T21b: the turn is now scripted on the SERVER (`agent-turn.ts`) instead of
// by stubbing the panel's client-side SSE, so the reply the browser reads is a
// real persisted agent message produced by the real turn pipeline.
import { randomUUID } from "node:crypto"
import { loginAsAdmin, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"

const DOC_TITLE = "E2E Tagged Doc"

test.describe("Agent entity tags — a knowledge doc reference is clickable in the conversation", () => {
  test("agent reply tag opens the doc from the conversation", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    const kn = `${env.schemaPrefix}app_knowledge`
    const adminId = world.admin.id

    // Seed a REAL knowledge document the tag will point at — the click must
    // open a populated doc tab, not a 404 shell.
    const docId = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO "${kn}".documents
         (id, org_id, title, summary, body, document_scope, owner_user_id, participant_ids,
          team, sensitivity, review_status, revision, created_by, org_access, edit_scope,
          acl_user_ids, acl_role_ids, required_scopes)
       VALUES ('${docId}', '${world.org.id}', '${DOC_TITLE}', '', 'Numbers live here.',
               'organization', '${adminId}', NULL, '[]'::jsonb, 'internal', 'unverified',
               1, '${adminId}', 'editor', NULL, '["${adminId}"]'::jsonb, '[]'::jsonb, '{}'::text[])`,
    )

    // Script the SERVER's turn: one step, the answer carrying the wire tag.
    const threadId = await agentDmThreadId(env, world.admin.token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        {
          text: `Done. I filed @[${DOC_TITLE}](knowledge:document:${docId}) in the Finance collection.`,
        },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "confirm where you filed it")

    // The turn is over when its agent message is PERSISTED — see agent-turn.ts
    // on why that is polled over the API rather than read off the DOM.
    await waitForTurnEnd(env, {
      threadId,
      token: world.admin.token,
      contains: `knowledge:document:${docId}`,
    })

    // The tag renders as an actionable mention pill in the conversation...
    const pill = conversation.locator(`[data-mention-ref="knowledge:document:${docId}"]`)
    await expect(pill).toBeVisible({ timeout: 30000 })
    await expect(pill).toHaveText(`#${DOC_TITLE}`)

    // ...and clicking it opens the REAL document, not an empty shell.
    await pill.click()
    await expect(page.getByText("Numbers live here.")).toBeVisible({ timeout: 20000 })
  })
})
