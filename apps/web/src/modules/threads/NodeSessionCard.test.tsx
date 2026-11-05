// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T25 (S11, D8, L28, charter "Chat card"): one live card per dispatch in
// the chat. Title, status, folder, model and node, elapsed time, the latest
// activity (or the waiting reason with Review), Open session, and the result
// summary when done. Another user reads a static line, never the session.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { NodeSessionRow } from "~/modules/sessions/session-api"
import { applyRow, resetSessionStore } from "~/modules/sessions/session-store"
import { ApiContext } from "~/modules/shell/ApiContext"

vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

import { openTab } from "~/modules/shell/tab-store"
import NodeSessionCard from "./NodeSessionCard"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: "t1",
    sourceMessageId: "m1",
    title: "Summarise the README",
    prompt: "Summarise the README",
    folderName: "liaison-walk-sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 3,
    latestActivity: "Bash: ls -la",
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: "2026-10-13T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

function ev(seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) {
  const at = new Date(Date.parse("2026-10-13T10:00:00.000Z") + seq * 1000).toISOString()
  return { seq, at, receivedAt: at, type, payload } as NodeSessionEvent
}

function fakeApi(answer: () => NodeSessionRow | Error, log: NodeSessionEvent[] = []) {
  return {
    get: vi.fn(async (path: string) => {
      if (path.includes("/events")) {
        const after = Number(/after=(\d+)/.exec(path)?.[1] ?? 0)
        return { events: log.filter((e) => e.seq > after), lastSeq: log.at(-1)?.seq ?? 0 }
      }
      const a = answer()
      if (a instanceof Error) throw a
      return a
    }),
  }
}

function renderCard(api: ReturnType<typeof fakeApi>, extra: { ownerName?: string | null } = {}) {
  return render(() => (
    <ApiContext.Provider value={api as never}>
      <NodeSessionCard
        sessionId="s1"
        nodeName="Minimac"
        ownerName={extra.ownerName ?? null}
        fallbackText="Started on Minimac: Summarise the README"
      />
    </ApiContext.Provider>
  ))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date("2026-10-13T10:01:05.000Z"))
})

afterEach(() => {
  vi.useRealTimers()
  resetSessionStore()
  vi.mocked(openTab).mockClear()
})

