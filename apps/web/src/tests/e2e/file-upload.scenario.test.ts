// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 PW-3] File upload flow: presign + PUT to the object store + confirm + the
// uploaded file surfaces in entity-level file lists. Storage backend (SeaweedFS)
// must be running. These screenshots cover thread + ticket attachment tiles,
// image thumbnails, and standard non-image filetype fallbacks.

import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { scenePng } from "./helpers/chat-media"
import { seedMailAccount, seedMailConversation } from "./helpers/mail-fixtures"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"

// Minimal valid 1x1 transparent PNG — deterministic bytes, no per-run noise.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
)

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  })
  await page.waitForTimeout(ms)
}

function kernelSchema(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

type FileParent = { app: string; entityType: string; entityId: string }

type DbFileRow = {
  id: string
  filename: string
  thumbnail_key: string | null
}

async function fileRows(env: WorkerEnv, parent: FileParent): Promise<DbFileRow[]> {
  return (await env.db.sql.unsafe(
    `SELECT id::text, filename, thumbnail_key
       FROM ${kernelSchema(env)}.files
      WHERE app = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY created_at DESC, id DESC`,
    [parent.app, parent.entityType, parent.entityId],
  )) as DbFileRow[]
}

async function waitForFileCount(
  env: WorkerEnv,
  parent: FileParent,
  count: number,
): Promise<DbFileRow[]> {
  let rows: DbFileRow[] = []
  await expect
    .poll(
      async () => {
        rows = await fileRows(env, parent)
        return rows.length
      },
      { timeout: 15_000 },
    )
    .toBe(count)
  return rows
}

async function waitForThumbnail(
  env: WorkerEnv,
  parent: FileParent,
  filename: string,
): Promise<DbFileRow> {
  let row: DbFileRow | undefined
  await expect
    .poll(
      async () => {
        row = (await fileRows(env, parent)).find((f) => f.filename === filename)
        return Boolean(row?.thumbnail_key)
      },
      { timeout: 25_000 },
    )
    .toBe(true)
  return row!
}

async function uploadAndWait(
  env: WorkerEnv,
  parent: FileParent,
  input: Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
  nextCount: number,
): Promise<void> {
  await input.setInputFiles(file)
  await expect(input.page().getByTestId(/^file-list-item-/)).toHaveCount(nextCount, {
    timeout: 15_000,
  })
  await waitForFileCount(env, parent, nextCount)
}

async function createThread(env: WorkerEnv, token: string, userId: string): Promise<string> {
  const created = await api(env.serverUrl, "/api/threads", {
    token,
    body: {
      forceCreate: true,
      title: `Phase 10 attachments ${Date.now()}`,
      participantIds: [userId],
      initialMessage: { content: "anchor" },
    },
  })
  expect(created.status).toBe(200)
  return created.body.data.id
}

async function openThread(page: Page, env: WorkerEnv, threadId: string): Promise<void> {
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible({ timeout: 15_000 })
}

async function openTicket(page: Page, env: WorkerEnv, ticketId: string): Promise<void> {
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticketId}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("file-list")).toBeVisible({ timeout: 15_000 })
}

const STANDARD_FILES: Array<{
  name: string
  mimeType: string
  kind: string
  buffer: Buffer
}> = [
  {
    name: "phase10-brief.pdf",
    mimeType: "application/pdf",
    kind: "pdf",
    buffer: Buffer.from("%PDF-1.4\n% phase 10 fixture\n"),
  },
  {
    name: "phase10-proposal.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
    buffer: Buffer.from("docx fixture"),
  },
  {
    name: "phase10-budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "spreadsheet",
    buffer: Buffer.from("xlsx fixture"),
  },
  {
    name: "phase10-assets.zip",
    mimeType: "application/zip",
    kind: "archive",
    buffer: Buffer.from("zip fixture"),
  },
  {
    name: "phase10-demo.mp4",
    mimeType: "video/mp4",
    kind: "video",
    buffer: Buffer.from("video fixture"),
  },
  {
    name: "phase10-call.mp3",
    mimeType: "audio/mpeg",
    kind: "audio",
    buffer: Buffer.from("audio fixture"),
  },
]

