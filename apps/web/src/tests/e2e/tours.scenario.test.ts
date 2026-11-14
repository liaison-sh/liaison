// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3 phase close (S22–S25, S27, S38): guided tours against the REAL server, no
// route stubs.
//  (a) `liaison tour start tickets.basics --user <owner>` from the CLI: the
//      panel opens in the browser already on screen (the kernel/tour:start
//      frame), "Do it for me" asks the person's agent for a draft from the
//      chat dock (a scripted model turn: its gated reply parks a real
//      approval), nothing reaches the customer, Pause, reload, the resume
//      chip, resume, the person approves the draft themselves (it goes out
//      once), the note beat completes on a note posted through the API (not a
//      click in the tour), the tour completes and the CLI exits 0 with
//      "completed, skipped 0".
//  (b) the note leg in a 390×844 phone viewport: no agent dock beside the
//      ticket there, so the note is typed and posted from the composer sheet.
//  (c) "Show me how" lists the tours and starts one.
// Replies go out through the Gmail fixture.
import { randomUUID } from "node:crypto"
import { effectiveBeats, findTour } from "@liaison/shared"
import { api } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import toursEn from "../../../../../packages/shared/src/i18n/locales/en/tours.json"
import { CryptoContext, encryptSecret } from "../../../../api/src/lib/crypto"
import {
  type GmailHttpFixture,
  startGmailHttpFixture,
} from "../../../../api/src/tests/fixtures/email/gmail-http"
import { agentDmThreadId, scriptAgentTurn } from "./agent-turn"
import { createProfiledE2ETest, type ProfiledWorkerEnv } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { startLiaisonCli } from "./helpers/liaison-cli"
import { grantTicketsScopes, seedTicket } from "./helpers/seed"
import { pressTourMenu } from "./helpers/tour-menu"

let gmail: GmailHttpFixture

const test = createProfiledE2ETest({
  workerIdOffset: 75,
  portCount: 2,
  before: async () => {
    gmail = await startGmailHttpFixture()
    return {
      env: { TICKETS_E2E_GMAIL_API_BASE_URL: gmail.apiBaseUrl },
      teardowns: [() => gmail.close()],
    }
  },
})

const TOUR_ID = "tickets.basics"
const tour = findTour(TOUR_ID)
if (!tour) throw new Error(`${TOUR_ID} is not a shipped tour`)
// This org has no API connector: the customer-card beat is not in its list.
const BEATS = effectiveBeats(tour, { installedApps: [], isDemo: false }).map((b) => b.id)
// The words Do it for me types: the tour's own copy, so the spec follows it.
const ASK_TEXT = toursEn.tickets.basics.askDraft.text
const DRAFT_TEXT = "Hello, thanks for writing. Your order left our warehouse this morning."
const NOTE_TEXT = "Checked the history: this looks like a first contact."
const PHONE_NOTE_TEXT = "Summary for the team: what the customer asks and what we already know."

const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"

const ks = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}kernel"`
const ts = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}app_tickets"`

/** A ticket on an inbox whose Gmail account sends into the fixture. */
async function ticketOnGmailInbox(
  env: ProfiledWorkerEnv,
  orgId: string,
  createdBy: string,
  label: string,
): Promise<{ id: string; account: string }> {
  const account = `tours-${label}-${Date.now()}@e2e.test`
  const connectedAccountId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.connected_accounts (
       id, org_id, app_name, connection_name, owner_type, owner_id,
       provider_type, identifier, display_name, access_token_encrypted, status, created_by
     ) VALUES ($1, $2, 'tickets', 'gmail', 'org', null, 'oauth2', $3, $3, $4, 'active', $5)`,
    [
      connectedAccountId,
      orgId,
      account,
      encryptSecret(
        "test-access-token",
        env.encryptionKey,
        CryptoContext.connectedAccountAccessToken,
      ),
      createdBy,
    ],
  )
  const inboxId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.inboxes (id, org_id, connected_account_id, name, email_address,
       default_sensitivity, is_default_for_create, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'internal', false, now(), now())`,
    [inboxId, orgId, connectedAccountId, `Tours ${label}`, account],
  )
  const ticket = await seedTicket(env, orgId, {
    subject: `Tour ticket ${label} ${Date.now()}`,
    sourceInboxId: inboxId,
  })
  return { id: ticket.id, account }
}

