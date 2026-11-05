// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T14 (A43, A45, A60, A44): the dim lines an import's follow writes, said
// in the viewer's words from their facts: where the replay started, a
// skipped oversized line, the older subagents left on the computer, and a
// Take over refused because its folder left the shared folder.
import type { NodeSessionEvent } from "@liaison/shared"
import { render, screen } from "@solidjs/testing-library"
import { For } from "solid-js"
import { describe, expect, it } from "vitest"
import type { NodeSessionRow } from "./session-api"
import { TranscriptItemView } from "./TranscriptItem"
import { buildTranscript } from "./transcript"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "import",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the build",
    folderName: "repo",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-5-5",
    level: "standard",
    status: "running",
    importMode: "follow",
    importFrom: "vscode",
    following: true,
    cwdSubdir: "sub",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    startedAt: "2026-10-16T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...over,
  }
}

let seq = 0
function ev(type: NodeSessionEvent["type"], payload: Record<string, unknown>): NodeSessionEvent {
  seq++
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    type,
    payload,
  } as NodeSessionEvent
}
const system = (subtype: string, text: string, data: Record<string, unknown>) =>
  ev("system", { subtype, text, data })

function renderEvents(
  events: NodeSessionEvent[],
  session = row(),
  agentName?: string,
  extra: { parentToolUseId?: string } = {},
) {
  const items = buildTranscript(events, {
    sessionStatus: session.status,
    pathContext: { sessionId: session.id, folderName: session.folderName, repo: session.repo },
  })
  const ctx = {
    session,
    pathContext: { sessionId: session.id, folderName: session.folderName, repo: session.repo },
    live: true,
    ...(agentName ? { agentName } : {}),
    ...extra,
  }
  render(() => (
    <div data-testid="items">
      <For each={items}>
        {(item, i) => <TranscriptItemView item={item} ctx={ctx} first={i() === 0} />}
      </For>
    </div>
  ))
  return screen.getByTestId("items").textContent ?? ""
}

describe("an import's follow lines (P3-T14)", () => {
  it("A43: system imported with historyFrom window renders the earlier-history line", () => {
    const text = renderEvents([
      system("imported", "Imported from this computer", { historyFrom: "window", from: "vscode" }),
    ])
    expect(text).toContain("Imported from VS Code. Earlier history stays on this computer")
  })

  it("A43: a replay from the start says imported, without the earlier-history line", () => {
    const text = renderEvents([
      system("imported", "Imported from this computer", { historyFrom: "start", from: "cli" }),
    ])
    expect(text).toContain("Imported from Terminal")
    expect(text).not.toContain("Earlier history")
  })

  it("A60: system follow subagentsOmitted renders the older-history line", () => {
    const text = renderEvents([
      system("follow", "Older subagent history not imported (7)", {
        state: "started",
        subagentsOmitted: 7,
      }),
    ])
    expect(text).toContain("Older subagent history not imported (7)")
  })

  it("D49 F5: system follow olderLinesOmitted renders the older-lines line, not the follow start", () => {
    const text = renderEvents([
      system("follow", "Older lines not imported (12)", {
        state: "started",
        olderLinesOmitted: 12,
      }),
    ])
    expect(text).toContain("Older lines not imported (12)")
    expect(text).not.toContain("Following the session read only")
  })

  it("A45: system follow skippedLine renders the 16 MiB line", () => {
    const text = renderEvents([
      system("follow", "A transcript line over the size limit was skipped", {
        state: "started",
        skippedLine: true,
      }),
    ])
    expect(text).toContain("A transcript line over 16 MiB was skipped")
  })

  it("A45: the follow's start and its transcript_gone end are said in words", () => {
    const text = renderEvents([
      system("follow", "Following", { state: "started" }),
      system("follow", "nothing to catch up", { state: "ended", why: "transcript_gone" }),
    ])
    expect(text).toContain("Following the session read only")
    expect(text).toContain("The transcript is gone or shorter than before: following ended")
  })

  it("A44: a run refused unsafe_subdir says why in words, never the code", () => {
    const text = renderEvents(
      [ev("status", { status: "failed", error: "unsafe subdir", code: "unsafe_subdir" })],
      row({ status: "failed", importMode: "take_over", following: false }),
    )
    expect(text).toContain("no longer inside the shared folder")
    expect(text).not.toContain("unsafe_subdir")
  })

  it("B2-3: a run refused already_liaison says why in words, never the code", () => {
    const text = renderEvents(
      [ev("status", { status: "failed", error: "another server", code: "already_liaison" })],
      row({ status: "failed", importMode: "take_over", following: false }),
    )
    expect(text).toContain("another Liaison server")
    expect(text).not.toContain("already_liaison")
  })

  it("A45: a status line ended follow_ended says following ended", () => {
    const text = renderEvents(
      [ev("status", { status: "needs_you", reason: "follow_ended" })],
      row({ status: "waiting", state: "needs_you", following: false }),
    )
    expect(text).toContain("following ended")
  })
})

describe("an import's prompts (W3-D3)", () => {
  it("W3-D3: the first terminal prompt of an import is the person's, labelled by where they typed it, never the agent", () => {
    const events = [ev("user_message", { text: "fix the tests" })]
    const cli = renderEvents(events, row({ importFrom: "cli" }), "Personal agent")
    expect(cli).toContain("You (terminal)")
    expect(cli).not.toContain("Personal agent")
  })

  it("W3-D3: a VS Code import's first prompt says You (VS Code)", () => {
    const vscode = renderEvents([ev("user_message", { text: "hi" })], row(), "Personal agent")
    expect(vscode).toContain("You (VS Code)")
  })

  it("W3-D3: a message sent through Liaison after Take over (it has a commandId) is You, never the agent", () => {
    const viaLiaison = renderEvents(
      [ev("user_message", { text: "go on", commandId: "c1" })],
      row({ importMode: "take_over", following: false }),
      "Personal agent",
    )
    expect(viaLiaison).not.toContain("You (VS Code)")
    expect(viaLiaison).not.toContain("Personal agent")
    expect(viaLiaison).toContain("You")
  })
})

describe("a subagent's prompt in its drawer (final recheck F-D1)", () => {
  it("F-D1: in an import's subagent drawer, the prompt is the main agent's, never You (terminal)", () => {
    const text = renderEvents(
      [ev("user_message", { text: "List the files in src/" })],
      row({ importFrom: "cli" }),
      undefined,
      { parentToolUseId: "tu_bg" },
    )
    expect(text).toContain("Main agent")
    expect(text).not.toContain("You (terminal)")
  })

  it("F-D1: a Liaison session's subagent prompt is the main agent's too, never You", () => {
    const text = renderEvents(
      [ev("user_message", { text: "List the files in src/" })],
      row({ source: "app", importMode: null, importFrom: null, following: false }),
      undefined,
      { parentToolUseId: "tu_bg" },
    )
    expect(text).toContain("Main agent")
    expect(text).not.toMatch(/\bYou\b/)
  })
})
