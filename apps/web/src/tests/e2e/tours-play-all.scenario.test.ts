// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3 phase close (S24, S26): every shipped tour plays once in a real browser
// with "Play whole scenario" against the real server (no route stubs). The tour
// starts from its deep link (`/?tour=<id>`, the link the CLI prints); show
// beats move on by themselves, do beats play their script and complete on
// their product event. Where a tour leaves the last step to the person (press
// Send in their conversation, paste an adapter, an agent writing a document),
// the test does what the person would, through the UI or the API. Sessions run
// on an org without a paired computer: the start beat says to skip it, and it
// is skipped.
//
// The agent-first tours (tickets, mail, projects, API connector) ask the
// person's agent from the chat dock. Their agent turns run on the e2e lane's
// scripted model (`LIAISON_MODEL_PROVIDER=scripted`): the script names only the
// tool calls, which run for real through the tool bridge (gated drafts park
// real approvals, the connector reads the fixture CRM), so each agentic beat
// completes on the real event and `verify` checks what the agent did.
//
// Each tour logs one `[tour-result]` line: beats completed, skipped, duration.
import { randomUUID } from "node:crypto"
import {
  beatOutcome,
  RUN_CONVERSATION,
  TOURS,
  type Tour,
  type TourBeatState,
} from "@liaison/shared"
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { loadFixtureCrmAdapter } from "../../../../api/src/apps/api-connector/__fixtures__/fixture-crm/adapter"
import {
  type FixtureCrm,
  startFixtureCrm,
} from "../../../../api/src/apps/api-connector/__fixtures__/fixture-crm/server"
import {
  type GmailHttpFixture,
  startGmailHttpFixture,
} from "../../../../api/src/tests/fixtures/email/gmail-http"
import { type ScriptedTurnStep, scriptAgentTurn, turnToolCalls } from "./agent-turn"
import { createProfiledE2ETest, type ProfiledWorkerEnv } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { seedMailAccount, seedMailConversation } from "./helpers/mail-fixtures"
import { grantProjectScopes } from "./helpers/projects-seed"
import { grantTicketsScopes, seedFactory, seedTicket } from "./helpers/seed"
import { pressTourMenu } from "./helpers/tour-menu"

let gmail: GmailHttpFixture
let crm: FixtureCrm

const CRM_KEY = "fixture-crm-tour-key"

const test = createProfiledE2ETest({
  workerIdOffset: 200,
  portCount: 2,
  before: async () => {
    gmail = await startGmailHttpFixture()
    crm = startFixtureCrm({ apiKey: CRM_KEY })
    return {
      env: {
        TICKETS_E2E_GMAIL_API_BASE_URL: gmail.apiBaseUrl,
        // The fixture CRM listens on loopback.
        LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS: "true",
      },
      teardowns: [() => gmail.close(), () => crm.stop()],
    }
  },
})

const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"
const ks = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}kernel"`
const ts = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}app_tickets"`

/** The admin's connection: the fixture CRM's adapter, under the tour's slug. */
const CONNECTION = "tour-crm"
const adapter = () => ({ ...loadFixtureCrmAdapter({ baseUrl: crm.baseUrl }), id: CONNECTION })

interface Ctx {
  env: ProfiledWorkerEnv
  orgId: string
  adminId: string
  amina: string
  base: string
  token: () => Promise<string>
  page: Page
  /**
   * When this run began. The world is the worker's, so an earlier test in the
   * same worker (the same tour at another width) left its own approvals in
   * the org: a run counts only what it asked for.
   */
  since?: Date
}

/** What one tour needs: where it starts, and what the person does on a beat. */
interface TourPlan {
  start: (ctx: Ctx) => Promise<string>
  /** Called once when the tour waits on `beatId` (autoplay done, event not yet). */
  person?: Record<string, (ctx: Ctx) => Promise<void>>
  /** Beats the person skips (documented in the tour copy). */
  skip?: Record<string, (ctx: Ctx) => Promise<void>>
  /** After the tour completed: what the agent and the person actually did. */
  verify?: (ctx: Ctx) => Promise<void>
}

/** Load a deferred tool, then call it: one scripted step each. */
function callTool(name: string, args: unknown): ScriptedTurnStep[] {
  return [
    { toolCalls: [{ name: "kernel__tool_search", args: { query: `select:${name}` } }] },
    { toolCalls: [{ name, args }] },
  ]
}

