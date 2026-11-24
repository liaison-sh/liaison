// SPDX-License-Identifier: FSL-1.1-ALv2
// A refresh of the moving orgs asked for after a transfer-state change never joins a read that
// started before it: that read cannot have seen the change, yet its snapshot would count as fresh
// for a second. The reads are held open here, so the order never depends on timing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  ORG_TRANSFER_CHANGED,
  type OrgTransferRecord,
  OrgTransferView,
  onOrgTransferBroadcast,
  orgTransferView,
  readMovingOrgs,
  setOrgTransferState,
} from "./state"

const ORG = "11111111-1111-4111-8111-111111111111"
const frozen: OrgTransferRecord = { orgId: ORG, state: "frozen", transferId: "t-1", at: 1 }

/** A read whose answers are handed out by the test, each taken at the moment its read starts. */
function heldRead(answer: () => OrgTransferRecord[] | Promise<OrgTransferRecord[]>) {
  const started: Array<{ release: () => void; fail: (err: Error) => void }> = []
  const read = () => {
    const rows = answer()
    return new Promise<OrgTransferRecord[]>((resolve, reject) => {
      started.push({ release: () => resolve(rows as OrgTransferRecord[]), fail: reject })
    })
  }
  return { read, started }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5)
  expect(cond()).toBe(true)
}

describe("a refresh after a change", () => {
  function viewOf() {
    let rows: OrgTransferRecord[] = []
    let clock = 1_000
    const held = heldRead(() => rows)
    const view = new OrgTransferView({
      instanceId: "test",
      read: held.read,
      writeAcks: async () => {},
      now: () => clock,
    })
    return {
      view,
      ...held,
      commit: (r: OrgTransferRecord[]) => {
        rows = r
      },
      tick: (ms: number) => {
        clock += ms
      },
    }
  }

  test("does not join a read started before it: its own read starts after, and sees the change", async () => {
    const h = viewOf()
    const before = h.view.refresh()
    h.commit([frozen])
    const after = h.view.refreshAfterChange()
    let done = false
    void after.then(() => {
      done = true
    })
    h.started[0]!.release()
    await before
    await settle()
    expect(h.view.peek(ORG)).toBeNull()
    expect(done).toBe(false)
    expect(h.started).toHaveLength(2)
    h.started[1]!.release()
    await after
    expect(h.view.peek(ORG)?.state).toBe("frozen")
  })

  test("several changes during one read queue exactly one more", async () => {
    const h = viewOf()
    const before = h.view.refresh()
    h.commit([{ ...frozen, state: "draining" }])
    const one = h.view.refreshAfterChange()
    h.commit([frozen])
    const two = h.view.refreshAfterChange()
    h.started[0]!.release()
    await before
    await settle()
    expect(h.started).toHaveLength(2)
    h.started[1]!.release()
    await Promise.all([one, two])
    expect(h.started).toHaveLength(2)
    expect(h.view.peek(ORG)?.state).toBe("frozen")
  })

  test("a change during the queued read gets a read of its own", async () => {
    const h = viewOf()
    void h.view.refresh()
    const one = h.view.refreshAfterChange()
    h.started[0]!.release()
    await settle()
    expect(h.started).toHaveLength(2)
    h.commit([frozen])
    const two = h.view.refreshAfterChange()
    h.started[1]!.release()
    await one
    await settle()
    expect(h.started).toHaveLength(3)
    h.started[2]!.release()
    await two
    expect(h.view.peek(ORG)?.state).toBe("frozen")
  })

  test("a read before it that fails does not fail it", async () => {
    const h = viewOf()
    const before = h.view.refresh().catch(() => "failed")
    h.commit([frozen])
    const after = h.view.refreshAfterChange()
    h.started[0]!.fail(new Error("gone"))
    expect(await before).toBe("failed")
    await settle()
    h.started[1]!.release()
    await after
    expect(h.view.peek(ORG)?.state).toBe("frozen")
  })

  test("a read before it whose acks are still being written is not joined either", async () => {
    const acks: Array<() => void> = []
    let rows: OrgTransferRecord[] = [{ ...frozen, state: "draining" }]
    const view = new OrgTransferView({
      instanceId: "test",
      read: async () => rows,
      writeAcks: () => new Promise<void>((resolve) => acks.push(resolve)),
    })
    const before = view.refresh()
    await settle()
    rows = [frozen]
    const after = view.refreshAfterChange()
    acks[0]!()
    await before
    await settle()
    acks[1]!()
    await after
    expect(view.peek(ORG)?.state).toBe("frozen")
  })

  test("with no read running it reads at once", async () => {
    const h = viewOf()
    h.commit([frozen])
    const after = h.view.refreshAfterChange()
    expect(h.started).toHaveLength(1)
    h.started[0]!.release()
    await after
    expect(h.view.peek(ORG)?.state).toBe("frozen")
  })

  test("the snapshot's age is its read's start, not its end", async () => {
    const h = viewOf()
    const slow = h.view.refresh()
    h.tick(1_500)
    h.started[0]!.release()
    await slow
    // The rows are 1.5 s old: a gate reads again instead of trusting them for another second.
    const state = h.view.stateOf(ORG)
    expect(h.started).toHaveLength(2)
    h.commit([frozen])
    h.started[1]!.release()
    expect(await state).toBeNull()
    h.tick(999)
    expect(await h.view.stateOf(ORG)).toBeNull()
    expect(h.started).toHaveLength(2)
  })
})

describe("this process's view", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  /** Hold the next read of the process's view open; every later one reads the database. */
  async function holdNextRead<T>(body: (release: () => void) => Promise<T>): Promise<T> {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    Reflect.set(orgTransferView, "read", async () => {
      const held = first
      first = false
      const rows = await readMovingOrgs()
      if (held) await gate
      return rows
    })
    try {
      return await body(release)
    } finally {
      release()
      Reflect.set(orgTransferView, "read", readMovingOrgs)
      await orgTransferView.refresh().catch(() => {})
    }
  }

  test("a freeze returns with the state in this process, whatever read was running", async () => {
    const { orgId } = await minimal.secondOrg({ name: "Moving Org" })
    const transferId = randomUUID()
    await orgTransferView.refresh()
    try {
      await holdNextRead(async (release) => {
        const running = orgTransferView.refresh()
        // Let the running read take its rows before the change commits.
        await Bun.sleep(100)
        const set = setOrgTransferState(orgId, "frozen", transferId)
        await Bun.sleep(150)
        release()
        await running
        await set
        expect(orgTransferView.peek(orgId)?.state).toBe("frozen")
      })
    } finally {
      await setOrgTransferState(orgId, null, transferId)
    }
  })

  test("a change another process broadcasts is read after the broadcast", async () => {
    let reads = 0
    await holdNextRead(async (release) => {
      const held = Reflect.get(orgTransferView, "read") as () => Promise<OrgTransferRecord[]>
      Reflect.set(orgTransferView, "read", () => {
        reads++
        return held()
      })
      const running = orgTransferView.refresh()
      onOrgTransferBroadcast("another-channel")
      onOrgTransferBroadcast(ORG_TRANSFER_CHANGED)
      expect(reads).toBe(1)
      release()
      await running
      await until(() => reads === 2)
    })
  })
})