async function assertFileKinds(page: Page, rows: DbFileRow[]): Promise<void> {
  for (const f of STANDARD_FILES) {
    const row = rows.find((r) => r.filename === f.name)
    expect(row, `missing ${f.name}`).toBeTruthy()
    await expect(page.getByTestId(`file-list-preview-${row!.id}`)).toHaveAttribute(
      "data-file-kind",
      f.kind,
    )
  }
}

// NOTE: the thread-level file shelf (FileList + FileUploadButton above the
// compose bar) was removed — message attachments go through the composer's
// Attach button instead. The shelf's filetype-icon and thumbnail coverage
// lives on in the ticket-detail variants below (same components, same parent
// plumbing).

test("file-upload.ticket-standard-filetype-icons", async ({ page, env, qa, world }) => {
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const inbox = await seedInbox(env, world.org.id, {
    name: `Attachment Inbox ${Date.now()}`,
    emailAddress: `attachments-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, world.org.id, {
    subject: `Phase 10 ticket attachments ${Date.now()}`,
    sourceInboxId: inbox.id,
  })
  const parent = { app: "tickets", entityType: "ticket", entityId: ticket.id }

  await loginAs(page, env, "admin@test.com", "12345678")
  await openTicket(page, env, ticket.id)

  const fileInput = page.getByTestId("file-upload-input").first()
  for (let i = 0; i < STANDARD_FILES.length; i++) {
    await uploadAndWait(env, parent, fileInput, STANDARD_FILES[i]!, i + 1)
  }

  await expect(page.getByTestId("file-upload-error")).toHaveCount(0)
  const rows = await waitForFileCount(env, parent, STANDARD_FILES.length)
  await assertFileKinds(page, rows)

  await settle(page)
  await expect(page.getByTestId("file-list")).toHaveScreenshot(
    "file-list-ticket-standard-filetypes.png",
    { maxDiffPixelRatio: 0.05 },
  )
})

test("file-upload.ticket-image-thumbnail-preview", async ({ page, env, qa, world }) => {
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const inbox = await seedInbox(env, world.org.id, {
    name: `Image Attachment Inbox ${Date.now()}`,
    emailAddress: `image-attachments-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, world.org.id, {
    subject: `Phase 10 ticket image attachment ${Date.now()}`,
    sourceInboxId: inbox.id,
  })
  const parent = { app: "tickets", entityType: "ticket", entityId: ticket.id }

  await loginAs(page, env, "admin@test.com", "12345678")
  await openTicket(page, env, ticket.id)

  const fileInput = page.getByTestId("file-upload-input").first()
  await uploadAndWait(
    env,
    parent,
    fileInput,
    { name: "phase10-ticket-image.png", mimeType: "image/png", buffer: TINY_PNG },
    1,
  )

  const image = await waitForThumbnail(env, parent, "phase10-ticket-image.png")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByTestId(`file-list-thumbnail-${image.id}`)).toBeVisible({ timeout: 15_000 })

  await settle(page)
  await expect(page.getByTestId("file-list")).toHaveScreenshot(
    "file-list-ticket-image-preview.png",
    {
      maxDiffPixelRatio: 0.05,
    },
  )
})

// ---------------------------------------------------------------------------
// [Attachments] Phase 10 attachments — message-level (compose session →
// kernel:message reparent). Verifies the composer's session-aware upload,
// reparent on send, and AttachmentStrip rendering below the sent message.
// Snapshot baselines must be regenerated after the dev server + the object store are
// running: `bunx --bun playwright test --update-snapshots=all --grep
// "Attachments"`.
// ---------------------------------------------------------------------------