/**
 * Start `tourId` as its deep link would and script the person's conversation
 * with their agent, which the run recorded (`talksToAgent`): its next turns
 * replay `steps`.
 * The deep link then resumes this run.
 */
async function scriptRun(ctx: Ctx, tourId: string, steps: ScriptedTurnStep[]): Promise<string> {
  const res = await api(ctx.env.serverUrl, `/api/tours/${tourId}/start`, {
    token: await ctx.token(),
    body: { source: "cli" },
  })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const states = res.body.data.progress.beatStates as Record<string, TourBeatState>
  const recorded = states[RUN_CONVERSATION]
  const threadId = recorded && typeof recorded !== "string" ? recorded.entityId : ""
  expect(threadId, `${tourId} recorded no agent conversation`).toBeTruthy()
  await scriptAgentTurn(ctx.env, { threadId, steps })
  return threadId
}

/** The approval requests the admin asked for on `toolName`, newest first. */
async function approvalsFor(ctx: Ctx, toolName: string) {
  return ctx.env.db.sql.unsafe<{ id: string; status: string; agent_id: string | null }[]>(
    `SELECT id, status, agent_id FROM ${ks(ctx.env)}.approval_requests
     WHERE org_id = $1 AND requested_by = $2 AND tool_name = $3
       AND created_at >= $4::timestamptz - interval '1 second'
     ORDER BY created_at DESC`,
    [ctx.orgId, ctx.adminId, toolName, (ctx.since ?? new Date(0)).toISOString()],
  )
}

/** The agent drafted one reply on `toolName` and the person approved it. */
async function expectApprovedDraft(ctx: Ctx, toolName: string) {
  await expect
    .poll(async () => (await approvalsFor(ctx, toolName)).map((r) => r.status), {
      timeout: 20_000,
    })
    .toEqual([expect.stringMatching(/^(approved|executed)$/)])
  const [row] = await approvalsFor(ctx, toolName)
  expect(row?.agent_id, "the draft was the agent's").not.toBeNull()
}

const sentCount = () => gmail.requests().filter((r) => r.route === "messages.send").length

const DRAFT_DONE = "I drafted a reply: it is waiting for your approval."
const NOTE_DONE = "I added the note to the ticket."
const PLAN_DONE = "I created the launch project and its tasks."
const ORDERS_DONE = "Their latest orders are listed above."

