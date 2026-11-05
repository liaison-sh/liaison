// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo's recorded computer (a simulated node): the Sessions list badges the
// node and its sessions "Recorded session", and once the replay ended shows
// the end card with the desktop download. A real computer gets neither.
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { DESKTOP_DOWNLOADS_BASE } from "~/lib/desktop-downloads"
import SessionList from "~/modules/sessions/SessionList"
import type { NodeSessionGroup, NodeSessionRow } from "~/modules/sessions/session-api"
import { resetSessionList, setSessionListApi } from "~/modules/sessions/session-list"
import { resetSessionStore } from "~/modules/sessions/session-store"
import { loadNodes, resetNodesStore } from "./nodes-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: { tabs: [], activeTabId: "" },
}))

function row(over: Partial<NodeSessionRow>): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "sim",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the battery percentage stuck at 99%",
    folderName: null,
    repo: "resonant-fw",
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-sonnet-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

const node = (over: Record<string, unknown>) => ({
  id: "sim",
  name: "Demo laptop (recorded)",
  enabled: true,
  online: true,
  simulated: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: null,
  deviceId: "demo-replay",
  queue: { queued: 0, running: 0 },
  ...over,
})

async function show(nodes: unknown[], pages: Partial<Record<NodeSessionGroup, NodeSessionRow[]>>) {
  await loadNodes({ get: vi.fn(async () => ({ nodes })) } as never)
  const get = vi.fn(async (path: string) => {
    const group = new URL(path, "http://x").searchParams.get("group") ?? ""
    return { sessions: pages[group as NodeSessionGroup] ?? [], nextCursor: null }
  })
  setSessionListApi(() => ({ get }) as unknown as Pick<ApiClient, "get">)
  render(() => <SessionList />)
  await waitFor(() => expect(screen.getAllByTestId("session-row").length).toBeGreaterThan(0))
}

afterEach(() => {
  resetSessionList()
  resetSessionStore()
  resetNodesStore()
})

describe("a demo's recorded computer", () => {
  it("badges the node and its running session, with no end card yet", async () => {
    await show([node({})], { running: [row({})] })
    expect(screen.getByTestId("node-line").textContent).toContain("Demo laptop (recorded)")
    expect(screen.getByTestId("node-recorded-badge")).toBeTruthy()
    expect(screen.getByTestId("session-recorded-badge")).toBeTruthy()
    expect(screen.queryByTestId("demo-pair-computer")).toBeNull()
  })

  it("once the replay ended, the end card offers the desktop app", async () => {
    await show([node({})], {
      done: [row({ status: "done", endedAt: new Date().toISOString() })],
    })
    const card = await screen.findByTestId("demo-pair-computer")
    const link = screen.getByTestId("demo-pair-computer-download") as HTMLAnchorElement
    expect(link.href.startsWith(DESKTOP_DOWNLOADS_BASE)).toBe(true)
    expect(card.contains(link)).toBe(true)
  })

  it("a real computer gets no badge and no end card", async () => {
    await show([node({ id: "n1", name: "Mac mini", simulated: false, deviceId: "d1" })], {
      done: [row({ nodeId: "n1", status: "done", endedAt: new Date().toISOString() })],
    })
    expect(screen.queryByTestId("node-recorded-badge")).toBeNull()
    expect(screen.queryByTestId("session-recorded-badge")).toBeNull()
    expect(screen.queryByTestId("demo-pair-computer")).toBeNull()
  })
})
