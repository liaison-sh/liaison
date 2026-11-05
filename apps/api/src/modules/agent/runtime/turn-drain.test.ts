// SPDX-License-Identifier: FSL-1.1-ALv2
// The shutdown's turn phase against a turn accepted late in the edge grace,
// still preparing (message write, app setup, ledger row) when the drain
// starts: it is waited for and handed off, never skipped.
import { beforeEach, describe, expect, it } from "bun:test"
import { ActiveTurnsTestAccess, acceptTurn, trackTurn } from "./active-turns"
import { drainTurns, registerDurableTurn, TurnHandoffTestAccess } from "./turn-handoff"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A durable turn that settles as soon as a handoff is asked of it. */
function durable(turnId: string, asked: string[]): void {
  const end = registerDurableTurn({
    turnId,
    orgId: "org",
    requestHandoff: () => {
      asked.push(turnId)
      end()
    },
    abortModel: () => end(),
  })
}

describe("turn drain", () => {
  beforeEach(() => {
    ActiveTurnsTestAccess.clear()
    TurnHandoffTestAccess.clear()
  })

  it("waits for a /chat turn still preparing and hands it off", async () => {
    const asked: string[] = []
    // Accepted inside the grace; its preparation outlasts the drain budget.
    const accepted = acceptTurn("chat:t1")
    setTimeout(() => {
      durable("turn-1", asked)
      accepted.prepared()
      void accepted.run("chat:t1:m1", () => new Promise<void>(() => {}))
    }, 80)

    const result = await drainTurns(20, 2_000, 50)
    expect(result.drained).toBe(false)
    expect(result.preparing).toEqual([])
    expect(result.requested).toEqual(["turn-1"])
    expect(asked).toEqual(["turn-1"])
  })

  it("waits for a thread turn still preparing and hands it off", async () => {
    const asked: string[] = []
    void trackTurn("thread:t2:m2", async () => {
      await wait(80)
      // Registering the durable turn ends the tracked turn's preparation.
      durable("turn-2", asked)
      await new Promise<void>(() => {})
    })
    const result = await drainTurns(20, 2_000, 50)
    expect(result.requested).toEqual(["turn-2"])
    expect(asked).toEqual(["turn-2"])
  })

  it("an accepted turn that bails before running leaves the drain free", async () => {
    const accepted = acceptTurn("chat:t3")
    setTimeout(() => accepted.end(), 20)
    const result = await drainTurns(2_000, 2_000, 50)
    expect(result.drained).toBe(true)
  })
})