async function gmailInboxTicket(ctx: Ctx): Promise<string> {
  const { env, orgId, adminId } = ctx
  const account = `tours-play-${Date.now()}@e2e.test`
  // The org's Gmail connection for the inbox (sealed placeholder tokens).
  const { id: connectedAccountId } = await seedFactory<{ id: string }>(
    env,
    orgId,
    "connections.mock",
    {
      appName: "tickets",
      connectionName: "gmail",
      ownerType: "org",
      userId: adminId,
      identifier: account,
      displayName: account,
      kind: { type: "oauth2" },
    },
  )
  const inboxId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.inboxes (id, org_id, connected_account_id, name, email_address,
       default_sensitivity, is_default_for_create, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'internal', false, now(), now())`,
    [inboxId, orgId, connectedAccountId, "Tours play", account],
  )
  gmail.queueSendResponse(account, { id: `gm-${Date.now()}`, threadId: `gt-${Date.now()}` })
  const ticket = await seedTicket(env, orgId, {
    subject: `Tour play ticket ${Date.now()}`,
    sourceInboxId: inboxId,
  })
  return ticket.id
}

async function mailConversation(ctx: Ctx): Promise<string> {
  const { env, orgId, adminId } = ctx
  const email = `tours-mail-${Date.now()}@e2e.test`
  // Its connection carries the seed's sealed placeholder token, which the
  // mock Gmail send accepts.
  const mailbox = await seedMailAccount(env, orgId, { userId: adminId, email })
  gmail.queueSendResponse(email, { id: `gm-${Date.now()}`, threadId: `gt-${Date.now()}` })
  const { conversationId } = await seedMailConversation(env, orgId, {
    accountId: mailbox.accountId,
    subject: `Tour mail ${Date.now()}`,
    // Newest in the inbox: the reply beat opens the top conversation, and the
    // seeded mailboxes without credentials cannot send.
    lastMessageAt: new Date(Date.now() + 3_600_000).toISOString(),
    messages: [
      {
        direction: "inbound",
        from: { name: "Jane Doe", email: "jane@customer.example" },
        to: [{ email }],
        textBody: "Hello, could you tell me when my order ships?",
        sentAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  })
  return conversationId
}

/**
 * The Projects tour: the agent creates the project with its tasks in one call
 * (createProject takes them), and the comment step then opens one of those
 * tasks in that project (walk D68: at 1280 the task's tab stayed blank, at 390
 * the project never opened).
 */
const PROJECTS_PLAN: TourPlan = {
  start: async (ctx) => {
    project.name = `Product launch ${Date.now()}`
    await scriptRun(ctx, "projects.basics", [
      ...callTool("projects__createProject", {
        name: project.name,
        tasks: [{ title: "Write the announcement" }, { title: "Brief the support team" }],
      }),
      { text: PLAN_DONE },
    ])
    return "/projects"
  },
  verify: async (ctx) => {
    const tasks = await ctx.env.db.sql.unsafe<{ id: string }[]>(
      `SELECT t.id FROM "${ctx.env.schemaPrefix}app_projects".tasks t
       JOIN "${ctx.env.schemaPrefix}app_projects".projects p ON p.id = t.project_id
       WHERE p.org_id = $1 AND p.name = $2`,
      [ctx.orgId, project.name],
    )
    expect(tasks).toHaveLength(2)
    // The comment went on one of the tasks the agent created.
    const comments = await ctx.env.db.sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${ks(ctx.env)}.messages m
       JOIN "${ctx.env.schemaPrefix}app_projects".tasks t ON t.thread_id = m.thread_id
       JOIN "${ctx.env.schemaPrefix}app_projects".projects p ON p.id = t.project_id
       WHERE p.org_id = $1 AND p.name = $2 AND m.author_type = 'user'`,
      [ctx.orgId, project.name],
    )
    expect(comments[0]?.n).toBeGreaterThan(0)
  },
}

