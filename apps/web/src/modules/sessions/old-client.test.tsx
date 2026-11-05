// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S9, D14: clients already installed (desktop and TestFlight builds from before
// this wave) never see `needs_you` in `status`. Their display rules are run
// here from a copy of the base commit's display.ts and session-list.ts
// (__fixtures__/base-03b1a52b4), the way their SessionList (dot) and
// SessionHeader (pill) index them: `STATUS_TONE[displayStatus(row)]` with no
// fallback. A row as the API now serves it (status waiting, state needs_you)
// must not throw and must land in their Waiting group. The control proves the
// test can fail: the same code given a raw `needs_you` status throws.
import { describe, expect, it } from "vitest"
import { displayStatus, STATUS_TONE } from "./__fixtures__/base-03b1a52b4/display"
import { groupOf } from "./__fixtures__/base-03b1a52b4/session-list"
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
    lastSeq: 3,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: "Which branch?",
    error: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:05:00.000Z",
    updatedAt: "2026-10-15T10:05:00.000Z",
    ...over,
  }
}

/** What the old SessionList row dot and SessionHeader pill read. */
function oldClientLookups(r: NodeSessionRow) {
  const status = displayStatus(r, true)
  return {
    dot: STATUS_TONE[status].dot,
    pill: `${STATUS_TONE[status].text} ${STATUS_TONE[status].soft}`,
    group: groupOf(r, Date.parse("2026-10-15T12:00:00.000Z")),
  }
}

describe("an older client served a needs_you row (S9, D14)", () => {
  it("S9: the base commit's STATUS_TONE and groupOf given a served needs_you row (status waiting, state needs_you) do not throw and file it as waiting", () => {
    const served = row({ status: "waiting", state: "needs_you" })
    expect(() => oldClientLookups(served)).not.toThrow()
    expect(oldClientLookups(served)).toEqual({
      dot: "bg-warning",
      pill: "text-warning bg-warning-glow",
      group: "waiting",
    })
  })

  it("control: the same code given a raw status needs_you throws", () => {
    expect(() => oldClientLookups(row({ status: "needs_you" }))).toThrow(TypeError)
  })
})
