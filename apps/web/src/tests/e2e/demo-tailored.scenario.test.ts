// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tailored demo's projects scenario, played with "Play whole scenario" in
// a real browser against the real server, its agent turn on the e2e lane's
// scripted model (`LIAISON_MODEL_PROVIDER=scripted`: only the tool calls are
// scripted, they run for real through the tool bridge).
//
// What it proves is that every beat completes on THIS run's own work:
//  - "Your task" goes to the visitor's task (the world beat recorded it) and
//    waits for it on screen, instead of moving on from the projects home;
//  - the agent is asked in the person's DM with it, opened in the dock beside
//    the task (full screen on a phone), and the subtasks beat completes on the task that turn created, never on a task
//    created at the same moment elsewhere (here: one the person creates by
//    hand while the beat waits, which used to complete it);
//  - the reply beat completes on that turn's comment in the task's discussion;
//  - the board beat opens the task's project to show its views.
//
// The run stands on the beat after the world beat: the teammate's comment is
// the injector's (covered by its own tests); the beat state records the task
// it brought in, exactly as the registry writes it.
import { beatOutcome, RUN_CONVERSATION, type TourBeatState } from "@liaison/shared"
import { api } from "@liaison/test-helpers"
import { agentDmThreadId, type ScriptedTurnStep, scriptAgentTurn } from "./agent-turn"
import { createProfiledE2ETest, type ProfiledWorkerEnv } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { grantProjectScopes } from "./helpers/projects-seed"
import { grantTicketsScopes, seedTicket } from "./helpers/seed"
import { pressTourMenu } from "./helpers/tour-menu"

const test = createProfiledE2ETest({
  workerIdOffset: 220,
  portCount: 2,
  before: async () => ({ env: {}, teardowns: [] }),
})

const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"
const TOUR_ID = "kernel.scenario-projects"
const SUBTASK = "Charge the four demo units"
const DECOY = "Order booth lanyards"
const ks = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}kernel"`
const ps = (env: ProfiledWorkerEnv) => `"${env.schemaPrefix}app_projects"`

/** Load a deferred tool, then call it: one scripted step each. */
function callTool(name: string, args: unknown): ScriptedTurnStep[] {
  return [
    { toolCalls: [{ name: "kernel__tool_search", args: { query: `select:${name}` } }] },
    { toolCalls: [{ name, args }] },
  ]
}

async function token(env: ProfiledWorkerEnv): Promise<string> {
  const res = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  return res.body.data.accessToken as string
}

/**
 * Each test writes its run straight into the row, past the product's one active
 * run at a time, and a worker's tests share an org: a run left active by an
 * earlier test would take the panel over.
 */
