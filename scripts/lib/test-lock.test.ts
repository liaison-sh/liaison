// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { portBlockBase, preferredPortBlock } from "../../packages/test-helpers/src/test-namespace"
import {
  acquireNamespaceLock,
  acquireTestLock,
  describeSlots,
  leasePortBlock,
  legacyLockPath,
  slotCount,
  slotDir,
} from "./test-lock"

const created: string[] = []

/** A private slot dir and legacy lock path, so no test touches the machine's real ones. */
function freshEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liaison-test-slots-"))
  created.push(dir)
  return {
    TEST_SLOT_DIR: path.join(dir, "slots"),
    TEST_LOCK_PATH: path.join(dir, "legacy.lock"),
    // The load gate reads the machine's real load average; these tests are about
    // slot order, so the gate is off (machine-slots.test.ts covers it with an injected load).
    LIAISON_SLOT_MAX_LOAD: "off",
    ...extra,
  }
}

const quiet = { log: () => {}, installExitHandlers: false } as const

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("acquireTestLock (test slots)", () => {
  it("writes a slot record carrying the pid, start time, cmd and namespace", async () => {
    const env = freshEnv()
    const lock = await acquireTestLock({ cmd: "unit", ns: "a", env, ...quiet })
    expect(lock.slot).toBe(0)
    expect(lock.slots).toBe(2)
    const held = JSON.parse(fs.readFileSync(lock.path as string, "utf8"))
    expect(held.pid).toBe(process.pid)
    expect(held.cmd).toBe("unit")
    expect(held.ns).toBe("a")
    expect(typeof held.startedAt).toBe("string")
    lock.release()
    expect(fs.existsSync(lock.path as string)).toBe(false)
  })

  it("lets LIAISON_TEST_SLOTS runs hold a slot at once, and the next one waits", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "2" })
    const alive = new Set([101, 102])
    const isAlive = (pid: number) => alive.has(pid)
    const a = await acquireTestLock({ cmd: "a", env, pid: 101, isAlive, ...quiet })
    const b = await acquireTestLock({ cmd: "b", env, pid: 102, isAlive, ...quiet })
    expect([a.slot, b.slot]).toEqual([0, 1])

    let clock = 0
    const lines: string[] = []
    const third = acquireTestLock({
      cmd: "c",
      env,
      pid: 103,
      isAlive,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        // The first holder finishes while the third waits.
        if (clock >= 6_000) alive.delete(101)
      },
      pollMs: 2_000,
      logEveryMs: 1,
      log: (m) => lines.push(m),
      installExitHandlers: false,
    })
    const c = await third
    expect(c.slot).toBe(0)
    // Waiting says who holds the slots.
    expect(lines.join("\n")).toContain("pid 101")
    expect(lines.join("\n")).toContain("pid 102")
    b.release()
    c.release()
  })

  it("takes over a slot whose holder pid is dead", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1" })
    fs.mkdirSync(slotDir(env), { recursive: true })
    const file = path.join(slotDir(env), "slot-0.lock")
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "", cmd: "ghost" }))
    const lines: string[] = []
    const lock = await acquireTestLock({
      cmd: "takeover",
      env,
      isAlive: () => false,
      log: (m) => lines.push(m),
      installExitHandlers: false,
    })
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cmd).toBe("takeover")
    expect(lines.join("\n")).toContain("stale")
    lock.release()
  })

  it("counts a live holder of the old exclusive lock as one slot, and never touches its file", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "2" })
    const legacy = legacyLockPath(env)
    const legacyBody = JSON.stringify({ pid: 500, startedAt: "x", cmd: "old test-run.ts e2e" })
    fs.writeFileSync(legacy, legacyBody)
    const isAlive = (pid: number) => pid === 500 || pid === 101
    const a = await acquireTestLock({ cmd: "a", env, pid: 101, isAlive, ...quiet })
    expect(a.slot).toBe(0)
    // Slot 1 is free on disk, but the legacy holder occupies it: a second run waits.
    await expect(
      acquireTestLock({
        cmd: "b",
        env: { ...env, TEST_LOCK_WAIT_SEC: "0" },
        pid: 102,
        isAlive,
        ...quiet,
      }),
    ).rejects.toThrow(/legacy exclusive lock: pid 500/)
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyBody)
    a.release()
  })

  it("throws, naming the holders, when TEST_LOCK_WAIT_SEC elapses", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const a = await acquireTestLock({ cmd: "holder", env, pid: 7, isAlive: () => true, ...quiet })
    await expect(
      acquireTestLock({ cmd: "waiter", env, pid: 8, isAlive: () => true, ...quiet }),
    ).rejects.toThrow(/slot 0: pid 7/)
    a.release()
  })

  it("bypasses with TEST_LOCK_SKIP=1 and says so loudly", async () => {
    const env = freshEnv({ TEST_LOCK_SKIP: "1" })
    const lines: string[] = []
    const lock = await acquireTestLock({ cmd: "x", env, log: (m) => lines.push(m) })
    expect(lock.bypassed).toBe(true)
    expect(lock.path).toBeNull()
    expect(lines.join("\n")).toContain("BYPASSED")
    expect(fs.existsSync(slotDir(env))).toBe(false)
  })

  it("release leaves a slot that another pid now owns alone", async () => {
    const env = freshEnv()
    const lock = await acquireTestLock({ cmd: "mine", env, ...quiet })
    fs.writeFileSync(lock.path as string, JSON.stringify({ pid: 424242, startedAt: "", cmd: "x" }))
    lock.release()
    expect(fs.existsSync(lock.path as string)).toBe(true)
  })

  it("defaults: two slots, in the system temp dir; the legacy path is the old lock", () => {
    expect(slotCount({})).toBe(2)
    expect(slotCount({ LIAISON_TEST_SLOTS: "3" })).toBe(3)
    expect(slotCount({ LIAISON_TEST_SLOTS: "0" })).toBe(2)
    expect(slotDir({})).toBe(path.join(os.tmpdir(), "liaison-test-slots"))
    expect(legacyLockPath({})).toBe(path.join(os.tmpdir(), "liaison-test.lock"))
  })

  it("describeSlots lists only live holders", async () => {
    const env = freshEnv()
    const a = await acquireTestLock({
      cmd: "a",
      ns: "x",
      env,
      pid: 11,
      isAlive: () => true,
      ...quiet,
    })
    expect(describeSlots(env, (pid) => pid === 11)).toEqual([
      expect.stringContaining("slot 0: pid 11 ns=x (a)"),
    ])
    expect(describeSlots(env, () => false)).toEqual([])
    a.release()
  })
})