async function messageKinds(env: ProfiledWorkerEnv, ticketId: string): Promise<string[]> {
  const rows = await env.db.sql.unsafe<{ kind: string }[]>(
    `SELECT kind FROM ${ts(env)}.messages WHERE ticket_id = $1`,
    [ticketId],
  )
  return rows.map((r) => r.kind)
}

/** Next through the show beats until `beatId` is on screen. */
async function nextUntil(page: Page, panel: Locator, beatId: string): Promise<void> {
  for (let i = 0; i < BEATS.length; i++) {
    const current = await panel.getAttribute("data-beat-id")
    if (current === beatId) return
    await page.getByTestId("tour-next").click()
    await expect(panel).not.toHaveAttribute("data-beat-id", current ?? "", { timeout: 10_000 })
  }
  await expect(panel).toHaveAttribute("data-beat-id", beatId)
}

/** Overlap area of two elements' boxes (0 when either is not laid out). */
async function overlapPx(a: Locator, b: Locator): Promise<number> {
  const [ra, rb] = await Promise.all([a.boundingBox(), b.boundingBox()])
  if (!ra || !rb) return 0
  const w = Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x)
  const h = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Whether a press at the centre of `testid`'s visible element lands on the tour's own UI. */
function tourUiOver(page: Page, testid: string): Promise<boolean | null> {
  return page.evaluate((id) => {
    const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].find(
      (e) => e.getClientRects().length > 0,
    )
    if (!el) return null
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 24))
    return hit?.closest("[data-tour-ui]") != null
  }, testid)
}

/** A fresh admin token (granting scopes bumps the permission version, staling older ones). */
async function adminToken(env: ProfiledWorkerEnv): Promise<string> {
  const res = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  return res.body.data.accessToken as string
}

async function grantSupportScopes(env: ProfiledWorkerEnv, orgId: string, userId: string) {
  await grantTicketsScopes(env, orgId, userId, [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:tickets:reply",
    "tickets:inboxes:read",
    "tickets:approve",
  ])
}