async function clearTourRuns(env: ProfiledWorkerEnv, orgId: string, userId: string): Promise<void> {
  await env.db.sql.unsafe(
    `DELETE FROM ${ks(env)}.tour_progress WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  )
}

type Fixtures = Parameters<Parameters<typeof test>[2]>[0]

test("projects, played whole: each beat completes on its own run's task", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(240_000)
  await playProjects({ page, env, world, qa }, { phone: false })
})

// At phone width the sheet, the paused chip and every beat of a whole
// scenario fit the screen: paused, the chip sits inside the 390px viewport and
// resumes the same beat; played whole, the scenario completes.
test("projects at 390px: the chip resumes, and the scenario plays whole", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(240_000)
  await playProjects({ page, env, world, qa }, { phone: true })
})

async function playProjects(
  { page, env, world, qa }: Pick<Fixtures, "page" | "env" | "world" | "qa">,
  opts: { phone: boolean },
): Promise<void> {
  if (opts.phone) await page.setViewportSize({ width: 390, height: 844 })
  // Both runs may share a worker's org: each names its own subtask.
  const subtaskTitle = `${SUBTASK} (${opts.phone ? "phone" : "desktop"} ${Date.now()})`
  const orgId = world.org.id
  const adminId = qa.admin.id

  // A visitor demo org: the scenarios are offered only there.
  const now = new Date()
  const marker = {
    variant: "visitor",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    needs: ["projects"],
  }
  await env.db.sql.unsafe(
    `UPDATE ${ks(env)}.organizations
     SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('demo', $2::text::jsonb)
     WHERE id = $1`,
    [orgId, JSON.stringify(marker)],
  )
  await grantProjectScopes(env, orgId, adminId)
  await seedModelPricingAndCredits(env, orgId)
  await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
  await clearTourRuns(env, orgId, adminId)

  // The visitor's project and task (the seed's "Prepare the trade-show demo").
  const t = await token(env)
  const project = await api(env.serverUrl, "/api/projects", {
    token: t,
    body: { name: `Trade show ${Date.now()}` },
  })
  expect(project.status, JSON.stringify(project.body)).toBe(200)
  const projectId = project.body.data.id as string
  const created = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, {
    token: t,
    body: { title: "Prepare the trade-show demo", assigneeId: adminId },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const task = created.body.data as { id: string; threadId: string }

  // The run starts as its runner does: it records the person's DM with their agent.
  const started = await api(env.serverUrl, `/api/tours/${TOUR_ID}/start`, {
    token: t,
    body: { source: "demo" },
  })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const startStates = started.body.data.progress.beatStates as Record<string, TourBeatState>
  const recorded = startStates[RUN_CONVERSATION]
  const conversation = recorded && typeof recorded !== "string" ? recorded.entityId : ""
  expect(conversation).toBeTruthy()

  // The agent asked there breaks the task down, then answers Tobias in the task's discussion.
  await scriptAgentTurn(env, {
    threadId: conversation,
    steps: [
      ...callTool("projects__create", { projectId, title: subtaskTitle, parentTaskId: task.id }),
      ...callTool("projects__comment", {
        taskId: task.id,
        body: "The subtasks are on the task; the demo units come first.",
      }),
      { text: "I created the subtask and answered Tobias in the task." },
    ],
  })
  // A scenario talks to the person's one DM with their agent, so that script is the only one.
  expect(await agentDmThreadId(env, t)).toBe(conversation)

  // The run stands just past the teammate's comment, with the task it recorded.
  const states: Record<string, TourBeatState> = {
    ...startStates,
    home: "done",
    teammate: { state: "done", entityId: task.id },
  }
  await env.db.sql.unsafe(
    `UPDATE ${ks(env)}.tour_progress
       SET status = 'active', beat_id = 'my-task', beat_index = 2, beat_states = $4::text::jsonb
     WHERE org_id = $1 AND user_id = $2 AND tour_id = $3`,
    [orgId, adminId, TOUR_ID, JSON.stringify(states)],
  )
  // The server reads the demo marker through a short cache: wait until it offers the scenario.
  await expect
    .poll(
      async () => {
        const res = await api(env.serverUrl, "/api/tours", { token: t })
        const tours = (res.body?.data?.tours ?? []) as { tourId: string }[]
        return tours.some((x) => x.tourId === TOUR_ID)
      },
      { timeout: 45_000 },
    )
    .toBe(true)

  await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
  const base = `http://localhost:${env.ports[1]}`
  await page.goto(`${base}/projects`)
  const panel = page.getByTestId("tour-panel")
  await expect(panel).toHaveAttribute("data-tour-id", TOUR_ID, { timeout: 30_000 })
  await expect(panel).toHaveAttribute("data-beat-id", "my-task")
  if (opts.phone) {
    await expect(panel).toHaveAttribute("data-tier", "phone")
    // Paused: the chip, inside the viewport, resumes the same beat.
    await pressTourMenu(page, "tour-pause")
    const chip = page.getByTestId("tour-chip")
    await expect(chip).toBeVisible({ timeout: 10_000 })
    const box = await chip.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    await page.getByTestId("tour-chip-resume").click()
    await expect(panel).toHaveAttribute("data-beat-id", "my-task", { timeout: 10_000 })
  }
  await pressTourMenu(page, "tour-play-all")

  const seen: string[] = []
  let decoyId: string | null = null
  let openedConversation = false
  const runComposer = page.locator(
    `[data-testid="compose-field"][data-thread-id="${conversation}"]`,
  )
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await page.getByTestId("tour-completed").isVisible()) break
    for (const status of ["tour-autoplay-failed", "tour-autoplay-refused", "tour-agent-failed"]) {
      const line = page.getByTestId(status)
      if (await line.isVisible()) {
        throw new Error(
          `${status} on beat ${await panel.getAttribute("data-beat-id")} (missing ${await line.getAttribute("data-missing")}, beats ${seen.join(" > ")}, at ${page.url()})`,
        )
      }
    }
    // Short: once the run completes the panel is gone, and a read that waited
    // the default action timeout outlived the completion card (it hides
    // after a few seconds), so the loop never saw it.
    const beatId = await panel.getAttribute("data-beat-id", { timeout: 500 }).catch(() => null)
    if (beatId && seen.at(-1) !== beatId) seen.push(beatId)
    // The task is on screen at its own address, not the projects home.
    if (beatId === "my-task" || beatId === "reply") {
      expect(page.url()).toContain(`/projects/tasks/${task.id}`)
    }
    // The request goes to the agent in the person's DM with it, not the task:
    // in the dock with the task still behind it, full screen on a phone.
    if (beatId === "ask-agent" || beatId === "subtasks") {
      if (opts.phone) {
        openedConversation ||= page.url().includes(`/threads/${conversation}`)
      } else {
        expect(page.url()).toContain(`/projects/tasks/${task.id}`)
        openedConversation ||= await runComposer.isVisible()
      }
    }
    // While the beat waits for the agent, a task appears that this run did not ask for.
    if (beatId === "subtasks" && decoyId === null) {
      const decoy = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, {
        token: t,
        body: { title: DECOY },
      })
      expect(decoy.status).toBe(200)
      decoyId = decoy.body.data.id as string
    }
    await page.waitForTimeout(100)
  }
  await expect(page.getByTestId("tour-completed"), `beats ${seen.join(" > ")}`).toBeVisible({
    timeout: 5_000,
  })
  expect(seen).toEqual(["my-task", "ask-agent", "subtasks", "reply", "review", "board", "done"])
  expect(openedConversation, "the person's conversation with the agent opened").toBe(true)

  const [row] = await env.db.sql.unsafe<
    { status: string; beat_states: Record<string, TourBeatState> }[]
  >(
    `SELECT status, beat_states FROM ${ks(env)}.tour_progress
     WHERE org_id = $1 AND user_id = $2 AND tour_id = $3`,
    [orgId, adminId, TOUR_ID],
  )
  expect(row?.status).toBe("completed")
  const entity = (beat: string) => {
    const s = row?.beat_states[beat]
    return s && typeof s !== "string" ? s.entityId : null
  }
  // ask-agent: the visitor's message in the person's DM with the agent.
  const [ask] = await env.db.sql.unsafe<{ thread_id: string }[]>(
    `SELECT thread_id FROM ${ks(env)}.messages WHERE id = $1`,
    [entity("ask-agent")],
  )
  expect(ask?.thread_id).toBe(conversation)
  // reply: the agent's comment in the task's discussion, written by that turn.
  const [reply] = await env.db.sql.unsafe<{ thread_id: string; author_type: string }[]>(
    `SELECT thread_id, author_type FROM ${ks(env)}.messages WHERE id = $1`,
    [entity("reply")],
  )
  expect(reply?.thread_id).toBe(task.threadId)
  expect(reply?.author_type).toBe("agent")
  // subtasks: the task the agent's answer created, not the one made meanwhile.
  const [subtask] = await env.db.sql.unsafe<{ id: string; title: string }[]>(
    `SELECT id, title FROM ${ps(env)}.tasks WHERE org_id = $1 AND title = $2`,
    [orgId, subtaskTitle],
  )
  expect(subtask?.id).toBeTruthy()
  expect(entity("subtasks")).toBe(subtask?.id)
  expect(decoyId).not.toBeNull()
  expect(entity("subtasks")).not.toBe(decoyId)
  expect(Object.values(row?.beat_states ?? {}).map(beatOutcome)).not.toContain("skipped")
}