// Full thread conversation: multi-user back-and-forth ending in a message with
// attachments. Screenshot covers header + earlier messages + composer state so
// the attachment chips can be evaluated in real UI density.
test("[Attachments] full thread conversation with attachments", async ({ page, env, qa }) => {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Q4 launch design`,
      participantIds: [qa.amina.id, qa.lucas.id, qa.admin.id],
      initialMessage: { content: "Sharing the latest launch deck for review." },
    },
  })
  const threadId = created.body.data.id

  // Seed a few earlier messages from different participants to give the page realistic density.
  const send = async (token: string, content: string) => {
    await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token,
      body: { content },
    })
  }
  await send(qa.amina.token, "Looks great — I had two notes on the pricing slide.")
  await send(qa.lucas.token, "Same — let me drop the proposal PDF in here.")
  await send(qa.admin.token, "Perfect, will add the spec sheet too.")

  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  // Open the composer-session upload through the `+` on the control line,
  // which clicks the composer's one hidden file input.
  const attachBtn = page.getByTestId("composer-plus").first()
  await expect(attachBtn).toBeVisible({ timeout: 15_000 })
  await attachBtn.click()

  const input = page.getByTestId("attachment-upload-input").first()
  await expect(input).toHaveCount(1, { timeout: 15_000 })
  await input.setInputFiles([
    { name: "launch-deck.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") },
    {
      name: "spec-sheet.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("docx"),
    },
    {
      name: "pricing-v2.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("xlsx"),
    },
  ])

  // All three staged before the send: a file still uploading when the
  // message goes out is not guaranteed to travel with it.
  const staged = page.getByTestId("composer-attachment-strip")
  for (const name of ["launch-deck.pdf", "spec-sheet.docx", "pricing-v2.xlsx"]) {
    await expect(staged.getByTitle(name)).toBeVisible({ timeout: 15_000 })
  }

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Here are the latest revs — deck, spec, and updated pricing.")
  await page.getByTestId("compose-send").click()

  // Sent message has attachments.
  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Here are the latest revs" })
    .first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  // The strip mounts before its cards finish hydrating from the message's
  // attachment list — assert the count with the same load-tolerant budget the
  // rest of this file uses, so a slow render under worker contention can't
  // race the default 5s expect window.
  await expect(sent.getByTestId(/^attachment-card-/)).toHaveCount(3, { timeout: 20_000 })

  await settle(page)
  // Full conversation pane screenshot for UX review.
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot(
    "thread-conversation-with-attachments.png",
    { maxDiffPixelRatio: 0.05, mask: [page.locator("time, [data-time]")] },
  )
})

test("[Attachments] composer strip shows staged files before send", async ({ page, env, qa }) => {
  const threadId = await createThread(env, qa.admin.token, qa.admin.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  // The native picker must open on the FIRST click — the `+` clicks the one
  // hidden file input, not a two-stage session bootstrap. Feed the files
  // through the chooser itself to exercise the real user path.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("composer-plus").first().click(),
  ])
  await chooser.setFiles([
    // A real picture: the staged tile is a crop of it, which a 1x1 pixel
    // cannot show (the tile used to be a blank "PNG" badge on the iPhone).
    { name: "draft-image.png", mimeType: "image/png", buffer: scenePng() },
    {
      name: "draft-brief.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\ndraft\n"),
    },
  ])

  const strip = page.getByTestId("composer-attachment-strip")
  // The strip draws thumbnails, not names: each chip carries its filename as
  // its title (StagedAttachmentChips), which is what identifies it here.
  await expect(strip.getByTitle("draft-image.png")).toBeVisible({ timeout: 15_000 })
  await expect(strip.getByTitle("draft-brief.pdf")).toBeVisible({ timeout: 15_000 })

  await settle(page)
  await expect(strip).toHaveScreenshot("composer-attachment-strip-draft.png", {
    maxDiffPixelRatio: 0.05,
  })
})

test("[Attachments] thread attachment-only send is allowed when text is empty", async ({
  page,
  env,
  qa,
}) => {
  const threadId = await createThread(env, qa.admin.token, qa.admin.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  await page.getByTestId("composer-plus").first().click()
  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles({
      name: "lone-attachment.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nempty-text send\n"),
    })

  // Staged (the chip carries its filename as its title once the upload is
  // confirmed), not merely picked.
  await expect(
    page
      .getByTestId("composer-attachment-strip")
      .getByTitle("lone-attachment.pdf", { exact: true }),
  ).toBeVisible({ timeout: 15_000 })
  // Send button is enabled even though the editor is empty.
  const send = page.getByTestId("compose-send")
  await expect(send).toBeEnabled({ timeout: 15_000 })
  await send.click()

  // Sent message has a strip but no text body content.
  const sentStrip = page
    .getByTestId("attachment-strip")
    .filter({ hasText: "lone-attachment.pdf" })
    .first()
  await expect(sentStrip).toBeVisible({ timeout: 20_000 })
})

// ---------------------------------------------------------------------------
// Helpers for message-level attachment seeding (no object store required for the row).
// ---------------------------------------------------------------------------

async function seedMessageAttachment(
  env: WorkerEnv,
  params: {
    orgId: string
    userId: string
    app: string
    entityType: string
    entityId: string
    filename: string
    mimeType: string
    sizeBytes: number
    disposition?: "inline" | "attachment"
    contentId?: string | null
    ordinal?: number
  },
): Promise<string> {
  const { randomUUID } = await import("node:crypto")
  const fileId = randomUUID()
  const storageKey = `orgs/${params.orgId}/${params.app}/${params.entityType}/${params.entityId}/${fileId}/${params.filename}`
  const ks = kernelSchema(env)
  await env.db.sql.unsafe(
    `INSERT INTO ${ks}.files
      (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
       storage_key, uploaded_by, disposition, content_id, original_content_id, ordinal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      fileId,
      params.orgId,
      params.app,
      params.entityType,
      params.entityId,
      params.filename,
      params.mimeType,
      params.sizeBytes,
      storageKey,
      params.userId,
      params.disposition ?? "attachment",
      params.contentId ?? null,
      params.contentId ? `<${params.contentId}>` : null,
      params.ordinal ?? 0,
    ],
  )
  return fileId
}

