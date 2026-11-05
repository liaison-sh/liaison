// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4-T10 (S8 mobile layout, charter "Phone"): at phone tier Sessions is two
// screens. `/sessions` is the list alone; `/sessions/:id` is one session full
// screen whose top bar (the session tab type's `phoneHeader`) carries back to
// the list, the title and Stop. Every control here is a 44 px target (jsdom
// has no layout: the min-size classes are asserted).
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const tier = vi.hoisted(() => ({ current: "phone" as "phone" | "tablet" | "desktop" }))
vi.mock("~/modules/shell/shell-tier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/shell-tier")>()),
  shellTier: () => tier.current,
}))

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

import type { SessionComposerProps } from "./SessionComposer"

const composerProps: SessionComposerProps[] = []
vi.mock("./SessionComposer", () => ({
  default: (p: SessionComposerProps) => {
    composerProps.push(p)
    return null
  },
}))

import { getTabType } from "~/framework/app-registry"
import { loadNodes, resetNodesStore } from "~/modules/nodes/nodes-store"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import SessionPhoneHeader, { SessionPhoneChips } from "./SessionPhoneHeader"
import SessionsHome from "./SessionsHome"
import SessionView from "./SessionView"
import { registerSessionActions, resetSessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { resetSessionList, setSessionListApi } from "./session-list"
import { applyRow, resetSessionStore, setSessionStoreApi } from "./session-store"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the sum bug in the walk sample and open a pull request",
    folderName: "sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "standard",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 2,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-14T08:00:00.000Z",
    startedAt: "2026-10-14T08:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-14T08:00:00.000Z",
    ...over,
  }
}

const ev = (seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) =>
  ({
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    type,
    payload,
  }) as NodeSessionEvent

const EVENTS = [
  ev(1, "user_message", { text: "Fix it" }),
  ev(2, "assistant_text", { text: "On it." }),
]

function sessionApi(r: NodeSessionRow, events = EVENTS) {
  const get = vi.fn(async (path: string) => {
    if (path.includes("/events")) {
      const after = Number(new URL(path, "http://x").searchParams.get("after"))
      const out = events.filter((e) => e.seq > after)
      return { events: out, lastSeq: out.at(-1)?.seq ?? after }
    }
    return r
  })
  setSessionStoreApi(() => ({ get }) as never)
}

function listApi(rows: NodeSessionRow[]) {
  const get = vi.fn(async (path: string) => {
    const group = new URL(path, "http://x").searchParams.get("group")
    return { sessions: group === "running" ? rows : [], nextCursor: null }
  })
  setSessionListApi(() => ({ get }) as never)
}

const TAP = ["min-h-11", "min-w-11"]
const hasTap = (el: Element) => TAP.every((c) => el.classList.contains(c))

afterEach(() => {
  resetSessionList()
  resetSessionStore()
  resetSessionActions()
  resetTabStore()
  resetNodesStore()
  composerProps.length = 0
  tier.current = "phone"
  resetSessionCommands()
})

