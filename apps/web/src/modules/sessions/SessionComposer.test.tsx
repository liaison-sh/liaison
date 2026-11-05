// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T15: the composer (charter "The composer", S8, S9). Placeholder by state,
// Send and the queued bubble, Stop, the model and level selects (a lower
// level at once, a raise only through the in-app confirmation), and the
// answer-in-card line with several questions open.
import type { NodeLevel, NodeSessionStatus } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { loadNodes, resetNodesStore, setNodesStoreApi } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { markOrphanStopped } from "./header-info"
import SessionComposer from "./SessionComposer"
import type { NodeSessionRow } from "./session-api"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { applyEvent, resetSessionStore, setSessionStoreApi, watchSession } from "./session-store"
import type { PendingRequest } from "./transcript"

const ID = "11111111-2222-4333-8444-555555555555"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: ID,
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    folderName: "code",
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
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

function fakeApi() {
  let n = 0
  const post = vi.fn(async (_path: string, _body?: unknown) => {
    n++
    return { commandId: `00000000-0000-4000-8000-00000000000${n}`, seq: n }
  })
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/commands?open=1")) return { commands: [] }
    if (path.includes("/nodes/me")) {
      return {
        nodes: [
          {
            id: "n1",
            name: "Mac mini",
            enabled: true,
            online: true,
            lastSeenAt: null,
            os: "darwin",
            appVersion: null,
            deviceId: "d1",
            queue: { queued: 0, running: 1 },
            models: [
              { id: "claude-haiku-4-5", label: "Haiku 4.5" },
              { id: "claude-sonnet-4-5", label: "Sonnet 4.5", efforts: ["low", "medium", "high"] },
            ],
          },
        ],
      }
    }
    return {}
  })
  return { post, get }
}

let api: ReturnType<typeof fakeApi>

beforeEach(async () => {
  resetSessionStore()
  resetSessionCommands()
  resetNodesStore()
  api = fakeApi()
  setSessionCommandsApi(() => api as never)
  setNodesStoreApi(() => api as never)
  await loadNodes()
})
afterEach(() => {
  resetSessionCommands()
  resetNodesStore()
})

function mount(
  over: Partial<NodeSessionRow> = {},
  opts: {
    pending?: PendingRequest[]
    confirm?: (level: NodeLevel) => Promise<string | null>
    hideStop?: boolean
    compact?: boolean
  } = {},
) {
  const confirmLevel = vi.fn(opts.confirm ?? (async () => null))
  render(() => (
    <ApiContext.Provider value={{} as ApiClient}>
      <SessionComposer
        session={row(over)}
        pendingRequests={opts.pending ?? []}
        nodeOnline
        confirmLevel={confirmLevel}
        hideStop={opts.hideStop}
        compact={opts.compact}
      />
    </ApiContext.Provider>
  ))
  return { confirmLevel, input: screen.getByRole("textbox") as HTMLTextAreaElement }
}

const posted = () =>
  api.post.mock.calls.map(([path, body]) => ({ path, body }) as { path: string; body: unknown })

// D27: on a desktop each setting is a toolbar pill opening a menu; on a phone
// one summary button opens a sheet of choices. These read and drive both.
const pill = (name: string) => screen.getByRole("button", { name })
const shownValue = (name: string) =>
  pill(name).querySelector("[data-value]")?.getAttribute("data-value")

async function openMenu(name: string): Promise<HTMLElement[]> {
  const trigger = pill(name)
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  await screen.findByRole("menu")
  return screen.getAllByRole("menuitem")
}

/** The option rows' names (first line), as the menu shows them. */
async function optionsOf(name: string): Promise<string[]> {
  const items = await openMenu(name)
  const names = items.map((i) => i.querySelector(".block")?.textContent ?? "")
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
  return names
}

/** Picks an option by its name: through the menu, or the phone's sheet. */
async function choose(name: string, option: string, phone = false): Promise<void> {
  if (phone) {
    fireEvent.click(screen.getByRole("button", { name: "Session settings" }))
    const group = await screen.findByRole("group", { name })
    fireEvent.click(within(group).getByRole("button", { name: option }))
    return
  }
  const items = await openMenu(name)
  const item = items.find((i) => i.querySelector(".block")?.textContent === option)
  if (!item) throw new Error(`no ${option} in ${name}`)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}