// A scenario that asks the agent talks to it in the person's one DM with it,
// as the product does: a second run asks there too, after the first run's
// turns, and no other conversation with the agent is opened.
test("chat, started twice: both runs ask the agent in the person's one DM with it", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(240_000)
  const CHAT = "kernel.scenario-chat"
  const orgId = world.org.id
  const adminId = qa.admin.id
  const now = new Date()
  const marker = {
    variant: "visitor",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    needs: ["chat"],
  }
  await env.db.sql.unsafe(
    `UPDATE ${ks(env)}.organizations
     SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('demo', $2::text::jsonb)
     WHERE id = $1`,
    [orgId, JSON.stringify(marker)],
  )
  await seedModelPricingAndCredits(env, orgId)
  await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
  await clearTourRuns(env, orgId, adminId)
  const t = await token(env)
  const dm = await agentDmThreadId(env, t)
  await expect
    .poll(
      async () => {
        const res = await api(env.serverUrl, "/api/tours", { token: t })
        const tours = (res.body?.data?.tours ?? []) as { tourId: string }[]
        return tours.some((x) => x.tourId === CHAT)
      },
      { timeout: 45_000 },
    )
    .toBe(true)

  /** Start the scenario (as its runner does) and stand the run on its ask beat. */
  const startRun = async (): Promise<string> => {
    const res = await api(env.serverUrl, `/api/tours/${CHAT}/start`, {
      token: t,
      body: { source: "demo" },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const states = res.body.data.progress.beatStates as Record<string, TourBeatState>
    const recorded = states[RUN_CONVERSATION]
    const conversation = recorded && typeof recorded !== "string" ? recorded.entityId : ""
    expect(conversation).toBeTruthy()
    await scriptAgentTurn(env, {
      threadId: conversation,
      steps: [{ text: "Here is what applies." }],
    })
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.tour_progress
       SET beat_id = 'ask-agent', beat_index = 2,
           beat_states = beat_states || '{"channels":"done","question":"done"}'::jsonb
       WHERE org_id = $1 AND user_id = $2 AND tour_id = $3`,
      [orgId, adminId, CHAT],
    )
    return conversation
  }
  const messagesIn = async (threadId: string) =>
    (
      await env.db.sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${ks(env)}.messages WHERE thread_id = $1 AND author_id = $2 AND author_type = 'user'`,
        [threadId, adminId],
      )
    )[0]?.n ?? 0
  const panel = page.getByTestId("tour-panel")
  /** "Do it for me" on the ask beat: it lands in the run's conversation, and the beat moves on.
   *  The person's one DM with their agent also holds what earlier specs of this
   *  worker asked there, so the count is taken from just before the ask. */
  const ask = async (conversation: string) => {
    await expect(panel).toHaveAttribute("data-beat-id", "ask-agent", { timeout: 30_000 })
    const sent = (await messagesIn(conversation)) + 1
    await page.getByTestId("tour-do-for-me").click()
    await expect(panel).toHaveAttribute("data-beat-id", "searching", { timeout: 60_000 })
    await expect(
      page.locator(`[data-testid="compose-field"][data-thread-id="${conversation}"]`),
    ).toBeVisible()
    expect(await messagesIn(conversation)).toBe(sent)
  }

  const agentChats = async () =>
    (
      await env.db.sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${ks(env)}.threads t
         JOIN ${ks(env)}.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = $2
         WHERE t.org_id = $1 AND t.type = 'agent_chat'`,
        [orgId, adminId],
      )
    )[0]?.n
  const chatsBefore = await agentChats()

  const first = await startRun()
  await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
  const base = `http://localhost:${env.ports[1]}`
  await page.goto(`${base}/chats`)
  await expect(panel).toHaveAttribute("data-tour-id", CHAT, { timeout: 30_000 })
  expect(first).toBe(dm)
  await ask(first)

  // Started again: the same DM, holding the first run's turn.
  const second = await startRun()
  expect(second).toBe(dm)
  await page.reload()
  await ask(second)
  // Neither run opened another conversation with an agent.
  expect(await agentChats()).toBe(chatsBefore)
})

// Support's last step asks the person's agent about the customer of the
// ticket this run brought in. The ticket has no message composer of its own:
// on a desktop the chat dock opens beside it (the agent reads the ticket
// behind the dock), on a phone the Chats tab of the bottom bar. Either way the
// step completes on the person's message to their agent (walk D23, D31).
for (const phone of [false, true]) {
  test(`support at ${phone ? 390 : 1280}px: Do it for me asks the agent about the ticket's customer`, async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    const TOUR = "kernel.scenario-support"
    const orgId = world.org.id
    const adminId = qa.admin.id
    const now = new Date()
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.organizations
       SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('demo', $2::text::jsonb)
       WHERE id = $1`,
      [
        orgId,
        JSON.stringify({
          variant: "visitor",
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          needs: ["support"],
        }),
      ],
    )
    await grantTicketsScopes(env, orgId, adminId)
    await seedModelPricingAndCredits(env, orgId)
    await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
    await clearTourRuns(env, orgId, adminId)
    const ticket = await seedTicket(env, orgId, {
      subject: `Kestrel 10 stopped charging ${phone ? "phone" : "desktop"} ${Date.now()}`,
    })
    const t = await token(env)
    const dm = await agentDmThreadId(env, t)
    await scriptAgentTurn(env, { threadId: dm, steps: [{ text: "She reported nothing else." }] })

    // The run stands on the ask, past the approved reply, with its ticket recorded.
    const states: Record<string, TourBeatState> = {
      inbox: "done",
      "live-ticket": { state: "done", entityId: ticket.id },
      open: "done",
      "routine-note": "done",
      "routine-draft": "done",
      approve: "done",
      sent: "done",
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.tour_progress
         (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
       VALUES ($1, $2, $3, 'active', 'ask-agent', 7, $4::text::jsonb, 'demo')
       ON CONFLICT (org_id, user_id, tour_id) DO UPDATE
         SET status = 'active', beat_id = 'ask-agent', beat_index = 7, beat_states = $4::text::jsonb`,
      [orgId, adminId, TOUR, JSON.stringify(states)],
    )
    await expect
      .poll(
        async () => {
          const res = await api(env.serverUrl, "/api/tours", { token: t })
          const tours = (res.body?.data?.tours ?? []) as { tourId: string }[]
          return tours.some((x) => x.tourId === TOUR)
        },
        { timeout: 45_000 },
      )
      .toBe(true)

    await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    const panel = page.getByTestId("tour-panel")
    await expect(panel).toHaveAttribute("data-tour-id", TOUR, { timeout: 30_000 })
    await expect(panel).toHaveAttribute("data-beat-id", "ask-agent")
    await page.getByTestId("tour-do-for-me").first().click()
    // The scenario does not end before the agent's answer is read.
    await expect(panel).toHaveAttribute("data-beat-id", "answer", { timeout: 60_000 })
    const [row] = await env.db.sql.unsafe<{ beat_states: Record<string, TourBeatState> }[]>(
      `SELECT beat_states FROM ${ks(env)}.tour_progress
       WHERE org_id = $1 AND user_id = $2 AND tour_id = $3`,
      [orgId, adminId, TOUR],
    )
    const ask = row?.beat_states["ask-agent"]
    const askId = ask && typeof ask !== "string" ? ask.entityId : null
    // This run's answer: the DM keeps the answers of the runs before it.
    await expect(
      page.locator(`[data-testid="agent-answer"][data-turn-id="${askId}"]`),
    ).toContainText("She reported nothing else.", { timeout: 60_000 })
    await page.getByTestId("tour-next").click()
    await expect(panel).toHaveAttribute("data-beat-id", "done", { timeout: 10_000 })
    for (const status of ["tour-autoplay-failed", "tour-autoplay-refused"]) {
      await expect(page.getByTestId(status)).toHaveCount(0)
    }
    // The step completed on the person's own message to their agent.
    const [msg] = await env.db.sql.unsafe<{ author_type: string; type: string }[]>(
      `SELECT m.author_type, t.type FROM ${ks(env)}.messages m
       JOIN ${ks(env)}.threads t ON t.id = m.thread_id WHERE m.id = $1`,
      [askId],
    )
    expect(msg).toEqual({ author_type: "user", type: "agent_chat" })
  })
}