const PLANS: Record<string, TourPlan> = {
  "kernel.threads": {
    start: async (ctx) => {
      const thread = await api(ctx.env.serverUrl, "/api/threads", {
        token: await ctx.token(),
        body: {
          forceCreate: true,
          title: `Tour play ${Date.now()}`,
          participantIds: [ctx.adminId, ctx.amina],
          initialMessage: { content: "context" },
        },
      })
      expect(thread.status).toBe(200)
      return `/threads/${thread.body.data.id}`
    },
    // The conversation is the person's: the tour writes, the person sends.
    person: {
      post: async ({ page }) => {
        await page.getByTestId("compose-send").filter({ visible: true }).click()
      },
      "mention-agent": async ({ page }) => {
        await page.getByTestId("compose-send").filter({ visible: true }).click()
      },
    },
  },
  "kernel.agents": { start: async () => "/agents/self" },
  "mail.basics": {
    start: async (ctx) => {
      const conversationId = await mailConversation(ctx)
      await scriptRun(ctx, "mail.basics", [
        ...callTool("mail__reply", {
          conversationId,
          textBody: "Hello Jane, your order ships tomorrow. We will send the tracking number.",
        }),
        { text: DRAFT_DONE },
      ])
      sent.mail = sentCount()
      return `/mail/${conversationId}`
    },
    verify: async (ctx) => {
      await expectApprovedDraft(ctx, "mail:reply")
      // Approving sent it, once.
      await expect.poll(sentCount, { timeout: 20_000 }).toBe(sent.mail + 1)
    },
  },
  "tickets.basics": {
    start: async (ctx) => {
      const ticketId = await gmailInboxTicket(ctx)
      ticket.id = ticketId
      await scriptRun(ctx, "tickets.basics", [
        ...callTool("tickets__reply", {
          ticketId,
          textBody: "Hello, thanks for writing. Your order left our warehouse this morning.",
        }),
        { text: DRAFT_DONE },
        ...callTool("tickets__addNote", {
          ticketId,
          text: "Summary: the customer asks where their order is; it shipped this morning.",
        }),
        { text: NOTE_DONE },
      ])
      return `/tickets/${ticketId}`
    },
    verify: async (ctx) => {
      await expectApprovedDraft(ctx, "tickets:reply")
      const messages = () =>
        ctx.env.db.sql.unsafe<{ kind: string; text_body: string | null }[]>(
          `SELECT kind, text_body FROM ${ts(ctx.env)}.messages WHERE ticket_id = $1`,
          [ticket.id],
        )
      // The approved draft went out, and the agent's note is on the ticket.
      await expect
        .poll(async () => (await messages()).map((r) => r.kind), { timeout: 20_000 })
        .toEqual(expect.arrayContaining(["outbound", "note"]))
      const rows = await messages()
      expect(rows.some((r) => r.kind === "note" && r.text_body?.startsWith("Summary:"))).toBe(true)
    },
  },
  "knowledge.basics": {
    start: async () => "/knowledge",
    person: {
      // The agent writes the document from what the person gives it; here the
      // person writes one themselves.
      create: async (ctx) => {
        const res = await api(ctx.env.serverUrl, "/api/knowledge/documents", {
          token: await ctx.token(),
          body: {
            title: `Tour notes ${Date.now()}`,
            body: "Opening hours.",
            documentScope: "personal",
          },
        })
        expect([200, 201]).toContain(res.status)
      },
    },
  },
  "projects.basics": PROJECTS_PLAN,
  "kernel.routines": { start: async () => "/agents/self/routines" },
  "kernel.sessions": {
    start: async () => "/sessions",
    skip: {
      start: async ({ page }) => {
        const panel = page.getByTestId("tour-panel")
        await expect(page.getByTestId("tour-beat-body")).toContainText("skip this step")
        // One press, even with the dialog the beat opened still on screen.
        await pressTourMenu(page, "tour-skip")
        await expect(panel).not.toHaveAttribute("data-beat-id", "start", { timeout: 5_000 })
      },
    },
  },
  "api-connector.settings": {
    start: async (ctx) => {
      dm.api = await scriptRun(ctx, "api-connector.settings", [
        ...callTool("api-connector__connector_read", {
          connection: CONNECTION,
          operation: "list_orders",
          params: { customerId: "cmp_001" },
        }),
        { text: ORDERS_DONE },
      ])
      return "/settings/api-connector"
    },
    person: {
      // The admin pastes their adapter and enters its key.
      add: async (ctx) => {
        const token = await ctx.token()
        const put = await fetch(`${ctx.env.serverUrl}/api/api-connector/adapters/${CONNECTION}`, {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(adapter()),
        })
        expect(put.status, await put.text()).toBe(200)
        const creds = await api(
          ctx.env.serverUrl,
          "/api/connections/api-connector/api/credentials",
          {
            token,
            body: { mode: "org", credentials: { identifier: CONNECTION, apiKey: CRM_KEY } },
          },
        )
        expect(creds.status, JSON.stringify(creds.body)).toBe(201)
      },
    },
    verify: async (ctx) => {
      // The agent's answer came from the connected system: a real read of the fixture CRM.
      const calls = await turnToolCalls(ctx.env, {
        threadId: dm.api,
        token: await ctx.token(),
        contains: ORDERS_DONE,
        expect: "api-connector__connector_read",
      })
      const read = calls.find((c) => c.toolName === "api-connector__connector_read")
      expect(JSON.stringify(read?.result)).toContain("SO-1001")
      expect(
        crm.handler.requests.some((r) => r.startsWith("GET /v1/companies/cmp_001/orders")),
      ).toBe(true)
    },
  },
}

/**
 * Walk D31: at 390 the Tickets tour's ask stopped on the ticket list (the
 * phone list renders cards, not rows) and the Mail tour's approve stopped in
 * the Chats view (the draft is on the conversation the person left). Each
 * plays whole at phone width from its list, the way a visitor reaches it.
 */
