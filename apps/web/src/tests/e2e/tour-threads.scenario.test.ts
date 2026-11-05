// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T10 (S24, S26): the shipped Messages tour (`kernel.threads`) plays from
// start to finish with "Play whole scenario" in the real UI: show beats move
// on by themselves, the "post" beat types a message and the person sends it
// (the conversation is someone's existing one, so the tour never sends), the dictation
// beat waits for a button this org does not offer (no transcription model)
// without blocking Next, and the "@agent" beat picks an agent from the
// mention picker, and the person sends. The tour routes are stubbed (the progress API is
// another track's): the stub advances show beats on the client's Next and,
// like the server's completion consumer, moves a do beat on only once the
// message is in the database. Every product effect is the real server's.
import { effectiveBeats, findTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { api } from "@liaison/test-helpers"
import type { Page, Route } from "@playwright/test"
import { expect, test } from "./fixtures/test"
import { pressTourMenu } from "./helpers/tour-menu"

const TOUR_ID = "kernel.threads"
const tour = findTour(TOUR_ID)
if (!tour) throw new Error(`${TOUR_ID} is not a shipped tour`)
const BEATS = effectiveBeats(tour, { installedApps: [], isDemo: false }).map((b) => b.id)

function at(beatId: string | null, status: TourProgress["status"] = "active"): TourProgress {
  return {
    tourId: TOUR_ID,
    status,
    beatId,
    beatIndex: beatId === null ? BEATS.length : BEATS.indexOf(beatId),
    beatCount: BEATS.length,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
  }
}

interface StubState {
  progress: TourProgress
  patches: { advance?: boolean; fromBeatId?: string; status?: string }[]
}

/** Stub of the tour routes: Next advances a show beat, never a do beat. */
async function stubTours(page: Page, state: StubState) {
  await page.route("**/api/tours**", async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      })
    if (req.method() === "GET" && url.pathname === "/api/tours") {
      const item: TourListItem = {
        tourId: TOUR_ID,
        app: tour?.app ?? "kernel",
        title: tour?.title ?? "",
        summary: tour?.summary ?? "",
        beatCount: BEATS.length,
        progress: state.progress,
      }
      return json({ tours: [item] })
    }
    if (req.method() === "GET" && url.pathname.endsWith("/progress")) {
      return json({ progress: state.progress })
    }
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as StubState["patches"][number]
      state.patches.push(body)
      const current = state.progress.beatId
      const kind = tour?.beats.find((b) => b.id === current)?.kind
      if (body.advance && current && kind === "show" && body.fromBeatId === current) {
        const next = BEATS[BEATS.indexOf(current) + 1] ?? null
        state.progress = next ? at(next) : at(null, "completed")
      } else if (body.status) {
        state.progress = { ...state.progress, status: body.status as TourProgress["status"] }
      }
      return json({ progress: state.progress })
    }
    return route.fulfill({ status: 404, body: "{}" })
  })
}

test("the Messages tour plays end to end with Play whole scenario", async ({
  authenticatedPage: page,
  env,
  qa,
}) => {
  test.setTimeout(240_000)
  const ks = `${env.schemaPrefix}kernel`
  const base = `http://localhost:${env.ports[1]}`
  expect(BEATS).toEqual([
    "messages",
    "post",
    "dictation",
    "mention-agent",
    "agent-answers",
    "attach",
  ])

  const thread = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Tour threads ${Date.now()}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "context" },
    },
  })
  expect(thread.status).toBe(200)
  const threadId: string = thread.body.data.id
  /** The newest message of the thread containing `text` (an agent may answer after it). */
  const messageWith = async (text: string) => {
    const rows = await env.db.sql.unsafe<{ content: string }[]>(
      `SELECT content FROM "${ks}".messages WHERE thread_id = $1 AND position($2 in content) > 0
       ORDER BY created_at DESC LIMIT 1`,
      [threadId, text],
    )
    return rows[0]?.content ?? ""
  }

  const state: StubState = { progress: at("messages"), patches: [] }
  await stubTours(page, state)
  const panel = page.getByTestId("tour-panel")

  // 1. Show beat, then the "post" do beat: typed by the ghost, sent by the person.
  await page.goto(`${base}/threads/${threadId}`)
  await expect(panel).toHaveAttribute("data-beat-id", "messages", { timeout: 30_000 })
  await expect(page.getByTestId("tour-spotlight")).toHaveAttribute(
    "data-anchor",
    "activity-messages",
  )
  await pressTourMenu(page, "tour-play-all")
  await expect(panel).toHaveAttribute("data-beat-id", "post", { timeout: 15_000 })
  await expect(page.getByTestId("tour-ghost-cursor")).toBeVisible()
  await expect(page.getByTestId("tour-waiting")).toBeVisible({ timeout: 30_000 })
  // Written, never sent by the tour.
  expect(await messageWith("trying out Liaison")).toBe("")
  await page.getByTestId("compose-send").filter({ visible: true }).click()
  await expect
    .poll(() => messageWith("trying out Liaison"), { timeout: 30_000 })
    .toBe("Hello everyone, I'm trying out Liaison.")
  // A do beat is the server's to complete: the client never advanced it.
  expect(state.patches.some((p) => p.advance && p.fromBeatId === "post")).toBe(false)

  // The product event landed: the server moves the beat on (here, the stub).
  state.progress = at("dictation")
  await page.reload()
  await expect(panel).toHaveAttribute("data-beat-id", "dictation", { timeout: 30_000 })
  // No transcription model in this org: the button is absent and the beat says
  // it is waiting for it, without blocking the tour.
  await expect(page.getByTestId("tour-anchor-waiting")).toBeVisible()
  await pressTourMenu(page, "tour-play-all")

  // 2. The "@agent" beat: picks an agent from the picker; the person sends.
  await expect(panel).toHaveAttribute("data-beat-id", "mention-agent", { timeout: 15_000 })
  await expect(page.getByTestId("tour-waiting")).toBeVisible({ timeout: 30_000 })
  expect(await messageWith("can you sum up this conversation?")).toBe("")
  await page.getByTestId("compose-send").filter({ visible: true }).click()
  await expect
    .poll(() => messageWith("can you sum up this conversation?"), { timeout: 30_000 })
    .toMatch(/agent:.*can you sum up this conversation\?/)
  await expect(page.getByTestId("tour-autoplay-failed")).toHaveCount(0)
  expect(state.patches.some((p) => p.advance && p.fromBeatId === "mention-agent")).toBe(false)

  // 3. The last two show beats play out and the tour completes.
  state.progress = at("agent-answers")
  await page.reload()
  await expect(panel).toHaveAttribute("data-beat-id", "agent-answers", { timeout: 30_000 })
  await pressTourMenu(page, "tour-play-all")
  await expect(panel).toHaveAttribute("data-beat-id", "attach", { timeout: 15_000 })
  await expect(page.getByTestId("tour-spotlight")).toHaveAttribute("data-anchor", "composer-plus")
  await expect(page.getByTestId("tour-completed")).toBeVisible({ timeout: 15_000 })
  await expect(panel).toHaveCount(0)
  expect(state.progress.status).toBe("completed")
})