// ---------------------------------------------------------------------------
// [Attachments] Ticket message attachments — inbound message with PDF chip.
// ---------------------------------------------------------------------------

// Full ticket conversation: 4-message back-and-forth, two messages carry
// attachments (one inbound report PDF + screenshot, one outbound spec PDF).
test("[Attachments] full ticket conversation with attachments", async ({
  page,
  env,
  qa,
  world,
}) => {
  const { seedTicketMessages } = await import("./helpers/seed")
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const inbox = await seedInbox(env, world.org.id, {
    name: `Attachments Inbox ${Date.now()}`,
    emailAddress: `attachments-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, world.org.id, {
    subject: `Login screen freezes after 2FA`,
    sourceInboxId: inbox.id,
  })

  // Replace the placeholder "hello world" inbound from seedTicket with a real
  // multi-message back-and-forth.
  const ts = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
  await env.db.sql.unsafe(
    `UPDATE ${ts}.messages
        SET text_body = $2,
            html_body = $3,
            from_email = $4,
            from_name = $5
      WHERE ticket_id = $1`,
    [
      ticket.id,
      "Hi support — our login screen freezes right after the 2FA prompt. Attached the screenshot + the browser console export.",
      "<p>Hi support — our login screen freezes right after the 2FA prompt. Attached the screenshot + the browser console export.</p>",
      "jordan@acmecorp.test",
      "Jordan Lee",
    ],
  )

  const [originalMsg] = (await env.db.sql.unsafe(
    `SELECT id::text FROM ${ts}.messages WHERE ticket_id = $1 ORDER BY sent_at ASC LIMIT 1`,
    [ticket.id],
  )) as Array<{ id: string }>

  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "tickets",
    entityType: "message",
    entityId: originalMsg.id,
    filename: "freeze-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 184_320,
    disposition: "attachment",
    ordinal: 0,
  })
  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "tickets",
    entityType: "message",
    entityId: originalMsg.id,
    filename: "browser-console.log.txt",
    mimeType: "text/plain",
    sizeBytes: 8_412,
    disposition: "attachment",
    ordinal: 1,
  })

  // Append more thread messages.
  await seedTicketMessages(env, world.org.id, ticket.id, [
    {
      kind: "note",
      textBody: "Looks similar to last week's SSO regression — pinging engineering.",
      fromName: "Elodie",
      sentAtOffsetSeconds: -3000,
    },
    {
      kind: "outbound",
      textBody:
        "Thanks for the report Jordan. We rolled out a fix to the 2FA flow at 14:00 UTC — could you clear cookies and try again? Attached the release notes.",
      htmlBody:
        "<p>Thanks for the report Jordan. We rolled out a fix to the 2FA flow at 14:00 UTC — could you clear cookies and try again? Attached the release notes.</p>",
      fromName: "Elodie",
      fromEmail: "support@acme.test",
      sentAtOffsetSeconds: -1800,
    },
    {
      kind: "inbound",
      textBody: "Cleared cookies — works again. Thanks!",
      htmlBody: "<p>Cleared cookies — works again. Thanks!</p>",
      fromName: "Jordan Lee",
      fromEmail: "jordan@acmecorp.test",
      sentAtOffsetSeconds: -300,
    },
  ])

  // Attach the release notes PDF to the outbound reply.
  const [outboundMsg] = (await env.db.sql.unsafe(
    `SELECT id::text FROM ${ts}.messages WHERE ticket_id = $1 AND kind = 'outbound' LIMIT 1`,
    [ticket.id],
  )) as Array<{ id: string }>
  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "tickets",
    entityType: "message",
    entityId: outboundMsg.id,
    filename: "release-notes-2.4.1.pdf",
    mimeType: "application/pdf",
    sizeBytes: 124_572,
    disposition: "attachment",
    ordinal: 0,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId(`tickets-message-${originalMsg.id}`)).toBeVisible({
    timeout: 15_000,
  })

  await settle(page)
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot(
    "ticket-conversation-with-attachments.png",
    { maxDiffPixelRatio: 0.05, mask: [page.locator("time, [data-time]")] },
  )
})

// ---------------------------------------------------------------------------
// [Attachments] Mail inbound message renders attachment chips.
// ---------------------------------------------------------------------------

// Full mail conversation: 3-message back-and-forth between customer + support.
// Inbound has 2 attachments (spec PDF + diagram PNG); outbound reply has 1
// attachment (counter-proposal PDF). Screenshot covers the full conversation
// pane including header, all message bubbles, and the reply bar.
test("[Attachments] full mail conversation with attachments", async ({ page, env, qa, world }) => {
  const accountEmail = `mailbox-${Date.now()}@e2e.test`
  const { accountId } = await seedMailAccount(env, world.org.id, {
    userId: qa.admin.id,
    email: accountEmail,
  })
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const priya = { name: "Priya Patel", email: "priya@globex.test" }
  const {
    conversationId,
    messageIds: [inboundMessageId, outboundMessageId],
  } = await seedMailConversation(env, world.org.id, {
    accountId,
    subject: "Q4 renewal — pricing & SOW",
    isRead: true,
    lastMessageAt: new Date().toISOString(),
    messages: [
      {
        direction: "inbound",
        textBody:
          "Hi Elodie — passing along the proposed pricing for Q4 + the latest SOW draft. Let me know if anything needs tweaking before we route to legal.",
        htmlBody:
          "<p>Hi Elodie — passing along the proposed pricing for Q4 + the latest SOW draft.</p><p>Let me know if anything needs tweaking before we route to legal.</p>",
        from: priya,
        to: [{ email: accountEmail }],
        sentAt: minutesAgo(90),
        isRead: true,
      },
      {
        direction: "outbound",
        textBody:
          "Thanks Priya — pricing looks good. Two notes on the SOW: (1) we'll need 60 days for the data-residency clause, (2) attached our counter on the support tier. Happy to jump on a call if easier.",
        htmlBody:
          "<p>Thanks Priya — pricing looks good.</p><p>Two notes on the SOW: (1) we'll need <strong>60 days</strong> for the data-residency clause, (2) attached our counter on the support tier.</p><p>Happy to jump on a call if easier.</p>",
        from: { name: "Elodie", email: accountEmail },
        to: [{ email: priya.email }],
        sentAt: minutesAgo(45),
        isRead: true,
        sentByUserId: qa.admin.id,
      },
      {
        direction: "inbound",
        textBody: "Looks great — pushing to legal today. Will circle back end of week.",
        htmlBody:
          "<p>Looks great — pushing to legal today.</p><p>Will circle back end of week.</p>",
        from: priya,
        to: [{ email: accountEmail }],
        sentAt: minutesAgo(5),
        isRead: true,
      },
    ],
  })

  // Inbound — 2 attachments (PDF + image).
  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "mail",
    entityType: "message",
    entityId: inboundMessageId,
    filename: "Q4-pricing-proposal.pdf",
    mimeType: "application/pdf",
    sizeBytes: 312_540,
    disposition: "attachment",
    ordinal: 0,
  })
  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "mail",
    entityType: "message",
    entityId: inboundMessageId,
    filename: "SOW-draft-v3.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 78_320,
    disposition: "attachment",
    ordinal: 1,
  })

  // Outbound — 1 attachment (counter PDF).
  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "mail",
    entityType: "message",
    entityId: outboundMessageId,
    filename: "support-tier-counter.pdf",
    mimeType: "application/pdf",
    sizeBytes: 92_104,
    disposition: "attachment",
    ordinal: 0,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/mail/${conversationId}`)
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("mail-message").first()).toBeVisible({ timeout: 15_000 })

  await settle(page)
  await page.waitForTimeout(800)
  // Resize the viewport tall enough that all three messages fit without
  // scrolling, then snapshot the whole tab-content-area. This bypasses the
  // mail conversation's auto-scroll-to-bottom behavior.
  await page.setViewportSize({ width: 1440, height: 1800 })
  await page.waitForTimeout(400)
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot(
    "mail-conversation-with-attachments.png",
    { maxDiffPixelRatio: 0.05, mask: [page.locator("time, [data-time]")] },
  )
})