const PHONE_PLANS: Record<string, TourPlan> = {
  "projects.basics": PROJECTS_PLAN,
  "tickets.basics": {
    start: async (ctx) => {
      const ticketId = await gmailInboxTicket(ctx)
      await scriptRun(ctx, "tickets.basics", [
        ...callTool("tickets__reply", {
          ticketId,
          textBody: "Hello, thanks for writing. Your order left our warehouse this morning.",
        }),
        { text: DRAFT_DONE },
      ])
      return "/tickets"
    },
    verify: async (ctx) => {
      await expectApprovedDraft(ctx, "tickets:reply")
      // The phone note is the person's own, written in the ticket's composer sheet.
      const notes = await ctx.env.db.sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${ts(ctx.env)}.messages
         WHERE org_id = $1 AND kind = 'note' AND text_body LIKE 'Summary for the team%'`,
        [ctx.orgId],
      )
      expect(notes[0]?.n).toBeGreaterThan(0)
    },
  },
  "mail.basics": {
    start: async (ctx) => {
      const conversationId = await mailConversation(ctx)
      await scriptRun(ctx, "mail.basics", [
        ...callTool("mail__reply", {
          conversationId,
          textBody: "Hello Jane, your order ships tomorrow. We will send the tracking number.",
        }),
        { text: DRAFT_DONE },
      ])
      sent.mail = sentCount()
      return "/mail"
    },
    verify: async (ctx) => {
      await expectApprovedDraft(ctx, "mail:reply")
      await expect.poll(sentCount, { timeout: 20_000 }).toBe(sent.mail + 1)
    },
  },
}

/** What a plan's start hands its verify (one test at a time per worker). */
const ticket = { id: "" }
const project = { name: "" }
const dm = { api: "" }
const sent = { mail: 0 }

test("every shipped tour has a play plan", () => {
  expect(TOURS.map((t) => t.id).sort()).toEqual(Object.keys(PLANS).sort())
})

async function playTour(ctx: Ctx, tour: Tour, plan: TourPlan) {
  const { page, base, env, orgId, adminId } = ctx
  ctx.since = new Date()
  const startPath = await plan.start(ctx)
  // A failing request is named in the log (the server exposes its detail in e2e).
  page.on("response", async (res) => {
    const tourMove = res.url().includes("/api/tours/") && res.request().method() === "PATCH"
    // A decision the person's Approve sent that did not land is named too.
    const decide = res.url().includes("/api/approvals/") && res.request().method() === "POST"
    if (
      res.status() < 500 &&
      res.status() !== 401 &&
      !(tourMove && res.status() !== 200) &&
      !(decide && res.status() >= 300)
    )
      return
    const body = await res.text().catch(() => "")
    process.stdout.write(
      `[tour-5xx] ${tour.id} ${res.request().method()} ${res.url()} ${body.slice(0, 600)}\n`,
    )
  })
  const t0 = Date.now()
  await page.goto(`${base}${startPath}${startPath.includes("?") ? "&" : "?"}tour=${tour.id}`)
  const panel = page.getByTestId("tour-panel")
  await expect(panel).toHaveAttribute("data-tour-id", tour.id, { timeout: 30_000 })
  await pressTourMenu(page, "tour-play-all")

  const seen: string[] = []
  const handled = new Set<string>()
  const agentFailures = new Set<string>()
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (await page.getByTestId("tour-completed").isVisible()) break
    // A guard that refused (Do it for me stopped before acting) fails at once.
    const refused = page.getByTestId("tour-autoplay-refused")
    if (await refused.isVisible()) {
      throw new Error(
        `${tour.id}: autoplay refused on beat ${await panel.getAttribute("data-beat-id")} at ${await refused.getAttribute("data-missing")} (beats so far ${seen.join(" > ")})`,
      )
    }
    const failed = page.getByTestId("tour-autoplay-failed")
    if (await failed.isVisible()) {
      throw new Error(
        `${tour.id}: autoplay failed on beat ${await panel.getAttribute("data-beat-id")}, missing ${await failed.getAttribute("data-missing")} (beats so far ${seen.join(" > ")})`,
      )
    }
    const beatId = await panel.getAttribute("data-beat-id").catch(() => null)
    if (beatId && seen.at(-1) !== beatId) seen.push(beatId)
    const skip = beatId ? plan.skip?.[beatId] : undefined
    if (beatId && skip && !handled.has(`skip:${beatId}`)) {
      handled.add(`skip:${beatId}`)
      await skip(ctx)
    }
    const person = beatId ? plan.person?.[beatId] : undefined
    // The person acts once the beat waits on them, or once the agent turn it
    // waited on failed and the panel said so (no model in this org).
    const agentFailed = await page.getByTestId("tour-agent-failed").isVisible()
    if (agentFailed && beatId) agentFailures.add(beatId)
    // A tour whose agent turns are scripted must never see one fail.
    if (agentFailed && plan.verify) {
      throw new Error(
        `${tour.id}: the agent turn failed on beat ${beatId} (beats so far ${seen.join(" > ")})`,
      )
    }
    if (
      beatId &&
      person &&
      !handled.has(beatId) &&
      (agentFailed || (await page.getByTestId("tour-waiting").isVisible()))
    ) {
      handled.add(beatId)
      await person(ctx)
    }
    // The person's own clicks hand over; the scenario plays on when asked again.
    // (Play whole scenario is in the card's menu; the card says whether it plays.)
    if ((await panel.isVisible()) && (await panel.getAttribute("data-play-all")) === null) {
      await pressTourMenu(page, "tour-play-all")
    }
    await page.waitForTimeout(400)
  }
  await expect(
    page.getByTestId("tour-completed"),
    `${tour.id} did not complete (beats ${seen.join(" > ")}, at ${page.url()})`,
  ).toBeVisible({ timeout: 5_000 })
  const [row] = await env.db.sql.unsafe<
    { status: string; beat_states: Record<string, TourBeatState> }[]
  >(
    `SELECT status, beat_states FROM ${ks(env)}.tour_progress
     WHERE org_id = $1 AND user_id = $2 AND tour_id = $3`,
    [orgId, adminId, tour.id],
  )
  expect(row?.status).toBe("completed")
  const states = Object.values(row?.beat_states ?? {}).map(beatOutcome)
  const result = {
    tour: tour.id,
    completed: states.filter((s) => s === "done").length,
    skipped: states.filter((s) => s === "skipped").length,
    seconds: Math.round((Date.now() - t0) / 1000),
    beats: seen.join(" > "),
    agentFailed: [...agentFailures],
  }
  process.stdout.write(`[tour-result] ${JSON.stringify(result)}\n`)
  test.info().annotations.push({ type: "tour-result", description: JSON.stringify(result) })
  return result
}

/** Re-run only some tours: TOUR_PLAY_ONLY=mail.basics,tickets.basics */
const ONLY = process.env.TOUR_PLAY_ONLY?.split(",").filter(Boolean)

async function phoneCtx(
  page: Page,
  env: ProfiledWorkerEnv,
  orgId: string,
  qa: { admin: { id: string }; amina: { id: string } },
): Promise<Ctx> {
  return {
    env,
    orgId,
    adminId: qa.admin.id,
    amina: qa.amina.id,
    base: `http://localhost:${env.ports[1]}`,
    page,
    token: async () =>
      (
        await api(env.serverUrl, "/api/auth/login", {
          method: "POST",
          body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        })
      ).body.data.accessToken as string,
  }
}

for (const [tourId, plan] of Object.entries(PHONE_PLANS)) {
  // Walk D31: the approvals screen refetched its list as the draft landed and
  // rebuilt the card while the ghost cursor glided to Approve, so the press
  // reached the detached button and sent nothing; it now presses the one on
  // screen. The tickets note then goes back to the tickets to open one.
  test(`plays ${tourId} with Play whole scenario at 390 (walk D31)`, async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.skip(ONLY !== undefined && !ONLY.includes(tourId), "not in TOUR_PLAY_ONLY")
    test.setTimeout(300_000)
    const tour = TOURS.find((t) => t.id === tourId)
    if (!tour) throw new Error(`no tour ${tourId}`)
    await page.setViewportSize({ width: 390, height: 844 })
    const orgId = world.org.id
    await grantTicketsScopes(env, orgId, qa.admin.id, [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:inboxes:read",
      "tickets:approve",
    ])
    await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = await phoneCtx(page, env, orgId, qa)
    await seedModelPricingAndCredits(env, orgId)
    await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
    const result = await playTour(ctx, tour, plan)
    await plan.verify?.(ctx)
    expect(result.agentFailed).toEqual([])
  })
}

