// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S28: the live view of an agent turn keeps the true order of its thinking,
// tool calls and text, (a) while it streams, (b) through a socket drop in the
// middle of the turn, and (c) through the switch to the saved message.
//
// The turn is scripted on the server (`scriptAgentTurn`) and its two tool
// calls run for real. Each step waits before it streams, so the live block
// stays on screen long enough to be read:
//
//   step 1: thinking, tool A (threads_search), a line of narration
//   step 2: thinking, tool B (threads_read)
//   step 3: the answer
//
// Expected order, live and saved: thought, A, text, thought, B, text.
//
// Modelled on `agent-timeline-interleave.scenario.test.ts`, which checks the
// settled order only.

import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page, WebSocketRoute } from "@playwright/test"
import { loginAsAdmin, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import {
  agentDmThreadId,
  type ScriptedTurnStep,
  scriptAgentTurn,
  waitForTurnEnd,
} from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"

const TOOL_A = "kernel__threads_search"
const TOOL_B = "kernel__threads_read"
const NARRATION = "Found a likely thread, opening it next."
const LIVE_PREFIX = ["thought", TOOL_A, "text", "thought", TOOL_B]
const SETTLED = [...LIVE_PREFIX, "text"]

function script(threadId: string, answer: string, delayMs: number): ScriptedTurnStep[] {
  return [
    {
      delayMs,
      reasoning: "First I look for the thread about orders.",
      toolCalls: [{ name: TOOL_A, args: { query: "orders" } }],
      text: NARRATION,
    },
    {
      delayMs,
      reasoning: "Now I read that thread.",
      toolCalls: [{ name: TOOL_B, args: { threadId } }],
    },
    { delayMs, text: answer },
  ]
}

/** The kinds drawn inside `root`, in DOM order: one querySelectorAll snapshot. */
function readOrder(root: Locator): Promise<string[]> {
  return root.evaluate((el) =>
    Array.from(
      el.querySelectorAll(
        '[data-testid="thinking-block"],[data-testid="tool-call-row"],[data-testid="agent-activity-text"]',
      ),
    ).map((node) => {
      const id = node.getAttribute("data-testid")
      if (id === "tool-call-row") return node.getAttribute("data-tool-name") ?? "tool"
      return id === "thinking-block" ? "thought" : "text"
    }),
  )
}

/** Every `/ws` socket goes through the test, which can cut it or delay frames. */
async function routeSockets(page: Page, opts: { delayFrame?: (frame: string) => number } = {}) {
  const sockets: WebSocketRoute[] = []
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws"),
    (ws) => {
      const server = ws.connectToServer()
      sockets.push(ws)
      ws.onMessage((m) => server.send(m))
      server.onMessage((m) => {
        const wait = typeof m === "string" ? (opts.delayFrame?.(m) ?? 0) : 0
        if (wait > 0) setTimeout(() => ws.send(m), wait)
        else ws.send(m)
      })
      ws.onClose(() => void server.close())
      server.onClose((code, reason) => void ws.close({ code, reason }))
    },
  )
  return {
    count: () => sockets.length,
    cutLast: () => sockets[sockets.length - 1]?.close({ code: 4000, reason: "e2e drop" }),
  }
}

interface SavedTurn {
  content: string | null
  authorType?: string
  metadata?: {
    timeline?: Array<{ kind: string; toolCallId?: string }>
    toolCalls?: Array<{ toolCallId: string; toolName: string }>
  } | null
}

/** The saved reply's `metadata.timeline`, as kinds in the same vocabulary as `readOrder`. */
async function savedTimeline(
  env: WorkerEnv,
  token: string,
  threadId: string,
  answer: string,
): Promise<string[]> {
  const res = await api(env.serverUrl, `/api/threads/${threadId}/messages?limit=50`, { token })
  const rows = ((res.body as { data?: SavedTurn[] }).data ?? []).filter(
    (m) => m.authorType === "agent" && m.content?.includes(answer),
  )
  const meta = rows[rows.length - 1]?.metadata
  const names = new Map((meta?.toolCalls ?? []).map((c) => [c.toolCallId, c.toolName]))
  return (meta?.timeline ?? []).map((entry) =>
    entry.kind === "tool"
      ? (names.get(entry.toolCallId ?? "") ?? "tool")
      : entry.kind === "reasoning"
        ? "thought"
        : "text",
  )
}

