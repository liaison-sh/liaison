// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Charter: no absolute local path outside the folder chip's tooltip. The
// transcript model is the choke point (every display string goes through
// relativizePaths there), and diffs and the plan relativize their lines. This
// renders each surface the P2 skeptic probed, with a home path planted in it,
// and reads back the whole DOM: text and every attribute.
import type { NodeSessionEvent } from "@liaison/shared"
import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import FilesDrawer from "./FilesDrawer"
import { filesChanged } from "./files-changed"
import SessionPlan from "./SessionPlan"
import SessionTranscript from "./SessionTranscript"
import { registerSessionActions, resetSessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { sessionPathContext } from "./transcript"

const SID = "3f2a9c1e-0000-4000-8000-000000000001"
const HOME = "/Users/sam/secret"
const T0 = Date.parse("2026-10-13T10:00:00.000Z")
let seq = 0

function ev(
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  over: Partial<NodeSessionEvent> = {},
): NodeSessionEvent {
  seq++
  return {
    seq,
    at: new Date(T0 + seq * 1000).toISOString(),
    receivedAt: new Date(T0 + seq * 1000).toISOString(),
    type,
    payload,
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
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Probe",
    folderName: "my-repo",
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

/** Every text node and every attribute value of the rendered DOM. */
function everythingShown(root: HTMLElement): string {
  const out: string[] = [root.textContent ?? ""]
  for (const el of root.querySelectorAll("*")) {
    for (const a of el.attributes) out.push(a.value)
  }
  return out.join("\n")
}

function expectNoLocalPath(root: HTMLElement) {
  const shown = everythingShown(root)
  expect(shown).not.toContain("/Users/")
  expect(shown).not.toContain(HOME)
}

afterEach(() => resetSessionActions())

describe("no absolute local path on screen (charter)", () => {
  it("the Working line, from the latest assistant text", () => {
    seq = 0
    const events = [ev("assistant_text", { text: `Reading ${HOME}/notes.txt now` })]
    const { container, getByTestId } = render(() => (
      <SessionTranscript session={row()} events={events} />
    ))
    expect(getByTestId("working-line").textContent).toContain("notes.txt")
    expectNoLocalPath(container)
  })

  it("the Working line, from the row's latest activity", () => {
    const { container } = render(() => (
      <SessionTranscript
        session={row({ latestActivity: `Reading ${HOME}/notes.txt now` })}
        events={[]}
      />
    ))
    expectNoLocalPath(container)
  })

  it("a question, its header, its options and their descriptions (with and without actions)", () => {
    for (const withActions of [false, true]) {
      if (withActions) registerSessionActions({ answerQuestion: async () => {} })
      seq = 0
      const events = [
        ev("question", {
          requestId: "r1",
          questions: [
            {
              question: `Delete ${HOME}/old.txt?`,
              header: `${HOME}/old.txt`,
              multiSelect: false,
              options: [
                { label: `Keep ${HOME}/old.txt`, description: `Leaves ${HOME}/old.txt` },
                { label: "Delete", description: `Removes ${HOME}/old.txt.` },
              ],
            },
          ],
        }),
      ]
      const { container, unmount } = render(() => (
        <SessionTranscript session={row({ status: "waiting" })} events={events} />
      ))
      expect(container.textContent).toContain("old.txt")
      expectNoLocalPath(container)
      unmount()
    }
  })

  it("a question's answer still carries the question and label the node asked", async () => {
    const sent: Record<string, string>[] = []
    registerSessionActions({
      answerQuestion: async (_s: string, _r: string, a: Record<string, string>) => {
        sent.push(a)
      },
    })
    seq = 0
    const question = `Delete ${HOME}/old.txt?`
    const label = `Keep ${HOME}/old.txt`
    const events = [
      ev("question", {
        requestId: "r1",
        questions: [{ question, multiSelect: false, options: [{ label }] }],
      }),
    ]
    const { container } = render(() => (
      <SessionTranscript session={row({ status: "waiting" })} events={events} />
    ))
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Keep"),
    )
    btn?.click()
    expect(sent).toEqual([{ [question]: label }])
  })

  it("a subagent's description, a status reason, a permission reason, a result and a system line", () => {
    seq = 0
    const events = [
      ev("system", { subtype: "info", text: `Loaded ${HOME}/CLAUDE.md` }),
      ev("tool_call", {
        id: "t1",
        name: "Task",
        input: { description: `Audit ${HOME}/src`, subagent_type: "Explore" },
      }),
      ev("assistant_text", { text: "x" }, { parentToolUseId: "t1" }),
      ev("status", { status: "failed", reason: `folder ${HOME}/gone missing` }),
      ev("permission_request", {
        requestId: "r1",
        tool: "Bash",
        input: { command: `rm ${HOME}/a` },
        reason: `Writes to ${HOME}/a`,
      }),
      ev("plan_request", { requestId: "r2", plan: `1. Edit ${HOME}/b.ts` }),
      ev("thinking", { text: `Maybe ${HOME}/c.ts` }),
      ev("user_message", { text: `Look at ${HOME}/d.ts` }),
      ev("result", { text: `Done with ${HOME}/e.ts`, isError: false, subtype: "success" }),
    ]
    const { container } = render(() => <SessionTranscript session={row()} events={events} />)
    for (const d of container.querySelectorAll("details")) d.setAttribute("open", "")
    expect(container.textContent).toContain("Audit src")
    expectNoLocalPath(container)
  })

  it("an Edit row's diff and a tool's output", () => {
    seq = 0
    const events = [
      ev("tool_call", {
        id: "t1",
        name: "Edit",
        input: {
          file_path: `${HOME}/my-repo/a.ts`,
          old_string: `const p = "${HOME}/x"`,
          new_string: `const p = "${HOME}/y"`,
        },
      }),
      ev("tool_result", { id: "t1", isError: true, output: `EACCES ${HOME}/my-repo/a.ts` }),
    ]
    const { container } = render(() => (
      <SessionTranscript session={row({ status: "done" })} events={events} />
    ))
    expect(container.textContent).toContain("a.ts")
    expectNoLocalPath(container)
  })

  it("the pinned plan's items and current item", () => {
    seq = 0
    const events = [
      ev("todo", {
        items: [
          { content: `Read ${HOME}/a.md`, status: "completed" },
          {
            content: `Edit ${HOME}/b.md`,
            status: "in_progress",
            activeForm: `Editing ${HOME}/b.md`,
          },
        ],
        from: "TodoWrite",
      }),
    ]
    const { container } = render(() => (
      <SessionPlan events={events} pathContext={sessionPathContext(row(), events)} />
    ))
    for (const d of container.querySelectorAll("details")) d.setAttribute("open", "")
    expect(container.textContent).toContain("b.md")
    expectNoLocalPath(container)
  })

  it("the files drawer's diff lines", () => {
    seq = 0
    const events = [
      ev("tool_call", {
        id: "t1",
        name: "Write",
        input: { file_path: `${HOME}/my-repo/cfg.json`, content: `{"root": "${HOME}/data"}` },
      }),
      ev("tool_result", { id: "t1", output: "ok" }),
    ]
    const files = filesChanged(events, sessionPathContext(row(), events))
    const { container } = render(() => <FilesDrawer open files={files} onClose={() => {}} />)
    expect(container.textContent).toContain("cfg.json")
    expectNoLocalPath(container)
  })
})