// ---------------------------------------------------------------------------
// [Attachments] Mail outbound (sent) message renders attachment chips. Seeds
// a conversation with a `direction='outbound'` message + reparented files —
// the same DB shape that `sendDraft` produces after MIME assembly + reparent.
// ---------------------------------------------------------------------------

test("[Attachments] mail outbound message renders sent attachment chips", async ({
  page,
  env,
  qa,
  world,
}) => {
  const accountEmail = `mail-outbound-${Date.now()}@e2e.test`
  const { accountId } = await seedMailAccount(env, world.org.id, {
    userId: qa.admin.id,
    email: accountEmail,
  })
  const {
    conversationId,
    messageIds: [sentMessageId],
  } = await seedMailConversation(env, world.org.id, {
    accountId,
    subject: `Outbound attachments ${Date.now()}`,
    isRead: true,
    lastMessageAt: new Date().toISOString(),
    messages: [
      {
        direction: "outbound",
        textBody: "see attached",
        htmlBody: "<p>see attached files</p>",
        from: { email: accountEmail, name: "Elodie" },
        to: [{ email: "customer@external.test" }],
        sentAt: new Date(Date.now() - 60_000).toISOString(),
        isRead: true,
        sentByUserId: qa.admin.id,
      },
    ],
  })

  await seedMessageAttachment(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    app: "mail",
    entityType: "message",
    entityId: sentMessageId,
    filename: "reply-brief.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    disposition: "attachment",
    ordinal: 0,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/mail/${conversationId}`)
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("mail-message").first()).toBeVisible({ timeout: 15_000 })

  const sent = page.getByTestId("mail-message").first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 15_000 })
  await expect(sent.getByTestId(/^attachment-card-/)).toHaveCount(1)

  await settle(page)
  await expect(sent).toHaveScreenshot("mail-outbound-attachments.png", {
    maxDiffPixelRatio: 0.05,
  })
})

// ---------------------------------------------------------------------------
// [Attachments] Staged chip can be removed before send.
// ---------------------------------------------------------------------------

test("[Attachments] staged composer chip is removable before send", async ({ page, env, qa }) => {
  const threadId = await createThread(env, qa.admin.token, qa.admin.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("composer-plus").first().click(),
  ])
  await chooser.setFiles([
    { name: "keep-me.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nkeep\n") },
    { name: "drop-me.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\ndrop\n") },
  ])

  // Both STAGED, not merely picked: a file still uploading shows in the strip
  // too (a spinner tile with no title), so waiting on its name as text let
  // the click land on the only remove button there was: keep-me's.
  const strip = page.getByTestId("composer-attachment-strip")
  await expect(strip.getByTitle("keep-me.pdf", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(strip.getByTitle("drop-me.pdf", { exact: true })).toBeVisible({ timeout: 15_000 })

  // Remove one chip — it must leave the strip AND not ride the sent message.
  await strip.locator('[data-testid^="composer-attachment-remove-"]').last().click()
  await expect(strip).not.toContainText("drop-me.pdf", { timeout: 10_000 })

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Only one file should arrive.")
  await page.getByTestId("compose-send").click()

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Only one file should arrive" })
    .first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  await expect(sent.getByTestId(/^attachment-card-/)).toHaveCount(1, { timeout: 20_000 })
  await expect(sent.getByTestId("attachment-strip")).toContainText("keep-me.pdf")
})

// Walk 3: a file still uploading had no remove control, so a slow upload
// could not be dropped. The storage PUT is held open here; removing the tile
// must abort it, take the tile away, let the send queued behind it go out
// without the file, and leave no file row on the server.
test("[Attachments] a file still uploading can be removed, and the queued send goes without it", async ({
  page,
  env,
  qa,
}) => {
  const threadId = await createThread(env, qa.admin.token, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  // Every byte upload (presigned PUT or the API relay) hangs until aborted.
  let putsSeen = 0
  await page.route(
    (url) => url.pathname.includes("/file-relay/") || url.port === "9000",
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      putsSeen++
      // Never answered: the browser aborts it, or the page closes.
    },
  )

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("composer-plus").first().click(),
  ])
  await chooser.setFiles({
    name: "stuck-upload.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nstuck\n"),
  })
  const tile = page.getByTestId("composer-attachment-uploading")
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => putsSeen, { timeout: 10_000 }).toBeGreaterThan(0)

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Sent without the stuck file.")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("compose-send")).toHaveAttribute("data-queued", "true")

  await tile.getByRole("button", { name: "Remove stuck-upload.pdf" }).click()
  await expect(tile).toHaveCount(0)
  await expect(page.getByTestId("composer-attachment-strip")).toHaveCount(0)

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Sent without the stuck file." })
    .first()
  await expect(sent).toBeVisible({ timeout: 10_000 })
  await expect(sent.getByTestId("attachment-strip")).toHaveCount(0)
  await expect(page.getByTestId("composer-attachment-error")).toHaveCount(0)
  const orphans = (await env.db.sql.unsafe(
    `SELECT id FROM ${kernelSchema(env)}.files WHERE filename = $1`,
    ["stuck-upload.pdf"],
  )) as unknown[]
  expect(orphans).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// [Attachments] Ticket composer: staged file rides the internal note.
// ---------------------------------------------------------------------------

test("[Attachments] ticket note carries a staged attachment", async ({ page, env, qa, world }) => {
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const inbox = await seedInbox(env, world.org.id, {
    name: `Note Attach Inbox ${Date.now()}`,
    emailAddress: `note-attach-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, world.org.id, {
    subject: `Attachment on internal note`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 15_000 })

  // Switch to the internal-note tab, attach via the native chooser (first
  // click must open it), and confirm the staged strip renders in the composer.
  await page.getByTestId("tickets-composer-mode-note").click()
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("attachment-upload-button").first().click(),
  ])
  await chooser.setFiles({
    name: "internal-context.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\ninternal context\n"),
  })
  const strip = page.getByTestId("composer-attachment-strip")
  await expect(strip).toContainText("internal-context.pdf", { timeout: 15_000 })

  await page.getByTestId("tickets-composer-body").fill("Adding the context doc for the team.")
  await page.getByTestId("tickets-composer-submit").click()

  // The note lands in the stream with its attachment chip; the composer strip clears.
  const note = page
    .getByTestId(/^tickets-message-/)
    .filter({ hasText: "Adding the context doc" })
    .first()
  await expect(note).toBeVisible({ timeout: 20_000 })
  await expect(note.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  await expect(note.getByTestId("attachment-strip")).toContainText("internal-context.pdf")
  await expect(strip).toHaveCount(0)

  // Persisted, not just painted: the note still carries it after a reload.
  await page.reload()
  const reloaded = page
    .getByTestId(/^tickets-message-/)
    .filter({ hasText: "Adding the context doc" })
    .first()
  await expect(reloaded.getByTestId("attachment-strip")).toContainText("internal-context.pdf", {
    timeout: 20_000,
  })
})