describe("Sessions on the phone: two screens (P4-T10)", () => {
  it("/sessions renders the list and no transcript", async () => {
    listApi([row()])
    render(() => <SessionsHome />)
    await waitFor(() => expect(screen.getByTestId("session-list")).toBeTruthy())
    expect(screen.queryByTestId("session-transcript")).toBeNull()
    expect(screen.queryByTestId("session-view")).toBeNull()
    // No wide-screen "pick a session" pane under the list.
    expect(screen.queryByText("Pick a session on the left.")).toBeNull()
  })

  it("/sessions/:id renders the session and no list, its chips row under the bar", async () => {
    sessionApi(row())
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("session-transcript")).toBeTruthy())
    expect(screen.queryByTestId("session-list")).toBeNull()
    // Title and Stop live in the top bar: the desktop header is not repeated.
    expect(screen.queryByTestId("session-header")).toBeNull()
    const chips = screen.getByTestId("session-phone-chips")
    expect(chips.textContent).toContain("sample")
    expect(chips.textContent).toContain("claude-haiku-4-5")
    expect(hasTap(screen.getByTestId("session-phone-files"))).toBe(true)
  })

  it("the chips row carries every detail the desktop header shows, behind a 44 px Details toggle", async () => {
    await loadNodes({
      get: vi.fn(async () => ({
        nodes: [
          {
            id: "n1",
            name: "Mac mini",
            enabled: true,
            online: true,
            lastSeenAt: null,
            os: "macos",
            appVersion: "0.1.20",
            deviceId: "d1",
            queue: { queued: 0, running: 0 },
          },
        ],
      })),
    } as never)
    render(() => (
      <SessionPhoneChips
        session={row({
          branch: "node/readme",
          pushed: true,
          prUrl: "https://example.com/pr/1",
          claudeCode: "2.1.7 installed /opt/homebrew/bin/claude",
          tokensIn: 400_000,
          tokensOut: 12_000,
          startedAt: new Date(Date.now() - 23.5 * 60_000).toISOString(),
        })}
        events={EVENTS}
        onOpenFiles={() => {}}
      />
    ))
    const toggle = screen.getByTestId("session-phone-details-toggle")
    expect(hasTap(toggle)).toBe(true)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("session-phone-details")).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    const details = screen.getByTestId("session-phone-details")
    for (const text of [
      "node/readme",
      "pushed",
      "Standard",
      "Mac mini",
      "Claude Code 2.1.7 (installed)",
      "412k tokens",
      "23 min",
      "You",
    ]) {
      expect(details.textContent).toContain(text)
    }
    // The absolute path stays in the tooltip only (charter).
    expect(details.textContent).not.toContain("/opt/homebrew")
    expect(screen.getByRole("link", { name: /Pull request/ }).getAttribute("href")).toBe(
      "https://example.com/pr/1",
    )
    fireEvent.click(toggle)
    expect(screen.queryByTestId("session-phone-details")).toBeNull()
  })

  it("S51: the phone chips show who drives the session, its reason in its title, and no Open in VS Code", () => {
    const events = [
      ...EVENTS,
      ev(3, "system", {
        subtype: "driver",
        text: "Driven from VS Code",
        data: { elsewhere: true, via: "vscode" },
      }),
    ]
    render(() => (
      <SessionPhoneChips
        session={row({
          status: "waiting",
          state: "needs_you",
          endedAt: "2026-10-14T08:10:00.000Z",
        })}
        events={events}
        onOpenFiles={() => {}}
      />
    ))
    const badge = screen.getByTestId("session-driver")
    expect(badge.textContent).toBe("Driven from VS Code")
    expect(badge.getAttribute("title")).toBe(
      "VS Code is driving this session. Send again to resume it here as well.",
    )
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull()
  })

  it("S20/S22/S55: under Details the phone shows the subagent, tokens, cache and context chips", () => {
    const at = (ms: number) => new Date(ms).toISOString()
    const now = Date.now()
    const events = [
      ...EVENTS,
      ev(3, "system", {
        subtype: "task_started",
        text: "",
        data: { taskId: "a", toolUseId: "tu_a", taskType: "local_agent" },
      }),
      {
        ...ev(4, "usage", {
          tokensIn: 1000,
          tokensOut: 10,
          model: "m",
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 900,
          contextTokens: 50_000,
        }),
        at: at(now - 60_000),
      } as NodeSessionEvent,
      ev(5, "result", { text: "ok", contextWindow: 200_000 }),
    ].map((e) => (e.type === "system" ? ({ ...e, at: at(now - 1000) } as NodeSessionEvent) : e))
    const onOpenSubagents = vi.fn()
    render(() => (
      <SessionPhoneChips
        session={row({
          tokensIn: 1_000_000,
          tokensOut: 12_000,
          tokensCacheRead: 900_000,
          tokensCacheWrite5m: 40_000,
          tokensCacheWrite1h: 20_000,
        })}
        events={events}
        onOpenFiles={() => {}}
        onOpenSubagents={onOpenSubagents}
      />
    ))
    fireEvent.click(screen.getByTestId("session-phone-details-toggle"))
    const details = screen.getByTestId("session-phone-details")
    const q = (name: string) => details.querySelector(`[data-chip="${name}"]`)?.textContent
    expect(q("subagents")).toBe("1 running · 0 stuck · 0 done")
    expect(q("tokens")).toBe("Tokens in 100k · out 12k")
    expect(q("cache")).toMatch(/^Cache 5\d:\d\d$/)
    expect(q("context")).toBe("Context 50k / 200k · 25%")
    fireEvent.click(screen.getByRole("button", { name: /running/ }))
    expect(onOpenSubagents).toHaveBeenCalledTimes(1)
  })

  it("the phone session screen's composer hides Stop (it is in the top bar) and is compact (P4-T11)", async () => {
    sessionApi(row())
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(composerProps.length).toBeGreaterThan(0))
    const last = composerProps.at(-1) as SessionComposerProps
    expect(last.hideStop).toBe(true)
    expect(last.compact).toBe(true)
  })

  it("the phone header shows Stop while running and waiting, and not when done", () => {
    registerSessionActions({ stop: vi.fn(async () => {}) })
    applyRow(row({ status: "running" }))
    render(() => <SessionPhoneHeader entityId="s1" />)
    expect(screen.getByTestId("session-phone-stop")).toBeTruthy()
    applyRow(row({ status: "waiting", pendingCount: 1 }))
    expect(screen.getByTestId("session-phone-stop")).toBeTruthy()
    applyRow(row({ status: "done", endedAt: "2026-10-14T08:10:00.000Z" }))
    expect(screen.queryByTestId("session-phone-stop")).toBeNull()
  })

  it("Stop calls the stop command once", async () => {
    let release: () => void = () => {}
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)))
    registerSessionActions({ stop })
    applyRow(row({ status: "waiting", pendingCount: 1 }))
    render(() => <SessionPhoneHeader entityId="s1" />)
    const button = screen.getByTestId("session-phone-stop")
    expect(button.getAttribute("aria-label")).toBe("Stop the session")
    fireEvent.click(button)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith("s1")
    release()
  })

  it("S7/S14: the phone menu offers Mark done and the bell", async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({
      commandId: "00000000-0000-4000-8000-000000000001",
      seq: 1,
    }))
    const patch = vi.fn(async (_path: string, body?: unknown) => ({
      ...row(),
      ...(body as object),
    }))
    setSessionCommandsApi(
      () => ({ post, patch, get: vi.fn(async () => ({ commands: [] })) }) as never,
    )
    applyRow(
      row({
        status: "waiting",
        state: "needs_you",
        muted: false,
        endedAt: "2026-10-14T08:10:00.000Z",
      }),
    )
    render(() => <SessionPhoneHeader entityId="s1" />)
    const more = screen.getByTestId("session-phone-more")
    expect(hasTap(more)).toBe(true)
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Mark done" }), { key: "Enter" })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "mark_done", payload: {} },
    ])
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Mute this session" }), {
      key: "Enter",
    })
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0]).toEqual(["/me/node-sessions/s1", { muted: true }])
    // The row the server answered with says muted: the menu offers the way back.
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    expect(await screen.findByRole("menuitem", { name: "Unmute this session" })).toBeTruthy()
  })

  it("S7: the phone menu is absent when the row has no state/muted field", () => {
    applyRow(row({ status: "waiting", pendingCount: 1 }))
    render(() => <SessionPhoneHeader entityId="s1" />)
    expect(screen.queryByTestId("session-phone-more")).toBeNull()
  })

  it("Back opens /sessions", () => {
    applyRow(row())
    render(() => <SessionPhoneHeader entityId="s1" />)
    fireEvent.click(screen.getByTestId("session-phone-back"))
    const active = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    expect(active?.type).toBe("kernel:sessions")
    expect(active?.routePath).toBe("/sessions")
  })

  it("every button in the header and every list row has a 44 px minimum", async () => {
    registerSessionActions({ stop: vi.fn(async () => {}) })
    applyRow(row())
    const header = render(() => <SessionPhoneHeader entityId="s1" />)
    const headerButtons = [...header.container.querySelectorAll("button")]
    expect(headerButtons).toHaveLength(2)
    for (const b of headerButtons) expect(hasTap(b)).toBe(true)
    header.unmount()

    listApi([row(), row({ id: "s2", title: "Second" })])
    const list = render(() => <SessionsHome />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(2))
    for (const r of screen.getAllByTestId("session-row"))
      expect(r.classList.contains("min-h-11")).toBe(true)
    for (const b of list.container.querySelectorAll("button"))
      expect(b.classList.contains("min-h-11")).toBe(true)
  })

  it("on a desktop the session view keeps its header and no phone chips", async () => {
    tier.current = "desktop"
    sessionApi(row())
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("session-header")).toBeTruthy())
    expect(screen.queryByTestId("session-phone-chips")).toBeNull()
    const last = composerProps.at(-1) as SessionComposerProps
    expect(last.hideStop ?? false).toBe(false)
    expect(last.compact ?? false).toBe(false)
  })
})