describe("acquireNamespaceLock", () => {
  it("serializes two runs of one namespace and lets other namespaces through", async () => {
    const env = freshEnv({ TEST_LOCK_WAIT_SEC: "0" })
    const isAlive = () => true
    const a = await acquireNamespaceLock("alpha", { cmd: "a", env, pid: 1, isAlive, ...quiet })
    const b = await acquireNamespaceLock("beta", { cmd: "b", env, pid: 2, isAlive, ...quiet })
    await expect(
      acquireNamespaceLock("alpha", { cmd: "a2", env, pid: 3, isAlive, ...quiet }),
    ).rejects.toThrow(/namespace "alpha" still in use by pid 1/)
    a.release()
    const a2 = await acquireNamespaceLock("alpha", { cmd: "a2", env, pid: 3, isAlive, ...quiet })
    a2.release()
    b.release()
  })
})

describe("leasePortBlock", () => {
  it("gives a namespace its preferred block when free", () => {
    const env = freshEnv()
    const lease = leasePortBlock("alpha", { cmd: "a", env, installExitHandlers: false })
    expect(lease.block).toBe(preferredPortBlock("alpha"))
    expect(lease.base).toBe(portBlockBase(lease.block))
    lease.release()
  })

  it("never hands a block leased to another live namespace, even on a hash collision", () => {
    const env = freshEnv()
    fs.mkdirSync(slotDir(env), { recursive: true })
    const wanted = preferredPortBlock("alpha")
    // Someone else (alive) holds alpha's preferred block.
    fs.writeFileSync(
      path.join(slotDir(env), `ports-${wanted}.lease`),
      JSON.stringify({ pid: 77, startedAt: "", cmd: "other", ns: "zeta" }),
    )
    const lease = leasePortBlock("alpha", {
      cmd: "a",
      env,
      isAlive: (pid) => pid === 77,
      installExitHandlers: false,
    })
    expect(lease.block).not.toBe(wanted)
    expect(lease.block).toBe((wanted + 1) % 16)
    lease.release()
  })

  it("takes over a dead holder's block and re-leases its own namespace's", () => {
    const env = freshEnv()
    fs.mkdirSync(slotDir(env), { recursive: true })
    const wanted = preferredPortBlock("alpha")
    const file = path.join(slotDir(env), `ports-${wanted}.lease`)
    fs.writeFileSync(file, JSON.stringify({ pid: 77, startedAt: "", cmd: "x", ns: "zeta" }))
    const lease = leasePortBlock("alpha", {
      cmd: "a",
      env,
      isAlive: () => false,
      installExitHandlers: false,
    })
    expect(lease.block).toBe(wanted)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).ns).toBe("alpha")
    lease.release()
  })
})