test.describe("guided tours against the real server", () => {
  test("(a) CLI start, Do it for me asks the agent for a draft, pause, reload, resume, the person approves, complete", async ({
    authenticatedPage: page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(300_000)
    const orgId = world.org.id
    const base = `http://localhost:${env.ports[1]}`
    // approve-note shows only when the note asked first (basics.ts whenHeld).
    expect(BEATS).toEqual([
      "inbox",
      "open",
      "ask-draft",
      "review",
      "note",
      "approve-note",
      "yourself",
      "routine",
    ])
    await grantSupportScopes(env, orgId, qa.admin.id)
    const ticket = await ticketOnGmailInbox(env, orgId, qa.admin.id, "cli")
    gmail.reset()
    gmail.queueSendResponse(ticket.account, {
      id: `gm-${Date.now()}`,
      threadId: `gt-${Date.now()}`,
    })
    // The agent's turn: the scripted model drafts the gated reply (a real approval).
    await seedModelPricingAndCredits(env, orgId)
    const dmId = await agentDmThreadId(env, await adminToken(env))
    await scriptAgentTurn(env, {
      threadId: dmId,
      steps: [
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "select:tickets__reply" } }] },
        {
          toolCalls: [
            { name: "tickets__reply", args: { ticketId: ticket.id, textBody: DRAFT_TEXT } },
          ],
        },
        { text: "I drafted a reply: it is waiting for your approval." },
      ],
    })

    // The browser is open on the ticket before anything starts.
    await page.goto(`${base}/tickets/${ticket.id}`)
    const active = page.locator('[data-tab-active="true"]')
    await expect(active.getByTestId("tickets-composer")).toBeVisible({ timeout: 30_000 })
    const panel = page.getByTestId("tour-panel")
    await expect(panel).toHaveCount(0)

    // 1. The CLI starts the tour; the open tab shows it (websocket push).
    const cli = startLiaisonCli(env, base, [
      "tour",
      "start",
      TOUR_ID,
      "--user",
      ADMIN_EMAIL,
      "--timeout",
      "240",
    ])
    try {
      await expect(panel).toHaveAttribute("data-beat-id", "inbox", { timeout: 30_000 })
      await expect(panel).toHaveAttribute("data-tour-id", TOUR_ID)
      await expect.poll(() => cli.stdout(), { timeout: 10_000 }).toContain("deep link: ")
      expect(cli.stdout()).toContain(`/?tour=${TOUR_ID}`)

      // 2. Next through the show beats to the draft beat.
      await nextUntil(page, panel, "ask-draft")
      await expect(page.getByTestId("tour-step-count")).toHaveAttribute(
        "data-step",
        `${BEATS.indexOf("ask-draft") + 1}`,
      )

      // 3. "Do it for me" asks the agent from the dock; the draft waits on the ticket.
      await page.getByTestId("tour-do-for-me").click()
      await expect(page.getByTestId("tour-ghost-cursor")).toBeVisible()
      await expect(panel).toHaveAttribute("data-beat-id", "review", { timeout: 60_000 })
      const dmMessages = await env.db.sql.unsafe<{ content: string | null }[]>(
        `SELECT content FROM ${ks(env)}.messages WHERE thread_id = $1 AND author_type = 'user'`,
        [dmId],
      )
      expect(dmMessages.map((m) => m.content)).toContain(ASK_TEXT)
      const card = active.getByTestId("tickets-detail-approval-card")
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card).toContainText(DRAFT_TEXT)
      // D12: the panel keeps off the draft it asks the person to review.
      await expect.poll(() => overlapPx(panel, card), { timeout: 5_000 }).toBe(0)
      expect(await messageKinds(env, ticket.id)).not.toContain("outbound")
      expect(gmail.requests().filter((r) => r.route === "messages.send")).toHaveLength(0)

      // 4. Pause, reload: the chip, on the same beat.
      const reviewStep = `${BEATS.indexOf("review") + 1}/${BEATS.length}`
      await pressTourMenu(page, "tour-pause")
      const chip = page.getByTestId("tour-chip")
      await expect(chip).toContainText(reviewStep)
      await expect(panel).toHaveCount(0)
      await expect.poll(() => cli.stdout(), { timeout: 10_000 }).toContain("paused at beat")
      await page.reload()
      await expect(chip).toBeVisible({ timeout: 30_000 })
      await expect(chip).toContainText(reviewStep)
      await expect(panel).toHaveCount(0)

      // 5. Resume, and the person approves the draft themselves: it goes out once.
      await page.getByTestId("tour-chip-resume").click()
      await expect(panel).toHaveAttribute("data-beat-id", "review", { timeout: 10_000 })
      await expect(chip).toHaveCount(0)
      await card.getByTestId("approval-card-action-approve").click()
      await expect
        .poll(() => gmail.requests().filter((r) => r.route === "messages.send").length, {
          timeout: 20_000,
        })
        .toBe(1)
      await expect(panel).toHaveAttribute("data-beat-id", "note", { timeout: 10_000 })

      // 6. The note is posted through the API, not the tour: the beat moves on.
      const posted = await api(env.serverUrl, "/api/apps/run-tool", {
        token: await adminToken(env),
        body: { toolName: "tickets:addNote", params: { ticketId: ticket.id, text: NOTE_TEXT } },
      })
      expect(posted.status, JSON.stringify(posted.body)).toBe(200)
      await expect(panel).toHaveAttribute("data-beat-id", "yourself", { timeout: 5_000 })

      // 7. Next through the closing show beats: completed once, the CLI reports it.
      await nextUntil(page, panel, "routine")
      await page.getByTestId("tour-next").click()
      await expect(page.getByTestId("tour-completed")).toBeVisible({ timeout: 10_000 })
      const done = await cli.exited
      expect(done.code, `${done.stdout}\n${done.stderr}`).toBe(0)
      expect(done.stdout).toContain("completed, skipped 0")
      expect(done.stdout).toContain(`paused at beat ${reviewStep}`)
      expect(await messageKinds(env, ticket.id)).toEqual(
        expect.arrayContaining(["note", "outbound"]),
      )
    } catch (err) {
      process.stderr.write(
        `\n--- CLI stdout ---\n${cli.stdout()}\n--- CLI stderr ---\n${cli.stderr()}\n`,
      )
      throw err
    } finally {
      cli.kill()
    }
  })

  test("(b) the note leg at phone width (390×844)", async ({ browser, env, world, qa }) => {
    test.setTimeout(240_000)
    const orgId = world.org.id
    const base = `http://localhost:${env.ports[1]}`
    await grantSupportScopes(env, orgId, qa.admin.id)
    const ticket = await ticketOnGmailInbox(env, orgId, qa.admin.id, "phone")

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    })
    try {
      const phone = await context.newPage()
      await loginAs(phone, env, ADMIN_EMAIL, ADMIN_PASSWORD)
      const token = await adminToken(env)

      // Start the tour, then stand it on the note beat (Next is the person's own path).
      const started = await api(env.serverUrl, `/api/tours/${TOUR_ID}/start`, {
        token,
        body: {},
      })
      expect(started.status, JSON.stringify(started.body)).toBe(200)
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.tour_progress SET beat_id = 'note', beat_index = $3
         WHERE org_id = $1 AND user_id = $2 AND tour_id = '${TOUR_ID}'`,
        [orgId, qa.admin.id, BEATS.indexOf("note")],
      )

      await phone.goto(`${base}/tickets/${ticket.id}`)
      const panel = phone.getByTestId("tour-panel")
      await expect(panel).toHaveAttribute("data-beat-id", "note", { timeout: 30_000 })
      await expect(panel).toHaveAttribute("data-tier", "phone")
      await expect(phone.getByTestId("tour-spotlight")).toHaveAttribute(
        "data-anchor",
        "ticket-action-bar",
      )

      // Do it for me: the composer sheet opens, the note is typed and posted.
      await phone.getByTestId("tour-do-for-me").click()
      await expect(phone.getByTestId("ticket-composer-sheet")).toBeVisible({ timeout: 20_000 })
      // D14: the panel keeps clear of the note being written.
      await expect.poll(() => tourUiOver(phone, "tickets-composer-body")).toBe(false)
      await expect.poll(() => messageKinds(env, ticket.id), { timeout: 45_000 }).toContain("note")
      await expect(panel).toHaveAttribute("data-beat-id", "yourself", { timeout: 10_000 })
      await expect(phone.getByTestId("tour-autoplay-failed")).toHaveCount(0)
      const notes = await env.db.sql.unsafe<{ text_body: string | null }[]>(
        `SELECT text_body FROM ${ts(env)}.messages WHERE ticket_id = $1 AND kind = 'note'`,
        [ticket.id],
      )
      expect(notes.map((n) => n.text_body)).toContain(PHONE_NOTE_TEXT)
      expect(await messageKinds(env, ticket.id)).not.toContain("outbound")

      // D4: paused on the ticket, the chip stays on one line, off the action bar.
      if ((await panel.getAttribute("data-collapsed")) !== null) {
        await phone.getByTestId("tour-fold").click()
      }
      await pressTourMenu(phone, "tour-pause")
      const sheetClose = phone.getByTestId("overlay-sheet-close")
      if (await sheetClose.isVisible()) await sheetClose.click()
      const chip = phone.getByTestId("tour-chip")
      await expect(chip).toBeVisible()
      await expect(phone.getByTestId("ticket-action-bar")).toBeVisible()
      for (const id of ["ticket-action-note", "ticket-action-reply", "ticket-action-more"]) {
        await expect.poll(() => overlapPx(chip, phone.getByTestId(id)), { timeout: 5_000 }).toBe(0)
        expect(await tourUiOver(phone, id), id).toBe(false)
      }
      await expect(chip).toContainText("Resume: Tickets, step")
      const chipBox = await chip.boundingBox()
      expect(chipBox?.height ?? 0).toBeLessThanOrEqual(40)
    } finally {
      await context.close()
    }
  })

  test("(c) Show me how lists the tours and starts one", async ({
    authenticatedPage: page,
    env,
  }) => {
    test.setTimeout(120_000)
    const base = `http://localhost:${env.ports[1]}`
    // The tours walk the demo's seeded scenarios, so only a demo deployment lists them, under
    // Documentation in the Help menu. The branding read is the server saying it is one.
    await page.route("**/api/settings/branding", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgName: "Resonant Audio Labs",
            logoUrl: null,
            flags: { demo: true },
            byokModelIds: [],
          },
        }),
      }),
    )
    await page.goto(`${base}/`)
    await page.getByTestId("help-button").click()
    const menu = page.getByTestId("help-menu")
    await expect(menu.getByTestId("help-menu-docs")).toBeVisible()
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId("tours-menu-item").first()).toBeVisible({ timeout: 15_000 })
    const threads = menu.locator('[data-tour-id="kernel.threads"]')
    await expect(threads).toBeVisible()
    await threads.click()
    const panel = page.getByTestId("tour-panel")
    await expect(panel).toHaveAttribute("data-tour-id", "kernel.threads", { timeout: 15_000 })
    await expect(panel).toHaveAttribute("data-beat-id", "messages")
  })
})
