// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T08 (S8 transcript, charter): the transcript renders every item kind in
// seq order, read-only; request cards show their buttons only once P3
// registers the actions (P2-D1); no spinner on an ended session; never a JSON
// dump nor an absolute local path; each row carries S5's data attributes.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"

// P4-T11: the phone tier is forced per test; every other test is the desktop.
const tier = vi.hoisted(() => ({ current: "desktop" as "phone" | "tablet" | "desktop" }))
vi.mock("~/modules/shell/shell-tier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/shell-tier")>()),
  shellTier: () => tier.current,
}))

import SessionTranscript from "./SessionTranscript"
import { registerSessionActions, resetSessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import * as commands from "./session-commands"
import { resetSessionStore, setSessionStoreApi } from "./session-store"

const T0 = Date.parse("2026-10-13T10:00:00.000Z")
const SID = "3f2a9c1e-0000-4000-8000-000000000001"
let seq = 0

type Held = NodeSessionEvent & { clientReceivedAt: number }

function ev(
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  over: Partial<NodeSessionEvent> = {},
): Held {
  seq++
  return {
    seq,
    at: new Date(T0 + seq * 1000).toISOString(),
    receivedAt: new Date(T0 + seq * 1000 + 30).toISOString(),
    type,
    payload,
    clientReceivedAt: T0 + seq * 1000 + 70,
    ...over,
  }
}

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: SID,
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Add a line to the README",
    folderName: "liaison-walk-sample",
    repo: null,
    branch: "node/readme",
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: "2.1.7 installed /opt/homebrew/bin/claude",
    lastSeq: 0,
    latestActivity: null,
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

const WT = "/Users/sam/Liaison Node/worktrees/liaison-walk-sample-3f2a9c1e0000"

/** One of every event type, as a walk session produces them. */
function everyType(): Held[] {
  seq = 0
  return [
    ev("system", {
      subtype: "start",
      text: "Claude Code 2.1.7 started",
      data: { cwd: WT, mcpServers: { liaison: { status: "ok" } } },
    }),
    ev("user_message", { text: "Add one line to README.md" }),
    ev("thinking", { text: "Let me look." }),
    ev("assistant_text", { text: `I will edit ${WT}/README.md now.` }),
    ev("todo", {
      items: [{ content: "Edit README", status: "in_progress" }],
      from: "TodoWrite",
    }),
    ev("tool_call", {
      id: "toolu_task",
      name: "Task",
      input: { description: "List the files", subagent_type: "Explore", model: "haiku" },
    }),
    ev(
      "tool_call",
      { id: "toolu_ls", name: "Bash", input: { command: `ls ${WT}` } },
      { parentToolUseId: "toolu_task" },
    ),
    ev(
      "tool_result",
      { id: "toolu_ls", isError: false, output: "README.md\nsrc" },
      { parentToolUseId: "toolu_task" },
    ),
    ev("tool_result", { id: "toolu_task", isError: false, output: "2 files" }),
    ev("tool_call", {
      id: "toolu_edit",
      name: "Edit",
      input: {
        file_path: `${WT}/README.md`,
        old_string: "# Sample",
        new_string: "# Sample\nOne line",
      },
    }),
    ev("tool_result", { id: "toolu_edit", isError: false, output: "ok" }),
    ev("tool_call", { id: "toolu_wc", name: "Bash", input: { command: "wc -l README.md" } }),
    ev("tool_result", { id: "toolu_wc", isError: false, output: "2 README.md" }),
    ev("tool_call", { id: "toolu_bad", name: "Read", input: { file_path: `${WT}/missing.md` } }),
    ev("tool_result", { id: "toolu_bad", isError: true, output: "File does not exist." }),
    ev("permission_request", {
      requestId: "r1",
      tool: "Write",
      input: { file_path: "/Users/sam/elsewhere/x.txt" },
      reason: "Outside the session folder.",
    }),
    ev("question", {
      requestId: "r2",
      questions: [
        {
          question: "Which rule?",
          header: "Rule",
          multiSelect: false,
          options: [
            { label: "Same team", description: "Matches routing." },
            { label: "Anyone", description: "Widest." },
          ],
        },
      ],
    }),
    ev("plan_request", { requestId: "r3", plan: "1. Edit\n2. Test" }),
    ev("decision", { requestId: "r3", outcome: "allow", by: "owner" }),
    ev("command_applied", { commandId: "c1", type: "message", outcome: "applied" }),
    ev("status", { status: "waiting" }),
    ev("usage", { tokensIn: 10, tokensOut: 5, model: "claude-haiku-4-5" }),
    ev("model_changed", { from: "claude-haiku-4-5", to: "claude-sonnet-4-5" }),
    ev("level_changed", { from: "strict", to: "standard" }),
    ev("resumed", { after: "offline" }),
    ev("result", {
      text: "Added one line.",
      isError: false,
      subtype: "success",
      branch: "node/readme",
      pushed: true,
    }),
  ]
}

// P3-fix m4: a card asks the command client whether its decision is on its way.
const inFlight = vi.hoisted(() => ({ requests: new Set<string>() }))
vi.mock("./session-commands", async (importOriginal) => {
  const real = await importOriginal<typeof import("./session-commands")>()
  return {
    ...real,
    isRequestPending: (sessionId: string, requestId: string) =>
      inFlight.requests.has(requestId) || real.isRequestPending(sessionId, requestId),
  }
})

/** The card's decision in flight has settled. */
const settled = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  resetSessionActions()
  inFlight.requests.clear()
})