describe("the session tab type's phone top bar (P4-T10)", () => {
  it("is registered as the session tab type's phoneHeader, and Sessions is on Work", async () => {
    const { bootstrapKernelApps, resetBootstrap } = await import("~/framework/bootstrap")
    const { getActivityBarEntries } = await import("~/framework/app-registry")
    resetBootstrap()
    bootstrapKernelApps()
    expect(getTabType("kernel:session")?.phoneHeader).toBeDefined()
    expect(getActivityBarEntries().some((e) => e.id === "sessions")).toBe(true)
  })
})

describe("the phone header: autonomy (S30, S33)", () => {
  it("S30: an autonomous row shows the Autonomous chip on the phone header", () => {
    const { unmount } = render(() => (
      <SessionPhoneChips
        session={row({ autonomy: "autonomous" })}
        events={EVENTS}
        onOpenFiles={() => {}}
      />
    ))
    expect(
      screen.getByTestId("session-phone-chips").querySelector("[data-testid=session-autonomous]")
        ?.textContent,
    ).toBe("Autonomous")
    unmount()
    render(() => (
      <SessionPhoneChips
        session={row({ autonomy: "guided" })}
        events={EVENTS}
        onOpenFiles={() => {}}
      />
    ))
    expect(screen.queryByTestId("session-autonomous")).toBeNull()
  })

  it("S33: the phone menu's Run on its own sends set_autonomy and a row_only answer shows the update note", async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({
      commandId: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      applied: "row_only",
    }))
    setSessionCommandsApi(
      () => ({ post, patch: vi.fn(), get: vi.fn(async () => ({ commands: [] })) }) as never,
    )
    resetToastStore()
    applyRow(row({ autonomy: "guided" }))
    render(() => <SessionPhoneHeader entityId="s1" />)
    const more = screen.getByTestId("session-phone-more")
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Run on its own" }), {
      key: "Enter",
    })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "set_autonomy", payload: { autonomy: "autonomous" } },
    ])
    await waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]?.message).toBe("Applies when this computer's Liaison updates.")
  })

  it("S30: a row without autonomy hides the switch from the phone menu (an older API)", () => {
    applyRow(row({ status: "running" }))
    render(() => <SessionPhoneHeader entityId="s1" />)
    expect(screen.queryByTestId("session-phone-more")).toBeNull()
  })
})