describe("NodeSessionCard", () => {
  it("shows title, status, folder, model, node, elapsed and the latest activity", async () => {
    renderCard(fakeApi(() => row()))
    const card = await screen.findByTestId("node-session-card")
    await waitFor(() => expect(card.textContent).toContain("Summarise the README"))
    expect(screen.getByTestId("node-session-card-status").textContent).toBe("Running")
    expect(card.textContent).toContain("liaison-walk-sample")
    expect(card.textContent).toContain("claude-haiku-4-5")
    expect(card.textContent).toContain("Minimac")
    expect(screen.getByTestId("node-session-card-elapsed").textContent).toBe("1:05")
    expect(screen.getByTestId("node-session-card-activity").textContent).toBe("Bash: ls -la")
    fireEvent.click(screen.getByRole("button", { name: "Open session" }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:session", entityId: "s1" }),
    )
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull()
  })

  it("the card updates when the row changes", async () => {
    renderCard(fakeApi(() => row()))
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe("Bash: ls -la"),
    )
    // A node_session socket frame.
    applyRow(row({ latestActivity: "Read: README.md", lastSeq: 4 }))
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe("Read: README.md"),
    )
  })

  it("waiting shows the reason and Review, which opens the oldest open request", async () => {
    const log = [
      ev(1, "permission_request", { requestId: "r1", tool: "Bash", input: {}, reason: "x" }),
      ev(2, "decision", { requestId: "r1", outcome: "allow", by: "owner" }),
      ev(3, "permission_request", { requestId: "r2", tool: "Edit", input: {}, reason: "y" }),
      ev(4, "question", { requestId: "r3", questions: [] }),
    ]
    renderCard(
      fakeApi(
        () =>
          row({
            status: "waiting",
            pendingCount: 2,
            waitingReason: "permission: Edit",
            lastSeq: 4,
          }),
        log,
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe(
        "Waiting on you: permission for Edit",
      ),
    )
    expect(screen.getByTestId("node-session-card-status").textContent).toBe("Waiting on you")
    const review = await screen.findByRole("button", { name: "Review" })
    await waitFor(() => expect(review.getAttribute("data-request-id")).toBe("r2"))
    fireEvent.click(review)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kernel:session",
        entityId: "s1",
        routePath: "/sessions/s1?request=r2",
      }),
    )
  })

  it("D31f: the open-request lookup reads the main thread only (scope=top), never the subagents' events", async () => {
    const log = [
      ev(1, "permission_request", { requestId: "r1", tool: "Bash", input: {}, reason: "x" }),
      ...Array.from({ length: 6 }, (_, i) => ({
        ...ev(2 + i, "assistant_text", { text: `sub ${i}` }),
        parentToolUseId: "tu_a",
      })),
      ev(8, "decision", { requestId: "r1", outcome: "allow", by: "owner" }),
      ev(9, "question", { requestId: "r3", questions: [] }),
    ] as NodeSessionEvent[]
    const api = fakeApi(
      () => row({ status: "waiting", pendingCount: 1, waitingReason: "question", lastSeq: 9 }),
      log,
    )
    const base = api.get.getMockImplementation() as (p: string) => Promise<never>
    api.get.mockImplementation(async (path: string): Promise<never> => {
      if (!path.includes("/events")) return base(path)
      const after = Number(/after=(\d+)/.exec(path)?.[1] ?? 0)
      const top = path.includes("scope=top")
      return {
        events: log.filter((e) => e.seq > after && (!top || !e.parentToolUseId)),
        lastSeq: 9,
        ...(top ? { through: 9 } : {}),
      } as never
    })
    renderCard(api)
    const review = await screen.findByRole("button", { name: "Review" })
    await waitFor(() => expect(review.getAttribute("data-request-id")).toBe("r3"))
    const reads = api.get.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/events"))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((p) => p.includes("scope=top"))).toBe(true)
  })

  it("S51: a needs_you card with a reason code says it from the code, not the node's English summary", async () => {
    renderCard(
      fakeApi(() =>
        row({
          status: "waiting",
          state: "needs_you",
          endedAt: "2026-10-13T10:01:00.000Z",
          resultSummary: "VS Code is driving this session. Send again to resume it here as well.",
          reasonCode: "driven_elsewhere_cli",
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe(
        "A terminal is driving this session. Send again to resume it here as well.",
      ),
    )
  })

  it("S51/D14: a reason code from a newer server falls back to the session's words, never a raw key", async () => {
    renderCard(
      fakeApi(() =>
        row({
          status: "waiting",
          state: "needs_you",
          endedAt: "2026-10-13T10:01:00.000Z",
          resultSummary: "Waiting for a reviewer.",
          // A newer server may send a code this client does not know.
          reasonCode: "a_code_from_a_newer_server" as NodeSessionRow["reasonCode"],
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toContain(
        "Waiting for a reviewer.",
      ),
    )
    const text = screen.getByTestId("node-session-card-activity").textContent ?? ""
    expect(text).not.toContain("reasonCode")
    expect(text).not.toContain("a_code_from_a_newer_server")
  })

  it("W2-D9: a stopped card never says it is waiting; its last tool line still shows", async () => {
    renderCard(
      fakeApi(() =>
        row({
          status: "stopped",
          endedAt: "2026-10-13T10:01:00.000Z",
          latestActivity: "Waiting: permission for Bash",
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-status").textContent).toBe("Stopped"),
    )
    expect(screen.queryByTestId("node-session-card-activity")).toBeNull()
    applyRow(
      row({
        status: "stopped",
        endedAt: "2026-10-13T10:01:00.000Z",
        latestActivity: "Bash: npm test",
        lastSeq: 9,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe("Bash: npm test"),
    )
  })

  it("W2-D7: a needs_you card says the session's words without their markdown", async () => {
    renderCard(
      fakeApi(() =>
        row({
          status: "waiting",
          state: "needs_you",
          endedAt: "2026-10-13T10:01:00.000Z",
          resultSummary: "Which name: **foo** or **bar**?",
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe(
        "The session says: Which name: foo or bar?",
      ),
    )
  })

  it("final recheck: a needs_you card says the computer's own park reason as the computer's", async () => {
    renderCard(
      fakeApi(() =>
        row({
          status: "waiting",
          state: "needs_you",
          endedAt: "2026-10-13T10:01:00.000Z",
          reasonCode: "workspace_blocked",
          resultSummary: "Your changes to README.md would be overwritten by the switch.",
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-session-card-activity").textContent).toBe(
        "Your computer says: Your changes to README.md would be overwritten by the switch.",
      ),
    )
  })

  it("done shows the 300-char summary and stops the clock", async () => {
    const summary = "s".repeat(320)
    renderCard(
      fakeApi(() =>
        row({
          status: "done",
          resultSummary: summary,
          endedAt: "2026-10-13T10:00:42.000Z",
        }),
      ),
    )
    const result = await screen.findByTestId("node-session-card-result")
    expect(result.textContent).toContain("s".repeat(300))
    expect(result.textContent).not.toContain("s".repeat(301))
    expect(screen.getByTestId("node-session-card-status").textContent).toBe("Done")
    expect(screen.getByTestId("node-session-card-elapsed").textContent).toBe("0:42")
    vi.advanceTimersByTime(5000)
    expect(screen.getByTestId("node-session-card-elapsed").textContent).toBe("0:42")
  })

  it("no absolute local path in the card's title, summary or activity (walk D16)", async () => {
    const wt = "/Users/sam/Liaison Node/worktrees/liaison-walk-sample-3f2a"
    renderCard(
      fakeApi(() =>
        row({
          status: "done",
          title: `Fix ${wt}/README.md`,
          resultSummary: `I updated ${wt}/README.md and ${wt}/src/a.ts.`,
          endedAt: "2026-10-13T10:00:42.000Z",
        }),
      ),
    )
    const card = await screen.findByTestId("node-session-card")
    await waitFor(() => expect(card.textContent).toContain("README.md"))
    expect(card.textContent).not.toContain("/Users")
    expect(card.textContent).not.toContain("worktrees")
    expect(screen.getByTestId("node-session-card-result").textContent).toBe(
      "I updated README.md and src/a.ts.",
    )
  })

  it("no absolute local path in a running card's activity (walk D16)", async () => {
    renderCard(
      fakeApi(() =>
        row({ latestActivity: "Bash: cat /Users/sam/Liaison\\ Node/worktrees/x-1/README.md" }),
      ),
    )
    const activity = await screen.findByTestId("node-session-card-activity")
    expect(activity.textContent).toBe("Bash: cat README.md")
  })

  it("another user sees the static line", async () => {
    renderCard(
      fakeApi(() => new ApiError("not found", 404)),
      { ownerName: "Ana" },
    )
    const line = await screen.findByTestId("node-session-card-static")
    expect(line.textContent).toBe("Running on Ana's computer")
    expect(screen.queryByTestId("node-session-card")).toBeNull()
  })

  it("with no owner name, the static line is the message's own text", async () => {
    renderCard(fakeApi(() => new ApiError("forbidden", 403)))
    const line = await screen.findByTestId("node-session-card-static")
    expect(line.textContent).toBe("Started on Minimac: Summarise the README")
  })
})