for (const tour of TOURS) {
  test(`plays ${tour.id} with Play whole scenario`, async ({ page, env, world, qa }) => {
    test.skip(ONLY !== undefined && !ONLY.includes(tour.id), "not in TOUR_PLAY_ONLY")
    test.setTimeout(300_000)
    const orgId = world.org.id
    await grantTicketsScopes(env, orgId, qa.admin.id, [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:inboxes:read",
      "tickets:approve",
    ])
    await grantProjectScopes(env, orgId, qa.admin.id)
    await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx: Ctx = {
      env,
      orgId,
      adminId: qa.admin.id,
      amina: qa.amina.id,
      base: `http://localhost:${env.ports[1]}`,
      page,
      token: async () =>
        (
          await api(env.serverUrl, "/api/auth/login", {
            method: "POST",
            body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
          })
        ).body.data.accessToken as string,
    }
    const plan = PLANS[tour.id]
    if (!plan) throw new Error(`no play plan for ${tour.id}`)
    // The agent-first tours run their turns on the scripted model: the org needs a model to pick.
    if (plan.verify) await seedModelPricingAndCredits(env, orgId)
    // Only the plan that scripts the agent DM decides what its turns say.
    await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
    const result = await playTour(ctx, tour, plan)
    if (tour.id === "kernel.sessions") expect(result.skipped).toBe(1)
    await plan.verify?.(ctx)
    // An agentic beat that completed did so on the scripted turn, not a failure.
    if (plan.verify) expect(result.agentFailed).toEqual([])
  })
}

