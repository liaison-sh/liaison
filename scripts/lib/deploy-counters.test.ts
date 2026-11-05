// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  LOAD_SCRIPT_REPLIES,
  loadScriptIndex,
  SCRIPTED_FALLBACK_REPLY,
} from "../../apps/api/src/modules/agent/providers/load-script-catalog"
import {
  cutTurns,
  cutTurnsWithLoadReplies,
  doubledEffects,
  edge5xx,
  edge5xxMeasured,
  effectDuplicates,
  effectDuplicatesMeasured,
  report,
  TURN_FINISH_DEADLINE_MS,
} from "./deploy-counters"

const T0 = Date.parse("2026-10-30T10:00:00Z")
const window = { start: T0, end: T0 + 60_000 }

const caddy = (sOffset: number, status: number) =>
  JSON.stringify({
    level: "info",
    ts: (T0 + sOffset * 1000) / 1000,
    logger: "http.log.access.log0",
    msg: "handled request",
    status,
  })

describe("edge5xx", () => {
  it("counts >= 500 only inside the window", () => {
    const lines = [
      caddy(-5, 502), // before
      caddy(1, 200),
      caddy(2, 502),
      caddy(3, 503),
      caddy(4, 499),
      caddy(30, 500),
      caddy(61, 502), // after
      "not json",
      "",
      JSON.stringify({ ts: T0 / 1000 + 5, msg: "no status" }),
    ]
    expect(edge5xx(lines, window)).toBe(3)
  })
})

describe("a source that read nothing is not a measured 0", () => {
  it("edge5xxMeasured: null for an empty file, another format or lines outside the window", () => {
    expect(edge5xxMeasured([], window)).toBeNull()
    expect(edge5xxMeasured([""], window)).toBeNull()
    expect(
      edge5xxMeasured(['1.2.3.4 - - [30/Oct/2026:10:00:01 +0000] "GET / HTTP/1.1" 502 12'], window),
    ).toBeNull()
    expect(edge5xxMeasured([caddy(-5, 200), caddy(90, 502)], window)).toBeNull()
    expect(edge5xxMeasured([caddy(1, 200)], window)).toBe(0)
    expect(edge5xxMeasured([caddy(1, 200), caddy(2, 503)], window)).toBe(1)
  })

  it("effectDuplicatesMeasured: null with no timed JSON line in the window", () => {
    expect(effectDuplicatesMeasured(["plain text", ""], window)).toBeNull()
    expect(
      effectDuplicatesMeasured([JSON.stringify({ time: T0 - 5, msg: "x" })], window),
    ).toBeNull()
    expect(effectDuplicatesMeasured([JSON.stringify({ time: T0 + 5, msg: "x" })], window)).toBe(0)
    expect(
      effectDuplicatesMeasured([JSON.stringify({ time: T0 + 5, msg: "effect_duplicate" })], window),
    ).toBe(1)
  })
})

describe("effectDuplicates", () => {
  it("counts effect_duplicate log lines in the window (pino ms or ISO time)", () => {
    const lines = [
      JSON.stringify({ level: 40, time: T0 + 1000, msg: "effect_duplicate", key: "a" }),
      JSON.stringify({
        level: 40,
        time: new Date(T0 + 2000).toISOString(),
        msg: "effect_duplicate",
      }),
      JSON.stringify({ level: 40, time: T0 - 1, msg: "effect_duplicate" }),
      JSON.stringify({ level: 40, time: T0 + 3000, msg: "effect_unknown" }),
    ]
    expect(effectDuplicates(lines, window)).toBe(2)
  })
})

describe("doubledEffects", () => {
  it("counts keys > 1", () => {
    expect(
      doubledEffects([
        ["mail:1", 1],
        ["mail:2", 2],
        ["webhook:3", 3],
        ["push:4", 0],
      ]),
    ).toBe(2)
  })
})