describe("P3-T15 SessionComposer", () => {
  it.each([
    ["running", "Message the session. It reads it at its next step."],
    ["waiting", "Answer the question, or tell it what to do instead."],
    ["queued", "Your message is read when the session starts."],
    ["paused", "Your message is delivered when Mac mini is back."],
    ["done", "Continue this session (it resumes where it stopped)."],
    ["stopped", "Continue this session (it resumes where it stopped)."],
    ["failed", "Continue this session (it resumes where it stopped)."],
    ["needs_you", "Continue this session (it resumes where it stopped)."],
  ] as Array<[NodeSessionStatus, string]>)("status %s shows its placeholder", (status, text) => {
    const { input } = mount({ status })
    expect(input.placeholder).toBe(text)
  })

  it("a waiting session's placeholder names what it waits for: a permission, a plan, or a question (walk D13)", () => {
    const req = (type: PendingRequest["type"], tool: string): PendingRequest => ({
      requestId: `r-${type}`,
      type,
      tool,
      seq: 3,
    })
    const permission = mount(
      { status: "waiting" },
      { pending: [req("permission_request", "Write")] },
    )
    expect(permission.input.placeholder).toBe(
      "Allow or deny the request above. A message is read once it is decided.",
    )
    cleanup()
    const plan = mount({ status: "waiting" }, { pending: [req("plan_request", "ExitPlanMode")] })
    expect(plan.input.placeholder).toBe(
      "Approve the plan above or keep planning. A message is read once you decide.",
    )
    cleanup()
    const question = mount({ status: "waiting" }, { pending: [req("question", "AskUserQuestion")] })
    expect(question.input.placeholder).toBe("Answer the question, or tell it what to do instead.")
  })

  it("Send posts a message and it appears queued; Enter sends, Shift+Enter does not", async () => {
    const { input } = mount()
    fireEvent.input(input, { target: { value: "Also list .claude" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]).toEqual({
      path: `/me/node-sessions/${ID}/commands`,
      body: { type: "message", payload: { text: "Also list .claude" } },
    })
    const bubble = await screen.findByText("Also list .claude")
    expect(bubble.closest("li")?.dataset.state).toBe("waiting")
    expect(screen.getByText("Waiting for the current step")).toBeTruthy()
    expect(screen.queryByText(/^Queued/)).toBeNull()
    expect(input.value).toBe("")
  })

  it("D22: a message to an ended session says the session is starting, never Queued", async () => {
    const { input } = mount({ status: "waiting", state: "needs_you" })
    // Served as waiting for older clients (D14), it reads as the ended session it is.
    expect(input.placeholder).toBe("Continue this session (it resumes where it stopped).")
    fireEvent.input(input, { target: { value: "Push it" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const bubble = await screen.findByText("Push it")
    expect(bubble.closest("li")?.dataset.state).toBe("starting")
    expect(screen.getByText("Starting the session…")).toBeTruthy()
    expect(screen.queryByText(/^Queued/)).toBeNull()
  })

  it("its root is a footer DockedComposer", () => {
    mount()
    expect(screen.getByTestId("session-composer").getAttribute("data-composer-dock")).toBe("footer")
  })

  it("an empty message cannot be sent", () => {
    mount()
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it("a done session's composer sends a message (continue)", async () => {
    const { input } = mount({ status: "done" })
    fireEvent.input(input, { target: { value: "What did you do?" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({ type: "message", payload: { text: "What did you do?" } }),
    )
  })

  it("Stop sends stop and shows Stopping… until the session ends", async () => {
    mount({ status: "running" })
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(posted()[0]?.body).toEqual({ type: "stop", payload: {} }))
    expect(await screen.findByRole("button", { name: "Stopping…" })).toBeTruthy()
  })

  it.each([
    ["waiting", true],
    ["paused", true],
    ["queued", true],
    ["done", false],
    ["stopped", false],
    ["failed", false],
  ] as Array<[NodeSessionStatus, boolean]>)("status %s: Stop shown %s", (status, shown) => {
    mount({ status })
    expect(!!screen.queryByRole("button", { name: "Stop" })).toBe(shown)
  })

  it("hideStop hides Stop", () => {
    mount({ status: "running" }, { hideStop: true })
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("on the phone: one settings button and Send, no Stop, each a 40 px target (P4-T11, D27)", async () => {
    mount({ status: "running" }, { hideStop: true, compact: true })
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull()
    const summary = screen.getByRole("button", { name: "Session settings" })
    expect(summary.textContent).toBe("Haiku 4.5 · Standard")
    for (const c of [summary, screen.getByRole("button", { name: "Send" })]) {
      expect(c.classList.contains("h-10")).toBe(true)
    }
    fireEvent.click(summary)
    const level = await screen.findByRole("group", { name: "Level" })
    for (const choice of within(level).getAllByRole("button")) {
      expect(choice.classList.contains("min-h-10")).toBe(true)
    }
    expect(
      within(level)
        .getAllByRole("button")
        .map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    ).toEqual([
      ["Strict", "false"],
      ["Standard", "true"],
      ["Open", "false"],
    ])
  })

  it("D27: on the desktop model, level and reasoning are pills whose menu explains the levels", async () => {
    mount({ status: "running", level: "standard" })
    expect(shownValue("Model")).toBe("claude-haiku-4-5")
    expect(pill("Level").textContent).toBe("Standard")
    await openMenu("Level")
    expect(
      screen.getByText(
        "Reads and writes anywhere outside your secrets, open network, in the sandbox.",
      ),
    ).toBeTruthy()
  })

  it("on the phone a higher level opens the confirmation and sends nothing until confirmed (P4-T11, D24)", async () => {
    let confirm: (id: string | null) => void = () => {}
    const id = "88888888-2222-4333-8444-555555555555"
    const { confirmLevel } = mount(
      { level: "strict" },
      {
        hideStop: true,
        compact: true,
        confirm: () => new Promise<string | null>((r) => (confirm = r)),
      },
    )
    await choose("Level", "Standard", true)
    await waitFor(() => expect(confirmLevel).toHaveBeenCalledWith("standard"))
    expect(api.post).not.toHaveBeenCalled()
    confirm(id)
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({
        type: "set_level",
        payload: { level: "standard", confirmationId: id },
      }),
    )
  })

  it("a model change sends set_model; the node's offered models are listed", async () => {
    mount()
    expect(await optionsOf("Model")).toEqual(["Haiku 4.5", "Sonnet 4.5"])
    await choose("Model", "Sonnet 4.5")
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({
        type: "set_model",
        payload: { model: "claude-sonnet-4-5" },
      }),
    )
  })

  it("walk D7: a model change the session refused puts the pick back and says so", async () => {
    setSessionStoreApi(() => api as never)
    await watchSession(ID).catch(() => undefined)
    mount()
    await choose("Model", "Sonnet 4.5")
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(shownValue("Model")).toBe("claude-sonnet-4-5")
    applyEvent({
      sessionId: ID,
      ownerUserId: "u1",
      seq: 1,
      at: "2026-10-13T10:00:01.000Z",
      receivedAt: "2026-10-13T10:00:01.000Z",
      type: "command_applied",
      payload: {
        commandId: "00000000-0000-4000-8000-000000000001",
        type: "set_model",
        outcome: "failed",
        error: "model_unavailable",
      },
    })
    await waitFor(() => expect(shownValue("Model")).toBe("claude-haiku-4-5"))
    expect(
      screen.getByText("Sonnet 4.5 is not available on Mac mini: the session keeps its model."),
    ).toBeTruthy()
  })

  it("lowering the level sends set_level with no dialog", async () => {
    const { confirmLevel } = mount({ level: "standard" })
    await choose("Level", "Strict")
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({ type: "set_level", payload: { level: "strict" } }),
    )
    expect(confirmLevel).not.toHaveBeenCalled()
    expect(await screen.findByText("Lowered to Strict: the session restarts now.")).toBeTruthy()
  })

  it("raising asks for the in-app confirmation: cancelled sends nothing, confirmed sends the id", async () => {
    const cancelled = mount({ level: "standard" })
    await choose("Level", "Open")
    await waitFor(() => expect(cancelled.confirmLevel).toHaveBeenCalledWith("open"))
    await waitFor(() => expect(shownValue("Level")).toBe("standard"))
    expect(api.post).not.toHaveBeenCalled()
  })

  it("a confirmed raise sends set_level with its confirmation id", async () => {
    const id = "99999999-2222-4333-8444-555555555555"
    const { confirmLevel } = mount({ level: "strict" }, { confirm: async () => id })
    await choose("Level", "Standard")
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({
        type: "set_level",
        payload: { level: "standard", confirmationId: id },
      }),
    )
    expect(confirmLevel).toHaveBeenCalledWith("standard")
  })

  it("S46: after the restart event the note is gone without a new send", async () => {
    setSessionStoreApi(() => api as never)
    await watchSession(ID).catch(() => undefined)
    const id = "99999999-2222-4333-8444-555555555555"
    mount({ level: "strict" }, { confirm: async () => id })
    await choose("Level", "Standard")
    const note = "Raised to Standard: the session restarts at the end of this step."
    expect(await screen.findByText(note)).toBeTruthy()
    applyEvent({
      sessionId: ID,
      ownerUserId: "u1",
      seq: 1,
      at: "2026-10-13T10:00:01.000Z",
      receivedAt: "2026-10-13T10:00:01.000Z",
      type: "level_changed",
      payload: { from: "strict", to: "standard" },
    })
    await waitFor(() => expect(screen.queryByText(note)).toBeNull())
  })

  it("with two open questions the answer-in-card line shows; with one it does not", () => {
    const q = (requestId: string, seq: number): PendingRequest => ({
      requestId,
      type: "question",
      tool: "AskUserQuestion",
      seq,
    })
    mount({ status: "waiting" }, { pending: [q("toolu_1", 1)] })
    expect(
      screen.queryByText("Several questions are waiting: answer them in their card."),
    ).toBeNull()
    document.body.innerHTML = ""
    mount({ status: "waiting" }, { pending: [q("toolu_1", 1), q("toolu_2", 2)] })
    expect(
      screen.getByText("Several questions are waiting: answer them in their card."),
    ).toBeTruthy()
  })

  it("a refused send says what failed", async () => {
    api.post.mockRejectedValueOnce(new Error("session not found"))
    const { input } = mount()
    fireEvent.input(input, { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Not sent: session not found",
    )
  })
})

describe("P1-T15 reasoning level (S23-S25)", () => {
  it("S25: the reasoning menu lists Default plus the model's efforts; a model without efforts hides it", async () => {
    mount({ model: "claude-sonnet-4-5", effort: null })
    expect(await optionsOf("Reasoning")).toEqual(["Default", "Low", "Medium", "High"])
    expect(shownValue("Reasoning")).toBe("")
    cleanup()
    mount({ model: "claude-haiku-4-5", effort: null })
    expect(screen.queryByRole("button", { name: "Reasoning" })).toBeNull()
  })

  it("S25: a row from an API that predates effort hides the select (feature detection)", () => {
    mount({ model: "claude-sonnet-4-5" })
    expect(screen.queryByRole("button", { name: "Reasoning" })).toBeNull()
  })

  it("S25: an effort the model does not offer shows Default", () => {
    mount({ model: "claude-sonnet-4-5", effort: "max" })
    expect(shownValue("Reasoning")).toBe("")
  })

  it("S24: choosing high sends set_effort high; Default sends null", async () => {
    mount({ model: "claude-sonnet-4-5", effort: "low" })
    expect(shownValue("Reasoning")).toBe("low")
    await choose("Reasoning", "High")
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({ type: "set_effort", payload: { effort: "high" } }),
    )
    await choose("Reasoning", "Default")
    await waitFor(() =>
      expect(posted()[1]?.body).toEqual({ type: "set_effort", payload: { effort: null } }),
    )
  })

  it("S24: a row-only change says it applies from the next run", async () => {
    api.post.mockResolvedValueOnce({
      commandId: "00000000-0000-4000-8000-000000000009",
      seq: 9,
      applied: "row_only",
    } as never)
    mount({ model: "claude-sonnet-4-5", effort: null })
    await choose("Reasoning", "Medium")
    expect(await screen.findByText("Applies from the next run.")).toBeTruthy()
  })

  it("S24: an outdated computer says to update Liaison and the pick goes back", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(
        "The computer running this session needs a Liaison update.",
        409,
        "node_outdated",
      ),
    )
    mount({ model: "claude-sonnet-4-5", effort: "low" })
    await choose("Reasoning", "High")
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Update Liaison on this computer to change this mid-run.",
    )
    expect(shownValue("Reasoning")).toBe("low")
  })

  it("S25: on the phone the reasoning choices sit in the settings sheet", async () => {
    mount({ model: "claude-sonnet-4-5", effort: null }, { compact: true })
    await choose("Reasoning", "High", true)
    await waitFor(() =>
      expect(posted()[0]?.body).toEqual({ type: "set_effort", payload: { effort: "high" } }),
    )
  })

  // S26 (charter "Mobile composer", D27). jsdom applies no stylesheet, so the
  // rules the assertions depend on are injected and read back through
  // getComputedStyle, the size a real browser computes from the same classes.
  function fieldRules(): () => void {
    const style = document.createElement("style")
    style.textContent =
      ".text-\\[16px\\]\\! { font-size: 16px !important; }\n" +
      ".text-\\[15px\\]\\! { font-size: 15px !important; }\n" +
      ".max-h-\\[144px\\] { max-height: 144px; }\n" +
      ".max-h-\\[176px\\] { max-height: 176px; }\n" +
      ".overflow-y-auto { overflow-y: auto; }"
    document.head.appendChild(style)
    return () => style.remove()
  }

  it("S26: at phone tier the field font is 16 px and the send button is inside the field", () => {
    const done = fieldRules()
    const { input } = mount({ status: "running" }, { hideStop: true, compact: true })
    // iOS WKWebView zooms the page on focusing a field computed under 16 px.
    expect(getComputedStyle(input).fontSize).toBe("16px")
    // One rounded field holds the text and Send; the settings share its
    // bottom line, never a line of their own under the keyboard.
    const field = screen.getByTestId("session-composer-field")
    expect(field.contains(input)).toBe(true)
    const send = screen.getByRole("button", { name: "Send" })
    const row = screen.getByTestId("session-composer-controls")
    expect(field.contains(row)).toBe(true)
    expect(row.contains(send)).toBe(true)
    expect(row.contains(screen.getByRole("button", { name: "Session settings" }))).toBe(true)
    expect(row.classList.contains("flex-nowrap")).toBe(true)
    expect(row.classList.contains("flex-wrap")).toBe(false)
    done()
  })

  it.each([
    ["phone", true, 24, 6],
    ["desktop", false, 22, 8],
  ] as const)(
    "S26: on the %s the field grows to its cap then scrolls",
    (_tier, compact, line, cap) => {
      const done = fieldRules()
      const { input } = mount({ status: "running" }, { hideStop: true, compact })
      // jsdom lays nothing out: scrollHeight is what a real browser measures.
      let content = line * 3
      Object.defineProperty(input, "scrollHeight", { get: () => content, configurable: true })
      fireEvent.input(input, { target: { value: "one\ntwo\nthree" } })
      expect(input.style.height).toBe(`${line * 3}px`)
      content = line * (cap + 3)
      fireEvent.input(input, { target: { value: "a\n".repeat(cap + 3) } })
      expect(input.style.height).toBe(`${line * cap}px`)
      expect(getComputedStyle(input).maxHeight).toBe(`${line * cap}px`)
      expect(getComputedStyle(input).overflowY).toBe("auto")
      done()
    },
  )
})

describe("P1-T23 one driver at a time (S51, D28)", () => {
  const NEEDS_YOU = { status: "waiting", state: "needs_you" } as Partial<NodeSessionRow>
  let seqN = 0
  const event = (type: string, payload: Record<string, unknown>) => {
    seqN++
    applyEvent({
      sessionId: ID,
      ownerUserId: "u1",
      seq: seqN,
      at: new Date(1_800_000_000_000 + seqN).toISOString(),
      receivedAt: new Date(1_800_000_000_000 + seqN).toISOString(),
      type,
      payload,
    } as never)
  }
  const driven = (via: string) =>
    event("system", {
      subtype: "driver",
      text: "Driven from VS Code",
      data: { elsewhere: true, via },
    })

  beforeEach(async () => {
    seqN = 0
    setSessionStoreApi(() => api as never)
    await watchSession(ID).catch(() => undefined)
  })

  it("S51: the composer asks for a second click while driven elsewhere and sends confirmDrivenElsewhere on it", async () => {
    driven("vscode")
    const { input } = mount(NEEDS_YOU)
    fireEvent.input(input, { target: { value: "Carry on" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(
      await screen.findByText(
        "VS Code is driving this session. Sending resumes it here as well. Send again to confirm.",
      ),
    ).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    expect(input.value).toBe("Carry on")
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({
      type: "message",
      payload: { text: "Carry on", confirmDrivenElsewhere: true },
    })
  })

  it("S51: a driven_elsewhere settle re-arms the warning: the text comes back and the next send is confirmed", async () => {
    const { input } = mount(NEEDS_YOU)
    fireEvent.input(input, { target: { value: "Push it" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({ type: "message", payload: { text: "Push it" } })
    // fakeApi numbers its commands: the first post is ...001.
    const commandId = "00000000-0000-4000-8000-000000000001"
    driven("cli")
    event("command_applied", {
      commandId,
      type: "message",
      outcome: "failed",
      error: "driven_elsewhere",
    })
    expect(
      await screen.findByText(
        "A terminal is driving this session. Send again to resume it here as well.",
      ),
    ).toBeTruthy()
    expect(input.value).toBe("Push it")
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(posted()[1]?.body).toEqual({
      type: "message",
      payload: { text: "Push it", confirmDrivenElsewhere: true },
    })
  })

  it("S51, D31c: a refusal of a message this composer did not send (the agent, another device) still asks on the first click", async () => {
    driven("vscode")
    // The agent's computer_session_send, refused on the computer.
    event("command_applied", {
      commandId: "00000000-0000-4000-8000-00000000a9e7",
      type: "message",
      outcome: "failed",
      error: "driven_elsewhere",
    })
    const { input } = mount(NEEDS_YOU)
    fireEvent.input(input, { target: { value: "Go" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(
      await screen.findByText(
        "VS Code is driving this session. Sending resumes it here as well. Send again to confirm.",
      ),
    ).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({
      type: "message",
      payload: { text: "Go", confirmDrivenElsewhere: true },
    })
  })

  it("D33 (batch-4 F3): once the owner stopped the orphan holding the session, the message it refused resumes the session", async () => {
    const { input } = mount(NEEDS_YOU)
    fireEvent.input(input, { target: { value: "Push it" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    event("system", {
      subtype: "driver",
      text: "An orphaned Claude process (pid 5093) holds this session",
      data: { elsewhere: true, via: null, orphanPid: 5093, cliSessionId: "41173e76-dc0a" },
    })
    event("command_applied", {
      commandId: "00000000-0000-4000-8000-000000000001",
      type: "message",
      outcome: "failed",
      error: "driven_elsewhere",
    })
    await waitFor(() => expect(input.value).toBe("Push it"))
    markOrphanStopped(ID, 5093)
    // Sent again by itself, plain: the node checks the driver again.
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(posted()[1]?.body).toEqual({ type: "message", payload: { text: "Push it" } })
  })

  it("S51: the next run's start clears the warning and a send goes plain again", async () => {
    driven("vscode")
    const { input } = mount(NEEDS_YOU)
    fireEvent.input(input, { target: { value: "One" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const warning =
      "VS Code is driving this session. Sending resumes it here as well. Send again to confirm."
    expect(await screen.findByText(warning)).toBeTruthy()
    event("system", { subtype: "start", text: "started", data: {} })
    await waitFor(() => expect(screen.queryByText(warning)).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({ type: "message", payload: { text: "One" } })
  })
})

describe("P3-T14 imports in the composer (S41, A44, A54)", () => {
  const IMPORT = {
    source: "import",
    importMode: "follow",
    importFrom: "vscode",
    following: true,
    cwdSubdir: "",
  } as Partial<NodeSessionRow>

  it("S41: a following follow-mode import shows no composer, only the read-only line", () => {
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <SessionComposer
          session={row(IMPORT)}
          pendingRequests={[]}
          nodeOnline
          confirmLevel={async () => null}
        />
      </ApiContext.Provider>
    ))
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    expect(screen.getByTestId("session-follow-readonly").textContent).toBe(
      "Liaison follows this session read only. Take it over to send it messages.",
    )
  })

  it("A44: after take_over the composer appears", async () => {
    const [session, setSession] = createSignal(row(IMPORT))
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <SessionComposer
          session={session()}
          pendingRequests={[]}
          nodeOnline
          confirmLevel={async () => null}
        />
      </ApiContext.Provider>
    ))
    expect(screen.queryByRole("textbox")).toBeNull()
    setSession(
      row({
        ...IMPORT,
        importMode: "take_over",
        following: false,
        status: "waiting",
        state: "needs_you",
        reasonCode: "imported",
      }),
    )
    const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Continue the refactor" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({
      type: "message",
      payload: { text: "Continue the refactor" },
    })
  })

  it("A54: during a take_over replay the composer is shown and a sent message shows as pending until the import finishes", async () => {
    const { input } = mount({ ...IMPORT, importMode: "take_over", following: true })
    fireEvent.input(input, { target: { value: "Then run the tests" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("Sent when the import finishes")).toBeTruthy()
    expect(screen.getByText("Then run the tests")).toBeTruthy()
  })

  it("A54: an auto-followed in-place session asks the second click and sends confirmDrivenElsewhere", async () => {
    const { input } = mount({ source: "app", following: true, importMode: null })
    fireEvent.input(input, { target: { value: "Carry on" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByTestId("session-driven-note")).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(posted()[0]?.body).toEqual({
      type: "message",
      payload: { text: "Carry on", confirmDrivenElsewhere: true },
    })
  })

  it("A54: a 409 driven_elsewhere_confirm keeps the text and asks the second click", async () => {
    api.post.mockRejectedValueOnce(new ApiError("Confirm first", 409, "driven_elsewhere_confirm"))
    const { input } = mount({ status: "waiting", state: "needs_you" })
    fireEvent.input(input, { target: { value: "Go on" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByTestId("session-driven-note")).toBeTruthy()
    expect(input.value).toBe("Go on")
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(posted()[1]?.body).toEqual({
      type: "message",
      payload: { text: "Go on", confirmDrivenElsewhere: true },
    })
  })
})

describe("SessionComposer dictation", () => {
  it("the mic sits immediately left of Send; the wand stays with the settings", async () => {
    installMic()
    installAudioContext()
    try {
      const client = {
        get: vi.fn(async () => ({ dictation: true, autoClean: true })),
      } as unknown as ApiClient
      render(() => (
        <ApiContext.Provider value={client}>
          <SessionComposer
            session={row()}
            pendingRequests={[]}
            nodeOnline
            confirmLevel={vi.fn(async () => null)}
          />
        </ApiContext.Provider>
      ))
      const mic = await screen.findByTestId("voice-dictation-button")
      const controls = screen.getByTestId("session-composer-controls")
      const buttons = [...controls.querySelectorAll("button")]
      // Send is the line's last button, and the mic is right before it.
      expect(mic.nextElementSibling).toBe(buttons[buttons.length - 1])
      expect(screen.getByTestId("magic-wand").nextElementSibling).not.toBe(mic)
    } finally {
      removeMic()
    }
  })
})