function renderT(
  events: Held[],
  session = row(),
  extra: { focusRequestId?: string; onOpenSubagent?: (toolUseId: string) => void } = {},
) {
  return render(() => (
    <SessionTranscript
      session={session}
      events={events}
      focusRequestId={extra.focusRequestId}
      onOpenSubagent={extra.onOpenSubagent}
    />
  ))
}

describe("SessionTranscript", () => {
  it("renders every item kind from a fixture of each event type, in seq order", () => {
    renderT(everyType())
    const rows = screen.getAllByTestId("session-event")
    const seqs = rows.map((r) => Number(r.dataset.seq))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const kinds = rows.map((r) => r.dataset.kind)
    for (const k of ["dim", "user", "thinking", "text", "subagent", "tool", "request", "result"]) {
      expect(kinds).toContain(k)
    }
    expect(screen.getByText("Add one line to README.md")).toBeTruthy()
    expect(screen.getByText("Thinking")).toBeTruthy()
  })

  it("Edit rows are open, Bash rows closed", () => {
    renderT(everyType())
    const edit = screen.getAllByTestId("tool-row").find((r) => r.dataset.tool === "Edit")
    const bash = screen.getAllByTestId("tool-row").find((r) => r.dataset.tool === "Bash")
    expect(edit?.dataset.open).toBe("true")
    expect(edit?.textContent).toContain("One line")
    expect(bash?.dataset.open).toBe("false")
  })

  it("S54: a subagent is one inline reference \u201cAgent: \u2026 Open \u203a\u201d that opens its drawer; its own tools are not rendered", () => {
    const opened: string[] = []
    renderT(everyType(), row(), { onOpenSubagent: (id: string) => opened.push(id) })
    const sub = screen.getByTestId("subagent-ref")
    expect(sub.textContent).toContain("Explore")
    expect(sub.textContent).toContain("List the files")
    expect(sub.textContent).toContain("Open")
    const bash = screen.getAllByTestId("tool-row").filter((r) => r.dataset.tool === "Bash")
    expect(bash.map((r) => r.textContent?.includes("wc -l"))).toEqual([true])
    fireEvent.click(sub)
    expect(opened).toEqual(["toolu_task"])
  })

  it("D56 F3: a browser test card says the repository's code runs with full rights and lists the changed files, in English and French; without the list the node's reason shows", () => {
    seq = 0
    const card = (browserTest?: unknown) => [
      ev("permission_request", {
        requestId: "r1",
        tool: "Bash",
        input: { command: "npx playwright test" },
        reason: "The node's English reason.",
        ...(browserTest === undefined ? {} : { browserTest }),
      }),
    ]
    const listed = card({ files: ["package.json", "tests/home.spec.ts"], more: 2 })
    const en = renderT(listed)
    let note = screen.getByTestId("browser-test-note")
    expect(note.textContent).toContain(
      "the repository's own code it loads (its Playwright config, the tests, package scripts) runs with your full rights",
    )
    expect(note.textContent).toContain("Files of that kind changed in this folder:")
    expect([...note.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "package.json",
      "tests/home.spec.ts",
    ])
    expect(note.textContent).toContain("and 2 more")
    expect(screen.getByTestId("request-card").textContent).not.toContain(
      "The node's English reason.",
    )
    en.unmount()
    const none = renderT(card({ files: [], more: 0 }))
    note = screen.getByTestId("browser-test-note")
    expect(note.textContent).toContain("No such file changed in this folder.")
    expect(note.querySelectorAll("li")).toHaveLength(0)
    none.unmount()
    const fr = render(() => (
      <I18nProvider initialLocale="fr">
        <SessionTranscript session={row()} events={listed} />
      </I18nProvider>
    ))
    note = screen.getByTestId("browser-test-note")
    expect(note.textContent).toContain("s'exécute avec tous vos droits")
    expect(note.textContent).toContain("Fichiers de ce type modifiés dans ce dossier :")
    expect(note.textContent).toContain("et 2 de plus")
    fr.unmount()
    renderT(card())
    expect(screen.queryByTestId("browser-test-note")).toBeNull()
    expect(screen.getByTestId("request-card").textContent).toContain("The node's English reason.")
  })

  it("a pending permission card shows no buttons without actions, and Allow once calls decidePermission(…, true, 'once') once registered", async () => {
    seq = 0
    const events = [
      ev("permission_request", {
        requestId: "r1",
        tool: "Bash",
        input: { command: "git push" },
        reason: "Pushing is outside Strict.",
      }),
    ]
    const { unmount } = renderT(events)
    const card = screen.getByTestId("request-card")
    expect(card.textContent).toContain("Waiting for your answer.")
    expect(card.querySelectorAll("button")).toHaveLength(0)
    unmount()

    const decidePermission = vi.fn(async () => {})
    registerSessionActions({ decidePermission })
    renderT(events)
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(decidePermission).toHaveBeenCalledWith(SID, "r1", true, "once")
    // One decision at a time: the next once the first settled (P3-fix m4).
    await settled()
    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }))
    expect(decidePermission).toHaveBeenLastCalledWith(SID, "r1", true, "session")
    await settled()
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(decidePermission).toHaveBeenLastCalledWith(SID, "r1", false, "once")
  })

  it("a question with options calls answerQuestion with the chosen label", () => {
    seq = 0
    const answerQuestion = vi.fn(async () => {})
    registerSessionActions({ answerQuestion })
    renderT([
      ev("question", {
        requestId: "r2",
        questions: [
          {
            question: "Which rule?",
            multiSelect: false,
            options: [{ label: "Same team", description: "Matches routing." }, { label: "Anyone" }],
          },
        ],
      }),
    ])
    expect(screen.getByText("Matches routing.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Same team/ }))
    expect(answerQuestion).toHaveBeenCalledWith(SID, "r2", { "Which rule?": "Same team" })
  })

  it("a plan card approves or keeps planning once registered", async () => {
    seq = 0
    const decidePlan = vi.fn(async () => {})
    registerSessionActions({ decidePlan })
    renderT([ev("plan_request", { requestId: "r3", plan: "1. Edit" })])
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }))
    expect(decidePlan).toHaveBeenCalledWith(SID, "r3", false)
    await settled()
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(decidePlan).toHaveBeenLastCalledWith(SID, "r3", true)
  })

  it("on the phone each card action has the 44 px minimum and its row wraps (P4-T11)", () => {
    seq = 0
    tier.current = "phone"
    try {
      registerSessionActions({
        decidePermission: vi.fn(async () => {}),
        answerQuestion: vi.fn(async () => {}),
        decidePlan: vi.fn(async () => {}),
      })
      renderT([
        ev("permission_request", { requestId: "p1", tool: "Bash", input: { command: "ls" } }),
        ev("question", {
          requestId: "q1",
          questions: [
            { question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
            { question: "And?", multiSelect: true, options: [{ label: "C" }] },
          ],
        }),
        ev("plan_request", { requestId: "l1", plan: "1. Edit" }),
      ])
      const buttons = screen
        .getAllByTestId("request-card")
        .flatMap((card) => [...card.querySelectorAll("button")])
      // Allow once, Allow for this session, Deny; A, B, C, Done; Approve, Keep planning.
      expect(buttons).toHaveLength(9)
      for (const b of buttons) {
        expect(b.classList.contains("min-h-11")).toBe(true)
        expect(b.classList.contains("min-w-11")).toBe(true)
        // A row of several actions wraps (or stacks) inside a 390 px screen.
        const rowEl = b.parentElement as HTMLElement
        if (rowEl.childElementCount > 1) {
          expect(
            rowEl.classList.contains("flex-wrap") || rowEl.classList.contains("flex-col"),
          ).toBe(true)
        }
      }
    } finally {
      tier.current = "desktop"
    }
  })

  it("F6: on the phone a Thinking toggle is a 44 px target; the desktop stays compact", () => {
    seq = 0
    tier.current = "phone"
    try {
      const { unmount } = renderT([ev("thinking", { text: "Let me look." })])
      expect(screen.getByTestId("thinking-toggle").classList.contains("min-h-11")).toBe(true)
      unmount()
    } finally {
      tier.current = "desktop"
    }
    renderT([ev("thinking", { text: "Let me look." })])
    expect(screen.getByTestId("thinking-toggle").classList.contains("min-h-11")).toBe(false)
  })

  it("F5b: the node's automatic continue after an offline resume is a system line, not the owner's bubble", () => {
    seq = 0
    renderT([
      ev("resumed", { after: "offline" }),
      ev("user_message", {
        text: "The session was interrupted (the computer was offline). Continue where you left off.",
        synthetic: true,
      }),
    ])
    const kinds = screen.getAllByTestId("session-event").map((e) => e.getAttribute("data-kind"))
    expect(kinds).toEqual(["dim", "dim"])
    expect(screen.getByText("Continued automatically after the interruption")).toBeTruthy()
    expect(screen.queryByText(/Continue where you left off/)).toBeNull()
  })

  it("no spinner on a done session", () => {
    seq = 0
    const events = [ev("tool_call", { id: "toolu_1", name: "Bash", input: { command: "sleep 5" } })]
    const { unmount } = renderT(events, row({ status: "running" }))
    expect(document.querySelectorAll('[data-spinner="true"]').length).toBeGreaterThan(0)
    unmount()
    renderT(events, row({ status: "done", endedAt: "2026-10-13T10:05:00.000Z" }))
    expect(document.querySelectorAll('[data-spinner="true"]')).toHaveLength(0)
    expect(screen.getByText("No result")).toBeTruthy()
  })

  it("no text and no title attribute starts with / or contains /Users/", () => {
    renderT(everyType())
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("/Users/")
    for (const el of document.querySelectorAll("[title]")) {
      const title = el.getAttribute("title") ?? ""
      expect(title.startsWith("/")).toBe(false)
      expect(title).not.toContain("/Users/")
    }
    for (const el of document.querySelectorAll("*")) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3)
          expect((node.textContent ?? "").trimStart().startsWith("/")).toBe(false)
      }
    }
  })

  it('no {" anywhere in the DOM', () => {
    renderT(everyType())
    expect(document.body.innerHTML).not.toContain("{&quot;")
    expect(document.body.textContent).not.toContain('{"')
  })

  it("2,001 items render 2,000 and the earlier button", () => {
    seq = 0
    const events = Array.from({ length: 2001 }, (_, i) =>
      ev("assistant_text", { text: `step ${i}` }),
    )
    renderT(events)
    expect(screen.getAllByTestId("session-event")).toHaveLength(2000)
    const more = screen.getByRole("button", { name: "Show 1 earlier step" })
    fireEvent.click(more)
    expect(screen.getAllByTestId("session-event")).toHaveLength(2001)
  })

  it("S56: trimming the held window keeps an expanded row's open state on that row, not on its position", () => {
    seq = 0
    const bash = (n: number) => [
      ev("tool_call", { id: `toolu_${n}`, name: "Bash", input: { command: `echo ${n}` } }),
      ev("tool_result", { id: `toolu_${n}`, isError: false, output: `${n}` }),
    ]
    // The store's window: one array, trimmed and appended in place.
    const events: Held[] = [...bash(1), ...bash(2), ...bash(3)]
    const [list, setList] = createSignal(events, { equals: false })
    render(() => <SessionTranscript session={row()} events={list()} />)
    const toolRow = (n: number) =>
      screen.getAllByTestId("tool-row").find((r) => r.textContent?.includes(`echo ${n}`))
    const toggle = toolRow(2)?.querySelector("button[aria-expanded]") as HTMLElement
    fireEvent.click(toggle)
    expect(toolRow(2)?.dataset.open).toBe("true")
    // The oldest call leaves the window (trim) and a new one arrives.
    events.splice(0, 2)
    events.push(...bash(4))
    setList(events)
    expect(toolRow(1)).toBeUndefined()
    expect(toolRow(2)?.dataset.open).toBe("true")
    expect(toolRow(3)?.dataset.open).toBe("false")
    expect(toolRow(4)?.dataset.open).toBe("false")
  })

  it("S56: an Edit row whose input was elided starts closed and reads nothing; opening it reads the input by seq", async () => {
    seq = 0
    const full = {
      file_path: `${WT}/README.md`,
      old_string: "old words",
      new_string: "brand new words",
    }
    const call = ev("tool_call", {
      id: "toolu_e",
      name: "Edit",
      input: { file_path: full.file_path, old_string: "", new_string: "" },
      inputElided: { chars: 9_000 },
    })
    const result = ev("tool_result", { id: "toolu_e", isError: false, output: "ok" })
    const get = vi.fn(async (_path: string) => ({
      events: [{ ...call, payload: { id: "toolu_e", name: "Edit", input: full } }],
      lastSeq: 2,
    }))
    setSessionStoreApi(() => ({ get }) as never)
    renderT([call, result])
    const edit = screen.getAllByTestId("tool-row").find((r) => r.dataset.tool === "Edit")
    expect(edit?.dataset.open).toBe("false")
    await settled()
    expect(get).not.toHaveBeenCalled()
    fireEvent.click(edit?.querySelector("button[aria-expanded]") as HTMLElement)
    await vi.waitFor(() => expect(edit?.textContent).toContain("brand new words"))
    expect(get).toHaveBeenCalledWith(`/me/node-sessions/${SID}/events?after=0&limit=1&scope=top`)
    resetSessionStore()
  })

  it("focusRequestId highlights that card", () => {
    seq = 0
    renderT(
      [
        ev("permission_request", { requestId: "r1", tool: "Bash", input: {}, reason: "" }),
        ev("plan_request", { requestId: "r9", plan: "p" }),
      ],
      row(),
      { focusRequestId: "r9" },
    )
    const cards = screen.getAllByTestId("request-card")
    const focused = cards.find((c) => c.dataset.requestId === "r9")
    expect(focused?.dataset.focused).toBe("true")
    expect(cards.find((c) => c.dataset.requestId === "r1")?.dataset.focused).toBe("false")
  })

  it("each row carries data-at and data-received-at", () => {
    renderT(everyType())
    for (const r of screen.getAllByTestId("session-event")) {
      expect(Number(r.dataset.at)).toBeGreaterThan(T0)
      expect(Number(r.dataset.receivedAt)).toBeGreaterThan(Number(r.dataset.at))
    }
  })

  it("a running session shows the Working line with the latest activity", () => {
    seq = 0
    renderT([ev("tool_call", { id: "toolu_1", name: "Bash", input: { command: "npm test" } })])
    expect(screen.getByTestId("working-line").textContent).toContain("Bash · npm test")
  })

  // ── P3-fix m4: the cards while a decision is on its way ──

  const askPermission = () => [
    ev("permission_request", {
      requestId: "r1",
      tool: "Bash",
      input: { command: "git push" },
      reason: "Pushing is outside Strict.",
    }),
  ]

  it("a decision on its way disables the card's buttons (m4)", () => {
    seq = 0
    registerSessionActions({ decidePermission: vi.fn(async () => {}) })
    inFlight.requests.add("r1")
    renderT(askPermission())
    for (const name of ["Allow once", "Allow for this session", "Deny"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(commands.isRequestPending(SID, "r1")).toBe(true)
  })

  it("a refused decision shows its error in the card and rejects nothing unhandled (m4)", async () => {
    seq = 0
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    try {
      let reject: (e: Error) => void = () => {}
      const decidePermission = vi.fn(
        () =>
          new Promise<void>((_, rej) => {
            reject = rej
          }),
      )
      registerSessionActions({ decidePermission })
      renderT(askPermission())
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
      // In flight: no second decision.
      expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(
        true,
      )
      reject(new Error("the computer is offline"))
      await vi.waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("the computer is offline"),
      )
      expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(
        false,
      )
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  })

  it("a pending card says it waits with no time limit (m4)", () => {
    seq = 0
    registerSessionActions({ decidePermission: vi.fn(async () => {}) })
    renderT(askPermission())
    expect(screen.getByTestId("request-card").textContent).toContain(
      "The session waits for you. No time limit.",
    )
  })

  it("a question takes an Other free-text answer (m4)", () => {
    seq = 0
    const answerQuestion = vi.fn(async () => {})
    registerSessionActions({ answerQuestion })
    renderT([
      ev("question", {
        requestId: "r2",
        questions: [
          {
            question: "Which rule?",
            multiSelect: false,
            options: [{ label: "Same team" }, { label: "Anyone" }],
          },
        ],
      }),
    ])
    fireEvent.input(screen.getByPlaceholderText("Your answer"), {
      target: { value: "Only the owner" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Answer" }))
    expect(answerQuestion).toHaveBeenCalledWith(SID, "r2", { "Which rule?": "Only the owner" })
  })
})

describe("fallback names are translated (m9)", () => {
  it("a tool call with no name and a subagent with no type read Outil and Sous-agent in French", () => {
    seq = 0
    const events: Held[] = [
      ev("tool_call", { id: "t-anon", input: { x: "y" } }),
      ev("tool_result", { id: "t-anon", isError: false, output: "ok" }),
      ev("tool_call", { id: "t-task", name: "Task", input: { description: "Look around" } }),
      ev("assistant_text", { text: "inside" }, { parentToolUseId: "t-task" }),
    ]
    render(() => (
      <I18nProvider initialLocale="fr">
        <SessionTranscript session={row({ status: "done" })} events={events} />
      </I18nProvider>
    ))
    const tool = screen.getAllByTestId("tool-row")[0]
    expect(tool.textContent).toContain("Outil")
    expect(tool.textContent).not.toMatch(/\bTool\b/)
    const card = screen.getByTestId("subagent-ref")
    expect(card.textContent).toContain("Sous-agent")
    expect(card.textContent).not.toContain("Subagent")
  })

  it("one result card per run end, each with its own run's elapsed time (walk D15)", () => {
    seq = 0
    const at = (sec: number) => ({ at: new Date(T0 + sec * 1000).toISOString() })
    const events = [
      ev("status", { status: "running" }, at(0)),
      ev("user_message", { text: "Summarise the README" }, at(1)),
      ev("assistant_text", { text: "First answer." }, at(30)),
      ev("result", { text: "First answer.", isError: false, subtype: "success" }, at(36)),
      // A subagent's notification starts another turn in the same run.
      ev("assistant_text", { text: "The subagent finished too." }, at(45)),
      ev(
        "result",
        { text: "The subagent finished too.", isError: false, subtype: "success" },
        at(50),
      ),
      ev("status", { status: "done" }, at(50)),
      ev("status", { status: "queued", reason: "resume_message" }, at(90)),
      ev("status", { status: "running" }, at(100)),
      ev("user_message", { text: "And the licence?" }, at(101)),
      ev("result", { text: "MIT.", isError: false, subtype: "success" }, at(110)),
      ev("status", { status: "done" }, at(110)),
    ]
    renderT(events, row({ status: "done", endedAt: new Date(T0 + 110_000).toISOString() }))
    const cards = screen.getAllByTestId("result-card")
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain("The subagent finished too.")
    expect(cards[0].textContent).toMatch(/50\u00a0?\s?s/)
    expect(cards[1].textContent).toContain("MIT.")
    expect(cards[1].textContent).toMatch(/10\u00a0?\s?s/)
    expect(cards[1].textContent).not.toMatch(/1\s?min/)
  })
})

describe("SessionTranscript: the result card says how its run ended (W1-D10)", () => {
  it("W1-D10: a run that ended Needs you shows a Needs you card, never a green Done; an earlier run's card keeps its own end", () => {
    seq = 0
    const at = (sec: number) => ({ at: new Date(T0 + sec * 1000).toISOString() })
    const events = [
      ev("status", { status: "running" }, at(0)),
      ev("user_message", { text: "Summarise the README" }, at(1)),
      ev("result", { text: "Summary.", isError: false, subtype: "success" }, at(20)),
      ev("status", { status: "done" }, at(20)),
      ev("status", { status: "queued", reason: "resume_message" }, at(30)),
      ev("status", { status: "running" }, at(31)),
      ev("user_message", { text: "Push it" }, at(32)),
      ev("result", { text: "Shall I push?", isError: false, subtype: "success" }, at(40)),
      ev("status", { status: "needs_you", reason: "asked_owner" }, at(40)),
    ]
    renderT(events, row({ status: "needs_you", endedAt: new Date(T0 + 40_000).toISOString() }))
    const cards = screen.getAllByTestId("result-card")
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toMatch(/Done in/)
    expect(cards[0].className).toContain("border-success-border")
    expect(cards[1].textContent).toContain("Needs you")
    expect(cards[1].textContent).not.toMatch(/Done in/)
    expect(cards[1].className).toContain("border-warning-border")
    expect(cards[1].className).not.toContain("border-success-border")
  })

  it("W1-D10: a run that ended failed shows a Failed card even when its result was not an error", () => {
    seq = 0
    const events = [
      ev("status", { status: "running" }),
      ev("result", { text: "Wrote it.", isError: false, subtype: "success" }),
      ev("status", { status: "failed", reason: "pr_missing" }),
    ]
    renderT(events, row({ status: "failed" }))
    const card = screen.getByTestId("result-card")
    expect(card.textContent).toContain("Failed")
    expect(card.className).toContain("border-error-border")
  })
})

describe("SessionTranscript: autonomy lines (S32, S33)", () => {
  it("S32: an auto_continue event renders its counter; autonomy_changed says the new mode", () => {
    seq = 0
    renderT([
      ev("system", {
        subtype: "auto_continue",
        text: "Continuing on its own (2 of 5)",
        data: { n: 2, total: 7 },
      }),
      ev("system", {
        subtype: "autonomy_changed",
        text: "",
        data: { from: "guided", to: "autonomous" },
      }),
      ev("system", {
        subtype: "autonomy_changed",
        text: "",
        data: { from: "autonomous", to: "guided" },
      }),
    ])
    const rows = screen.getAllByTestId("session-event").map((r) => r.textContent ?? "")
    expect(rows[0]).toContain("Continued on its own (2 of 5)")
    expect(rows[1]).toContain("Now runs on its own")
    expect(rows[2]).toContain("Now asks you when it needs to")
  })
})

// Walk 3 (wf6): a followed session is mirrored from its transcript, which has
// no `result` line, so its row stays "running" between turns. The Working
// spinner shows only while it is mid-turn: an assistant or tool line in the
// last turn, under a minute old. Unattended sessions keep the old rule.
describe("SessionTranscript: a followed session's Working line", () => {
  const follow = (over: Partial<NodeSessionRow> = {}) =>
    row({ source: "import", importMode: "follow", importFrom: "cli", following: true, ...over })
  const turn = () => {
    seq = 0
    return [
      ev("user_message", { text: "List the files" }),
      ev("tool_call", { id: "toolu_1", name: "Bash", input: { command: "ls" } }),
      ev("tool_result", { id: "toolu_1", isError: false, output: "a\nb" }),
      ev("assistant_text", { text: "Two files." }),
    ]
  }
  afterEach(() => {
    vi.useRealTimers()
  })

  it("an idle follow (its last line minutes old) shows no spinner", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const events = turn()
    vi.setSystemTime(Date.parse(events[3].at) + 5 * 60_000)
    renderT(events, follow())
    expect(screen.queryByTestId("working-line")).toBeNull()
  })

  it("a follow mid-turn spins, and stops once its last line is a minute old", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const events = turn().slice(0, 2)
    vi.setSystemTime(Date.parse(events[1].at) + 2_000)
    renderT(events, follow())
    expect(screen.getByTestId("working-line").textContent).toContain("Bash · ls")
    vi.advanceTimersByTime(60_000)
    expect(screen.queryByTestId("working-line")).toBeNull()
  })

  it("a follow whose last turn has only the prompt, or ended with a result, shows no spinner", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const events = turn()
    vi.setSystemTime(Date.parse(events[3].at) + 1_000)
    const { unmount } = renderT([...events, ev("user_message", { text: "And now?" })], follow())
    expect(screen.queryByTestId("working-line")).toBeNull()
    unmount()
    renderT([...turn(), ev("result", { subtype: "success", text: "Two files." })], follow())
    expect(screen.queryByTestId("working-line")).toBeNull()
  })

  it("an unattended running session keeps its spinner whatever the age of its last line", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const events = turn()
    vi.setSystemTime(Date.parse(events[3].at) + 5 * 60_000)
    renderT(events)
    expect(screen.getByTestId("working-line")).toBeTruthy()
  })
})