/**
 * Walk D69: a page reload on the approve step (Mail at 1280) left the step on
 * Home, and Do it for me approved nothing: the step said the agent had not done
 * it yet. The approve step opens the run's conversation, where the draft's own
 * card sits under the agent's answer, and approves that card.
 */
const APPROVE_AFTER_RELOAD: Record<string, { approveBeat: string; tool: string }> = {
  "mail.basics": { approveBeat: "approve", tool: "mail:reply" },
  "tickets.basics": { approveBeat: "review", tool: "tickets:reply" },
}

for (const [tourId, { approveBeat, tool }] of Object.entries(APPROVE_AFTER_RELOAD)) {
  test(`${tourId}: Do it for me approves the draft after a reload on its approve step (walk D69)`, async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.skip(ONLY !== undefined && !ONLY.includes(tourId), "not in TOUR_PLAY_ONLY")
    test.setTimeout(240_000)
    const tour = TOURS.find((t) => t.id === tourId)
    const plan = PLANS[tourId]
    if (!tour || !plan) throw new Error(`no tour ${tourId}`)
    await page.setViewportSize({ width: 1280, height: 800 })
    const orgId = world.org.id
    await grantTicketsScopes(env, orgId, qa.admin.id, [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:inboxes:read",
      "tickets:approve",
    ])
    await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = await phoneCtx(page, env, orgId, qa)
    await seedModelPricingAndCredits(env, orgId)
    await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
    ctx.since = new Date()
    const startPath = await plan.start(ctx)
    await page.goto(`${ctx.base}${startPath}?tour=${tour.id}`)
    const panel = page.getByTestId("tour-panel")
    await expect(panel).toHaveAttribute("data-tour-id", tour.id, { timeout: 30_000 })

    // Manual, as a visitor: Next on show steps, Do it for me once on each do step.
    const pressed = new Set<string>()
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const beatId = await panel.getAttribute("data-beat-id").catch(() => null)
      if (beatId === approveBeat) break
      const next = page.getByTestId("tour-next")
      // Next is held while a show step waits for what it points at.
      if ((await next.isVisible()) && (await next.isEnabled())) {
        await next.click({ timeout: 2_000 }).catch(() => {})
      } else if (
        beatId &&
        !pressed.has(beatId) &&
        (await page.getByTestId("tour-do-for-me").isVisible())
      ) {
        pressed.add(beatId)
        await page.getByTestId("tour-do-for-me").click()
      }
      await page.waitForTimeout(400)
    }
    await expect(panel).toHaveAttribute("data-beat-id", approveBeat)
    // The agent's turn is over: its answer is stored.
    await expect.poll(async () => (await approvalsFor(ctx, tool)).length).toBe(1)
    await page.waitForTimeout(2_000)

    // The reload lands on Home with the step restored.
    await page.goto(ctx.base)
    await expect(panel).toHaveAttribute("data-beat-id", approveBeat, { timeout: 30_000 })
    await page.getByTestId("tour-do-for-me").click()
    await expectApprovedDraft(ctx, tool)
    await expect(panel).not.toHaveAttribute("data-beat-id", approveBeat, { timeout: 30_000 })
    await page.screenshot({ path: test.info().outputPath(`${tourId}-after-reload-approve.png`) })
  })
}