describe("cutTurns", () => {
  const now = T0 + TURN_FINISH_DEADLINE_MS + 1
  const turn = (
    id: string,
    state: string,
    startedMsAgo: number,
    reply: string | null = null,
    failureReason: string | null = null,
  ) => ({
    id,
    state,
    createdAt: new Date(now - startedMsAgo),
    reply,
    failureReason,
  })

  it("counts only the turns a stopped or dead process cut, not the turn's own failure", () => {
    const rows = [
      turn("deploy-cut", "interrupted", 1000, null, "process"),
      turn("resume-failed", "failed", 1000, null, "process"),
      turn("model-error", "failed", 1000, null, "turn"),
      turn("client-left", "interrupted", 1000, null, "client"),
      // A row written before the reason existed: unknown, so it counts.
      turn("legacy", "failed", 1000, null, null),
    ]
    expect(cutTurns(rows, now)).toEqual([
      { id: "deploy-cut", reason: "interrupted" },
      { id: "resume-failed", reason: "failed" },
      { id: "legacy", reason: "failed" },
    ])
  })

  it("counts a truncated reply and a turn with no terminal state at 15 min", () => {
    const rows = [
      turn("ok", "done", 60_000, "final text"),
      turn("truncated", "done", 60_000, "final te"),
      turn("stuck", "running", TURN_FINISH_DEADLINE_MS),
      turn("handed-off-stuck", "handoff", TURN_FINISH_DEADLINE_MS + 5),
      turn("still-young", "running", TURN_FINISH_DEADLINE_MS - 1),
      turn("cut", "interrupted", 1000),
      turn("broke", "failed", 1000),
      turn("unscripted", "done", 1000, "anything"),
    ]
    const expected = new Map([
      ["ok", "final text"],
      ["truncated", "final text"],
    ])
    expect(cutTurns(rows, now, (id) => expected.get(id))).toEqual([
      { id: "truncated", reason: "reply-mismatch" },
      { id: "stuck", reason: "unfinished" },
      { id: "handed-off-stuck", reason: "unfinished" },
      { id: "cut", reason: "interrupted" },
      { id: "broke", reason: "failed" },
    ])
  })
})

describe("cutTurnsWithLoadReplies", () => {
  const thread = "6f1d2c3b-1111-4222-8333-944455556666"
  const first = LOAD_SCRIPT_REPLIES[loadScriptIndex(thread)]!
  const row = (id: string, reply: string, ordinal: number, loadOrg = true) => ({
    id,
    state: "done",
    createdAt: new Date(T0),
    reply,
    failureReason: null,
    threadId: thread,
    loadOrg,
    ordinal,
  })

  it("a load org's turn must store its script's exact reply: the script first, the fixed line after", () => {
    const cut = cutTurnsWithLoadReplies(
      [
        row("first-ok", first, 0),
        row("later-ok", SCRIPTED_FALLBACK_REPLY, 3),
        row("truncated", first.slice(0, 10), 0),
        row("doubled", `${first}${first}`, 0),
        row("wrong-turn", first, 1),
      ],
      T0 + 1000,
    )
    expect(cut.map((c) => [c.id, c.reason])).toEqual([
      ["truncated", "reply-mismatch"],
      ["doubled", "reply-mismatch"],
      ["wrong-turn", "reply-mismatch"],
    ])
  })

  it("another org's turn is judged by its state only", () => {
    expect(cutTurnsWithLoadReplies([row("visitor", "any model answer", 0, false)], T0)).toEqual([])
  })
})

describe("report", () => {
  it("is ok only when every measured counter is 0", () => {
    const good = report(window, { edge5xx: 0, cutTurns: [], effectDuplicates: 0 })
    expect(good.ok).toBe(true)
    expect(good.doubledEffects).toBeNull()
    expect(good.summary).toContain("0 edge 5xx, 0 cut turns, 0 duplicate effects (ledger)")
    expect(good.summary).toContain("only delayed work")

    const bad = report(window, { edge5xx: 2, cutTurns: [] })
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain("2 edge 5xx")

    expect(report(window, {}).ok).toBe(false)
  })
})

describe("deploy-counters CLI", () => {
  const cli = new URL("../deploy-counters.ts", import.meta.url).pathname

  it("takes the privileged database URL from the environment only, never argv", () => {
    const viaArgv = Bun.spawnSync(
      [process.execPath, cli, "--since", "2026-10-30T10:00:00Z", "--db-url", "postgres://x@y/z"],
      { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } },
    )
    expect(viaArgv.exitCode).not.toBe(0)
    expect(viaArgv.stderr.toString()).toContain("db-url")
    const source = Bun.file(cli).text()
    return source.then((s) => expect(s).toContain("process.env.DEPLOY_COUNTERS_DB_URL"))
  })
})