describe("a subagent line's dot reads the Subagents panel (final recheck)", () => {
  function background(end?: "completed" | "failed"): Held[] {
    seq = 0
    const events: Held[] = [
      ev("status", { status: "running" }),
      ev("tool_call", {
        id: "tu_bg",
        name: "Agent",
        input: { description: "List src/ files", subagent_type: "general-purpose" },
      }),
      // A background Agent call returns at once: its line holds no state of its own.
      ev("tool_result", { id: "tu_bg", isError: false, output: "Async agent launched" }),
      ev("system", {
        subtype: "task_started",
        text: "List src/ files",
        data: {
          taskId: "t1",
          toolUseId: "tu_bg",
          taskType: "local_agent",
          description: "List src/ files",
        },
      }),
    ]
    // Started just now: a running subagent is stuck only after 4 minutes of silence.
    const now = new Date().toISOString()
    for (const e of events) {
      e.at = now
      e.receivedAt = now
    }
    if (end) {
      events.push(
        ev("system", {
          subtype: "task_notification",
          text: "",
          data: { taskId: "t1", status: end },
        }),
      )
    }
    return events
  }
  const dot = () => screen.getByTestId("subagent-ref").querySelector("span.rounded-full")

  it("a background subagent still at work shows the panel's running dot", () => {
    renderT(background(), row({ status: "running" }))
    expect(screen.getByTestId("subagent-ref").dataset.state).toBe("running")
    expect(dot()?.className).toContain("bg-success")
  })

  it("a finished one says done, as the panel's Finished group", () => {
    renderT(background("completed"), row({ status: "running" }))
    expect(screen.getByTestId("subagent-ref").dataset.state).toBe("done")
    expect(dot()?.className).toContain("bg-text-tertiary")
  })

  it("a failed one shows the panel's failed dot", () => {
    renderT(background("failed"), row({ status: "running" }))
    expect(screen.getByTestId("subagent-ref").dataset.state).toBe("failed")
    expect(dot()?.className).toContain("bg-error")
  })
})
