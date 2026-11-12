// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A page result (page-result.ts) against the `pagefx` fixture, on the real
// routes: a page minted from a conversation carries that conversation; a route
// answering `pageResult` posts the summary line there as the person and
// enqueues one turn of the agent that showed the page. The browser never sees
// `pageResult`, a page opened without an origin posts nowhere, and the origin
// cannot come from the app's params or the browser.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (_app: string, jobName: string, payload: Record<string, unknown>) => {
    enqueued.push({ jobName, payload })
    return "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { app } = await import("~/app")
const { sql } = await import("~/db")
const { PAGE_FX_APP, pageFixtureApp } = await import(
  "~/modules/apps/__fixtures__/page-app/descriptor"
)
const { AppPagesTestAccess, createAppPageHandle, PAGE_KEY_HEADER } = await import(
  "~/modules/apps/app-pages"
)
const { parsePageResult } = await import("~/modules/apps/page-result")
const { registerApps } = await import("~/modules/apps/runtime")
const { invalidateScopeCatalog } = await import("~/modules/permissions/scope-catalog")
const minimal = await import("~/seed/tiers/minimal")
const { seedBaseAgent } = await import("~/seed/factories/agent/agents")
const { createTestOrg } = await import("~/tests/helpers/org")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

type Json = Record<string, unknown>

function pathOf(url: string): string {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}

/** Handle -> link -> page, as the person's app does; answers the route caller. */
async function openedPage(token: string, handle: string) {
  const opened = await app.request(`/api/apps/${PAGE_FX_APP}/pages/open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  })
  const url = ((await opened.json()) as { data: { url: string } }).data.url
  const html = await (await app.request(pathOf(url))).text()
  const base = (/src="([^"]+\/page\.js)"/.exec(html)?.[1] ?? "").replace(/\/page\.js$/, "")
  const key = /,k="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? ""
  return async (route: string, body: unknown) => {
    const res = await app.request(`${pathOf(base)}/routes/${route}`, {
      method: "POST",
      headers: { "content-type": "text/plain", [PAGE_KEY_HEADER]: key },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as { data: Json } }
  }
}

describe("a page's result reaches the conversation it was opened from", () => {
  let orgId: string
  let userId: string
  let token: string
  let threadId: string
  let agentId: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([pageFixtureApp], orgId)
    invalidateScopeCatalog(orgId)
    userId = (await minimal.person(orgId, { role: "member" })).id
    await minimal.grantScope(userId, "pagefx:items:read")
    await minimal.grantScope(userId, "pagefx:items:write")
    token = await minimal.token(userId)
    threadId = await minimal.thread(orgId, userId)
    agentId = (await seedBaseAgent(orgId)).agentId
    // The route answers a result for the conversation beside its own answer.
    AppPagesTestAccess.setRouteExecutor(async ({ params }) => ({
      saved: true,
      pageResult: {
        summary: `Picked ${String((params.body as Json).name)}.`,
        data: { ids: ["f-1"] },
      },
    }))
  }, 180_000)

  afterAll(async () => {
    AppPagesTestAccess.setRouteExecutor(null)
    await releaseTestLock()
  })

  const lines = () => sql<
    { content: string; metadata: Json; author_type: string; author_id: string }[]
  >`
    SELECT content, metadata, author_type, author_id FROM kernel.messages
    WHERE thread_id = ${threadId} AND metadata->>'type' = 'app-page-result'
    ORDER BY created_at`

  test("posts the line as the person, enqueues the agent's turn; the page never sees it", async () => {
    enqueued.length = 0
    const { handle } = await createAppPageHandle({
      orgId,
      userId,
      app: PAGE_FX_APP,
      page: "hello",
      params: { tag: "t" },
      origin: { threadId, agentId },
    })
    const call = await openedPage(token, handle)
    const answer = await call("greet", { name: "Plan" })
    expect(answer.status).toBe(200)
    expect(answer.body.data).toEqual({ saved: true })

    const posted = await lines()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      content: "Picked Plan.",
      author_type: "system",
      author_id: userId,
      metadata: {
        type: "app-page-result",
        app: PAGE_FX_APP,
        page: "hello",
        summary: "Picked Plan.",
        data: { ids: ["f-1"] },
        agentId,
      },
    })
    expect(enqueued).toEqual([
      {
        jobName: "app-page-result-turn",
        payload: expect.objectContaining({ threadId, agentId, requesterId: userId }),
      },
    ])
  })

  test("a page opened without a conversation posts nowhere; params cannot name one", async () => {
    enqueued.length = 0
    const before = (await lines()).length
    const { handle } = await createAppPageHandle({
      orgId,
      userId,
      app: PAGE_FX_APP,
      page: "hello",
      params: { origin: { threadId, agentId } },
    })
    const answer = await (await openedPage(token, handle))("greet", { name: "X" })
    expect(answer.body.data).toEqual({ saved: true })
    expect((await lines()).length).toBe(before)
    expect(enqueued).toEqual([])
  })
})

describe("parsePageResult", () => {
  test("a summary of 1 to 500 characters and data of at most 8 KiB", () => {
    expect(parsePageResult({ summary: " Done. " })).toEqual({ summary: "Done." })
    expect(parsePageResult({ summary: "" })).toBeNull()
    expect(parsePageResult({ summary: "x".repeat(501) })).toBeNull()
    expect(parsePageResult({ summary: "ok", data: [1] })).toBeNull()
    expect(parsePageResult({ summary: "ok", data: { big: "x".repeat(9000) } })).toBeNull()
    expect(parsePageResult("Done")).toBeNull()
  })
})
