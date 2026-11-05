// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T13 (C5, D36): the node's unacked commands reach the right live session,
// once per page life, in seq order; a 30 s pull heals a dropped wake.

import { parseCommandLine } from "@liaison/shared/node-session-protocol"
import { describe, expect, it, vi } from "vitest"
import { COMMAND_PULL_MS, createCommandDelivery, type PulledCommand } from "./commands"

const S1 = "11111111-1111-4111-8111-111111111111"
const S2 = "22222222-2222-4222-8222-222222222222"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function cmd(n: number, sessionId: string, seq: number, extra: Partial<PulledCommand> = {}) {
  return {
    commandId: id(n),
    sessionId,
    jobId: `job-${sessionId === S1 ? 1 : 2}`,
    seq,
    type: "message",
    payload: { text: `m${n}` },
    ...extra,
  } satisfies PulledCommand
}

function setup(commands: PulledCommand[], live: Map<string, string>) {
  const timers: Array<{ fn: () => void; live: boolean }> = []
  const writes: Array<{ sessionId: string; line: string }> = []
  const pull = vi.fn(async () => commands)
  const write = vi.fn(async (sessionId: string, line: string) => {
    writes.push({ sessionId, line })
    return true
  })
  const delivery = createCommandDelivery({
    pull,
    write,
    live: () => live,
    clock: {
      now: () => 0,
      every: (_ms, fn) => {
        const t = { fn, live: true }
        timers.push(t)
        return () => {
          t.live = false
        }
      },
    },
  })
  const fire = async () => {
    for (const t of timers.filter((x) => x.live)) t.fn()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { delivery, pull, write, writes, timers, fire }
}

describe("command delivery (P3-T13)", () => {
  it("a wake pulls and writes each command once, in seq order, to its session only", async () => {
    const live = new Map([
      [S1, "job-1"],
      [S2, "job-2"],
    ])
    const h = setup([cmd(3, S1, 2), cmd(1, S1, 1), cmd(2, S2, 1)], live)
    await h.delivery.pull()
    expect(h.writes.map((w) => [w.sessionId, parseCommandLine(w.line)?.seq])).toEqual([
      [S1, 1],
      [S1, 2],
      [S2, 1],
    ])
    const first = parseCommandLine(h.writes[0]?.line ?? "")
    expect(first).toEqual({
      type: "command",
      commandId: id(1),
      seq: 1,
      command: { type: "message", payload: { text: "m1" } },
    })
    expect(h.writes.every((w) => !w.line.includes("\n"))).toBe(true)
    // A second wake (the commands still unacked) writes nothing again.
    await h.delivery.pull()
    expect(h.writes).toHaveLength(3)
  })

  it("a command for a session not live here, or for another run of it, is not written", async () => {
    const live = new Map([[S1, "job-1"]])
    const h = setup([cmd(1, S2, 1), cmd(2, S1, 1, { jobId: "job-old" }), cmd(3, S1, 2)], live)
    await h.delivery.pull()
    expect(h.writes.map((w) => parseCommandLine(w.line)?.commandId)).toEqual([id(3)])
  })

  it("a malformed command is never written; a failed write holds that session's later ones", async () => {
    const live = new Map([
      [S1, "job-1"],
      [S2, "job-2"],
    ])
    const h = setup(
      [
        cmd(1, S1, 1, { type: "shutdown" }),
        cmd(2, S2, 1),
        cmd(3, S2, 2),
        cmd(4, S1, 2, { payload: { text: "" } }),
      ],
      live,
    )
    h.write.mockImplementationOnce(async () => {
      throw new Error("pipe closed")
    })
    await h.delivery.pull()
    // S1's two are malformed; S2's first write failed, so its second waits.
    expect(h.writes).toHaveLength(0)
    await h.delivery.pull()
    expect(h.writes.map((w) => parseCommandLine(w.line)?.seq)).toEqual([1, 2])
  })

  it("a restarted process, or a new run of the session, gets its unacked commands again", async () => {
    const live = new Map([[S1, "job-1"]])
    const commands = [cmd(1, S1, 1)]
    const h = setup(commands, live)
    await h.delivery.pull()
    await h.delivery.pull()
    expect(h.writes).toHaveLength(1)
    // D34: the level restart hands back what the old process had not applied.
    h.delivery.forget(S1)
    await h.delivery.pull()
    expect(h.writes).toHaveLength(2)
    // A resume run (a new job) of the same session.
    live.set(S1, "job-9")
    commands.splice(0, 1, cmd(1, S1, 1, { jobId: "job-9" }))
    await h.delivery.pull()
    expect(h.writes).toHaveLength(3)
  })

  it("the 30 s timer pulls while a run is live and stops when none is", async () => {
    const live = new Map<string, string>()
    const h = setup([], live)
    h.delivery.runsChanged()
    expect(h.timers).toHaveLength(0)
    live.set(S1, "job-1")
    h.delivery.runsChanged()
    h.delivery.runsChanged()
    expect(h.timers.filter((t) => t.live)).toHaveLength(1)
    await h.fire()
    expect(h.pull).toHaveBeenCalledTimes(1)
    live.clear()
    h.delivery.runsChanged()
    expect(h.timers.filter((t) => t.live)).toHaveLength(0)
    expect(COMMAND_PULL_MS).toBe(30_000)
  })

  it("wakes during a pull fold into one more pull", async () => {
    const live = new Map([[S1, "job-1"]])
    const h = setup([], live)
    let release: () => void = () => {}
    h.pull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        }),
    )
    const first = h.delivery.pull()
    void h.delivery.pull()
    void h.delivery.pull()
    release()
    await first
    expect(h.pull).toHaveBeenCalledTimes(2)
  })
})