describe("the phone header: Atelier and the Needs-you reason (S35, S32, S57)", () => {
  it("S35: the phone chips show the Atelier stepper from row.atelier; no field, no stepper", () => {
    const atelier = {
      id: "2026-10-16-feature-ab12",
      rung: "R3",
      phase: "spec",
      plan: ["frame", "spec", "execute"],
      done: ["frame"],
      status: "running" as const,
      awaiting: "user" as const,
    }
    const { unmount } = render(() => (
      <SessionPhoneChips session={row({ atelier })} events={EVENTS} onOpenFiles={() => {}} />
    ))
    const stepper = screen.getByTestId("atelier-stepper")
    expect(
      [...stepper.querySelectorAll("[data-testid=atelier-step]")].map(
        (s) => (s as HTMLElement).dataset.state,
      ),
    ).toEqual(["done", "current", "pending"])
    expect(stepper.querySelector("[data-testid=atelier-status]")?.textContent).toBe(
      "Waiting for you",
    )
    unmount()
    render(() => <SessionPhoneChips session={row()} events={EVENTS} onOpenFiles={() => {}} />)
    expect(screen.queryByTestId("atelier-stepper")).toBeNull()
  })

  it("S32: the phone chips say a needs_you row's reason code", () => {
    render(() => (
      <SessionPhoneChips
        session={row({
          status: "waiting",
          state: "needs_you",
          reasonCode: "stuck_after_5_continues",
          resultSummary: "node words",
        })}
        events={EVENTS}
        onOpenFiles={() => {}}
      />
    ))
    expect(screen.getByTestId("session-header-reason").textContent).toBe(
      "Stuck after 5 tries on its own.",
    )
  })
})

describe("the phone header: imports (W3, S41, A49)", () => {
  it("S41, A49: the phone menu offers Take over, Stop following and Delete from Liaison on a following follow-mode import; the chips say so", async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({
      commandId: "00000000-0000-4000-8000-000000000001",
      seq: 1,
    }))
    setSessionCommandsApi(
      () => ({ post, patch: vi.fn(), get: vi.fn(async () => ({ commands: [] })) }) as never,
    )
    const imported = row({
      source: "import",
      importMode: "follow",
      importFrom: "cli",
      following: true,
      cwdSubdir: "",
    })
    applyRow(imported)
    render(() => (
      <>
        <SessionPhoneHeader entityId="s1" />
        <SessionPhoneChips session={imported} events={[]} onOpenFiles={() => {}} />
      </>
    ))
    expect(screen.getByTestId("session-following").textContent).toBe("Following Terminal")
    expect(screen.getByTestId("session-imported").textContent).toBe("Imported")
    const more = screen.getByTestId("session-phone-more")
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    expect(await screen.findByRole("menuitem", { name: "Stop following" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Delete from Liaison" })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Take over" }), { key: "Enter" })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "take_over", payload: {} },
    ])
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Delete from Liaison" }), {
      key: "Enter",
    })
    expect((await screen.findByTestId("session-delete-dialog")).textContent).toContain(
      "The session's transcript stays on your computer.",
    )
  })
})
