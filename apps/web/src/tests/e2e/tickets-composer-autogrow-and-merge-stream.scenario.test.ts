// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-composer-autogrow-and-merge-stream — two ticket-detail UI
// regressions caught together because they share a page (one report):
//
// 1. Composer auto-grow: typing multiple lines must grow the field's
//    rendered height (bounded by its max-height), not stay pinned at a fixed
//    size with an internal scrollbar for two short lines.
// 2. Merge-survivor empty conversation: a ticket with several messages
//    (including merged-in inbound rows whose from* fields are null) plus an
//    always-rendered TicketApprovalCards block above the composer must still
//    show every message — regression coverage for the TicketDetail flex
//    layout missing `min-h-0` on the conversation-stream wrapper, which
//    starved the scrollable stream to zero height once TicketApprovalCards
//    started rendering unconditionally (see TicketDetail.tsx, commit
//    a293527c).
import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/seed"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

async function settle(page: import("@playwright/test").Page, ms = 400) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}

test.describe("Tickets detail — composer autogrow + merge-survivor stream", () => {
  test("[composer] the field grows with content and caps at max height", async ({
    page,
    env,
    qa,
    world,
  }) => {
    const orgId = world.org.id
    const stamp = Date.now()
    const inbox = await seedInbox(env, orgId, {
      name: `Autogrow inbox ${stamp}`,
      emailAddress: `autogrow-${stamp}@e2e.test`,
      isDefault: true,
    })
    const ticket = await seedTicket(env, orgId, {
      subject: `Autogrow ticket ${stamp}`,
      sourceInboxId: inbox.id,
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 10000 })

    // Both tabs write in the shared editor; the note's shows its tools on focus.
    await page.getByTestId("tickets-composer-mode-note").click()
    const textarea = page.getByTestId("tickets-composer-body")
    await settle(page, 200)
    const emptyHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height)

    // Two short lines — matches the reported repro ("Hi Dieter, / Thanks for
    // reaching out!"). Height should grow, but stay well under the max.
    await textarea.fill("Hi Dieter,\nThanks for reaching out!")
    await settle(page, 200)
    const twoLineHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height)
    expect(twoLineHeight).toBeGreaterThan(emptyHeight)

    // A much longer paste should keep growing further, up to the capped
    // max-height (max-h-60, 240px, in TicketComposer.tsx), then stop.
    const manyLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long reply.`).join(
      "\n",
    )
    await textarea.fill(manyLines)
    await settle(page, 200)
    const maxedHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height)
    expect(maxedHeight).toBeGreaterThan(twoLineHeight)
    expect(maxedHeight).toBeLessThanOrEqual(241) // 240px cap + 1px rounding tolerance

    // Deleting back down to the two-line text shrinks the field again
    // (proves the grow is live, not a one-way ratchet from an initial paint).
    await textarea.fill("Hi Dieter,\nThanks for reaching out!")
    await settle(page, 200)
    const shrunkHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height)
    expect(shrunkHeight).toBeLessThan(maxedHeight)

    await settle(page)
    await expect(page.getByTestId("tickets-composer")).toHaveScreenshot(
      "tickets-composer-autogrow-two-lines.png",
      { maxDiffPixelRatio: 0.05 },
    )
  })

  test("[merge-survivor] conversation renders all 6 messages with a pending approval card present", async ({
    page,
    env,
    qa,
    world,
  }) => {
    const orgId = world.org.id
    const stamp = Date.now()
    const inbox = await seedInbox(env, orgId, {
      name: `Merge survivor inbox ${stamp}`,
      emailAddress: `merge-survivor-${stamp}@e2e.test`,
      isDefault: true,
    })
    const ticket = await seedTicket(env, orgId, {
      subject: `Merge survivor ${stamp}`,
      sourceInboxId: inbox.id,
    })

    // seedTicket already inserts one inbound "hello world" message — add 5
    // more mirroring the real repro (ticket c251d5c3, a 3-way merge
    // survivor): merge notes authored by an agent, and merged-in inbound
    // messages whose from* fields are null (the merge COPY carries
    // from_email/from_name verbatim from the source row, which is null for
    // native-channel test tickets).
    await seedTicketMessages(env, orgId, ticket.id, [
      {
        kind: "note",
        textBody: "Merging duplicate tickets into this one for AcmeSound Activation.",
      },
      {
        kind: "inbound",
        textBody: "Hi,\nstill waiting for my activation link\nregards\ndieter",
        fromEmail: null,
        fromName: null,
      },
      {
        kind: "inbound",
        textBody:
          '{"kind": "inbound", "textBody": "Hi,\\nstill waiting for my activation link\\nregards\\ndieter"}',
        fromEmail: null,
        fromName: null,
      },
      {
        kind: "note",
        textBody: "[AI] Merged duplicate tickets into this ticket.",
      },
      {
        kind: "inbound",
        textBody: "Any update on this?",
        fromEmail: null,
        fromName: null,
      },
    ])

    // A pending approval raised FOR this ticket via tool_params.ticketId (the
    // routine-raised-draft path added in a293527c) — the always-rendered
    // TicketApprovalCards block that squeezed the stream in the reported bug.
    // approval_requests.thread_id is NOT NULL — a routine-raised draft hosts
    // its approval on the routine's own output thread (not the ticket's
    // internalThreadId, which is null here, matching the real repro), so seed
    // a minimal standalone thread to satisfy the constraint.
    const approvalId = randomUUID()
    const approvalThreadId = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.threads (id, org_id, handle, title, type, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'thread', $5, now(), now())`,
      [
        approvalThreadId,
        orgId,
        `@thread-${approvalThreadId.slice(0, 8)}`,
        "Routine output",
        qa.admin.id,
      ],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.approval_requests
         (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload,
          expires_at, notify_user_ids, requested_by, status, reason, summary, created_at)
       VALUES (
         $1, $2, $3, $4, $4, 'tickets:reply',
         jsonb_build_object('ticketId', $5::text),
         jsonb_build_object('ticketId', $5::text, 'textBody', 'Draft reply pending approval'),
         now() + interval '1 hour', ARRAY[$6]::uuid[], $6, 'pending', 'gated',
         jsonb_build_object('kind', 'tickets.reply', 'title', 'Reply pending approval', 'lines', '[]'::jsonb),
         now()
       )`,
      [approvalId, orgId, `e2e-approval-${stamp}`, approvalThreadId, ticket.id, qa.admin.id],
    )

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("tickets-detail-approval-card")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("tickets-conversation")).toBeVisible({ timeout: 10000 })

    // The core regression assertion: the stream is NOT empty — every message
    // (including the null-from merged-in rows) renders, and the container has
    // real, non-zero rendered height (a min-h-0-less flex-1 collapses this to
    // 0 once an always-on sibling like the approval card claims space).
    await settle(page)
    const streamBox = await page.getByTestId("tickets-detail-stream").boundingBox()
    expect(streamBox?.height ?? 0).toBeGreaterThan(40)

    await expect(page.getByTestId("tickets-conversation").locator("article")).toHaveCount(6, {
      timeout: 10000,
    })
    await expect(page.getByTestId("tickets-conversation")).toContainText(
      "still waiting for my activation link",
    )
    await expect(page.getByTestId("tickets-conversation")).toContainText("Any update on this?")
    // Null fromName/fromEmail on an inbound row falls back to the "Unknown
    // sender" placeholder (TicketConversationStream.tsx) rather than crashing the row.
    await expect(page.getByTestId("tickets-conversation")).toContainText("Unknown sender")
  })
})