test("[Attachments] chat send pressed during an upload is queued and goes out with the file", async ({
  page,
  env,
  qa,
}) => {
  const threadId = await createThread(env, qa.admin.token, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env, threadId)

  // Hold the upload's last step open: the file is picked, not yet staged.
  let release: () => void = () => {}
  const released = new Promise<void>((r) => (release = r))
  await page.route("**/api/files/confirm", async (route) => {
    await released
    await route.continue()
  })

  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles({
      name: "slow-brief.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nslow\n"),
    })
  await expect(page.getByTestId("composer-attachment-uploading")).toBeVisible({ timeout: 15_000 })

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Brief attached")
  const send = page.getByTestId("compose-send")
  await expect(send).toHaveAttribute("aria-label", "Send when files finish uploading")
  // Enter queues the send instead of doing nothing: the button says so, and
  // nothing has gone out yet.
  await page.keyboard.press("Enter")
  await expect(send).toHaveAttribute("data-queued", "true")
  await expect(send).toHaveAttribute(
    "aria-label",
    "Sending when files finish uploading. Press again to cancel",
  )
  await expect(page.getByTestId("compose-editor")).toContainText("Brief attached")
  await expect(page.getByTestId(/^message-row/).filter({ hasText: "Brief attached" })).toHaveCount(
    0,
  )

  // The upload lands and the message goes out by itself, WITH the file.
  release()
  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Brief attached" })
    .first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  await expect(send).not.toHaveAttribute("data-queued", "true")
  await expect(page.getByTestId("compose-editor")).not.toContainText("Brief attached")
  await page.reload()
  await expect(
    page
      .getByTestId(/^message-row/)
      .filter({ hasText: "Brief attached" })
      .first()
      .getByTestId(/^attachment-card-/),
  ).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId("composer-attachment-strip")).toHaveCount(0)
})