test.describe("Agent live order", () => {
  test("live, the turn draws in the order it was written, then hands over whole", async ({
    page,
    env,
    world,
  }) => {
    test.setTimeout(120_000)
    await seedModelPricingAndCredits(env, world.org.id)
    const answer = `Live order answer ${Date.now()}.`
    const threadId = await agentDmThreadId(env, world.admin.token)
    await scriptAgentTurn(env, { threadId, steps: script(threadId, answer, 1500) })

    // (c) Hold the turn's `done` frame 300 ms so the reply's outbox copy lands
    // first: the handover must still never draw the answer twice.
    await routeSockets(page, {
      delayFrame: (frame) =>
        frame.includes('"agent_stream"') && frame.includes('"done"') ? 300 : 0,
    })
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)

    // Sample, every animation frame, how often the answer is drawn.
    await page.evaluate((text) => {
      const w = window as unknown as { __maxAnswerDraws?: number }
      w.__maxAnswerDraws = 0
      const tick = () => {
        const body = document.body.textContent ?? ""
        const n = body.split(text).length - 1
        if (n > (w.__maxAnswerDraws ?? 0)) w.__maxAnswerDraws = n
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, answer)

    await sendInConversation(page, conversation, "what is happening with my orders?")

    // (a) While tool B's row is up and the turn is not over, the live order.
    const live = conversation.getByTestId("agent-stream-block").last()
    await expect(
      live.locator(`[data-testid="tool-call-row"][data-tool-name="${TOOL_B}"]`),
    ).toBeVisible({ timeout: 30_000 })
    expect(await readOrder(live)).toEqual(LIVE_PREFIX)

    // (c) After the end, the saved row's order is the reply's timeline.
    await waitForTurnEnd(env, { threadId, token: world.admin.token, contains: answer })
    const saved = await savedTimeline(env, world.admin.token, threadId, answer)
    expect(saved).toEqual(SETTLED)
    const row = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: answer })
      .last()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => readOrder(row), { timeout: 20_000, intervals: [250] }).toEqual(saved)
    const maxDraws = await page.evaluate(
      () => (window as unknown as { __maxAnswerDraws?: number }).__maxAnswerDraws ?? 0,
    )
    expect(maxDraws, "the answer was drawn twice during the handover").toBe(1)
  })

  test("a socket drop in the middle of the turn resumes in order, without repeats", async ({
    page,
    env,
    world,
  }) => {
    test.setTimeout(120_000)
    await seedModelPricingAndCredits(env, world.org.id)
    const answer = `Resumed order answer ${Date.now()}.`
    const threadId = await agentDmThreadId(env, world.admin.token)
    // Longer steps: the cut spans step 2, and the resumed block must still be
    // live (step 3 not out) when it is read.
    await scriptAgentTurn(env, { threadId, steps: script(threadId, answer, 4000) })

    const sockets = await routeSockets(page)
    // While the network is "down" a new socket's ticket request hangs, and goes
    // through the moment it is back: the reconnect then happens at once rather
    // than after a backoff that failed attempts would have grown.
    let networkDown = false
    const waiting: Array<() => void> = []
    await page.route("**/api/auth/ws-ticket", async (route) => {
      if (networkDown) await new Promise<void>((resume) => waiting.push(resume))
      await route.continue()
    })
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "what is happening with my orders?")

    // (b) Cut right after A's row appears; hold the cut through step 2 (which
    // streams 4 s after step 1), then restore.
    const live = conversation.getByTestId("agent-stream-block").last()
    await expect(
      live.locator(`[data-testid="tool-call-row"][data-tool-name="${TOOL_A}"]`),
    ).toBeVisible({ timeout: 30_000 })
    const before = sockets.count()
    networkDown = true
    await sockets.cutLast()
    await page.waitForTimeout(5000)
    networkDown = false
    for (const resume of waiting.splice(0)) resume()

    // Reconnected, the block is reseeded and reads the full prefix, once.
    await expect.poll(() => sockets.count(), { timeout: 15_000 }).toBeGreaterThan(before)
    await expect
      .poll(() => readOrder(live), { timeout: 10_000, intervals: [100] })
      .toEqual(LIVE_PREFIX)

    await waitForTurnEnd(env, { threadId, token: world.admin.token, contains: answer })
    const saved = await savedTimeline(env, world.admin.token, threadId, answer)
    expect(saved).toEqual(SETTLED)
    const row = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: answer })
      .last()
    await expect.poll(() => readOrder(row), { timeout: 20_000, intervals: [250] }).toEqual(saved)
  })
})
