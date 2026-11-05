// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T14 (S35, S36): an Atelier session's phases, waiting and boards. The
// state comes from the row (`atelier`) or, on a row from an older API, from
// the latest `atelier` system event; board links are https only, re-checked
// here (the node and the API already drop the others).
import type { NodeSessionAtelierState, NodeSessionEvent } from "@liaison/shared"
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { AtelierStepper } from "./AtelierStepper"
import type { NodeSessionRow } from "./session-api"

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
    title: "Build the feature",
    folderName: "liaison-walk-sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-5-5",
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
    createdAt: "2026-10-16T10:00:00.000Z",
    startedAt: "2026-10-16T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...over,
  }
}

function atelier(over: Partial<NodeSessionAtelierState> = {}): NodeSessionAtelierState {
  return {
    id: "2026-10-16-feature-ab12",
    rung: "R3",
    phase: "spec",
    plan: ["frame", "spec", "execute"],
    done: ["frame"],
    status: "running",
    awaiting: null,
    ...over,
  }
}

let seq = 0
function atelierEvent(data: unknown): NodeSessionEvent {
  seq++
  const at = new Date(1_800_000_000_000 + seq).toISOString()
  return {
    seq,
    at,
    receivedAt: at,
    type: "system",
    payload: { subtype: "atelier", text: "Atelier", data },
  } as NodeSessionEvent
}

const steps = () =>
  screen.getAllByTestId("atelier-step").map((s) => [s.textContent, s.dataset.state])

describe("AtelierStepper (S35, S36)", () => {
  it("S35: a row with atelier plan/done/phase renders three steps with one ticked and one current", () => {
    render(() => <AtelierStepper session={row({ atelier: atelier() })} events={[]} />)
    expect(steps()).toEqual([
      ["frame", "done"],
      ["spec", "current"],
      ["execute", "pending"],
    ])
    const ticked = screen.getAllByTestId("atelier-step")[0]
    expect(ticked.querySelector("[data-testid='atelier-step-tick']")).not.toBeNull()
    expect(screen.getAllByTestId("atelier-step")[1].getAttribute("aria-current")).toBe("step")
    expect(screen.queryByTestId("atelier-status")).toBeNull()
  })

  it("S35: a javascript: board URL is not rendered as a link; an https one opens outside the app", () => {
    // The row's own type allows https only; an API that let one through is re-checked here.
    const boards = [
      { title: "Proof board", url: "https://example.com/proof" },
      { title: "Evil", url: "javascript:alert(1)" },
      { title: "Plain", url: "http://example.com/board" },
    ] as NodeSessionAtelierState["boards"]
    render(() => <AtelierStepper session={row({ atelier: atelier({ boards }) })} events={[]} />)
    const links = screen.getByTestId("atelier-stepper").querySelectorAll("a")
    expect([...links].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Proof board", "https://example.com/proof"],
    ])
    expect(links[0].getAttribute("target")).toBe("_blank")
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer")
    expect(screen.getByTestId("atelier-stepper").textContent).not.toContain("Evil")
    expect(screen.getByTestId("atelier-stepper").textContent).not.toContain("Plain")
  })

  it("S36: awaiting user shows Waiting for you", () => {
    render(() => (
      <AtelierStepper session={row({ atelier: atelier({ awaiting: "user" }) })} events={[]} />
    ))
    expect(screen.getByTestId("atelier-status").textContent).toBe("Waiting for you")
  })

  it("S35: complete ticks every step; failed says its reason", () => {
    const { unmount } = render(() => (
      <AtelierStepper
        session={row({
          atelier: atelier({ status: "complete", phase: "execute", done: ["frame", "spec"] }),
        })}
        events={[]}
      />
    ))
    expect(steps().map((s) => s[1])).toEqual(["done", "done", "done"])
    expect(screen.getByTestId("atelier-status").textContent).toBe("Complete")
    unmount()
    render(() => (
      <AtelierStepper
        session={row({
          atelier: atelier({ status: "failed", failureReason: "The migration does not apply." }),
        })}
        events={[]}
      />
    ))
    expect(screen.getByTestId("atelier-status").textContent).toBe(
      "Failed: The migration does not apply.",
    )
  })

  it("S35 (batch-2 F10): a phase that is not in the plan shows as an extra, current step", () => {
    render(() => (
      <AtelierStepper
        session={row({
          atelier: atelier({ phase: "deploy", plan: ["frame", "spec"], done: ["frame"] }),
        })}
        events={[]}
      />
    ))
    expect(steps()).toEqual([
      ["frame", "done"],
      ["spec", "pending"],
      ["deploy", "current"],
    ])
    expect(screen.getAllByTestId("atelier-step")[2].getAttribute("aria-current")).toBe("step")
  })

  it("S35: no atelier field → no stepper", () => {
    const { unmount } = render(() => <AtelierStepper session={row()} events={[]} />)
    expect(screen.queryByTestId("atelier-stepper")).toBeNull()
    unmount()
    // A newer API with no Atelier state for this session: none either, whatever the events.
    render(() => (
      <AtelierStepper session={row({ atelier: null })} events={[atelierEvent(atelier())]} />
    ))
    expect(screen.queryByTestId("atelier-stepper")).toBeNull()
  })

  it("S35: a row from an older API takes the latest valid atelier event", () => {
    const events = [
      atelierEvent(atelier({ phase: "frame", done: [] })),
      atelierEvent(atelier({ phase: "execute", done: ["frame", "spec"] })),
      atelierEvent({ id: "x", status: "paused" }),
    ]
    render(() => <AtelierStepper session={row()} events={events} />)
    expect(steps()).toEqual([
      ["frame", "done"],
      ["spec", "done"],
      ["execute", "current"],
    ])
  })
})
