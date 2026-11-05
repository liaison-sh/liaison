// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T05: the session's control lines (D36): the applied log, seq order,
// duplicates, unsupported types, and the input stream's delivery tracking.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { type CommandOutcome, NOT_SUPPORTED, SessionControl, SessionInput } from "./session-control"

const root = mkdtempSync(path.join(tmpdir(), "liaison-session-control-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const JOB = "11111111-2222-3333-4444-555555555555"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const line = (n: number, command: NodeSessionCommand, seq = n) =>
  commandLine({ type: "command", commandId: id(n), seq, command })

type Applied = { commandId: string; type: string; outcome: CommandOutcome; error?: string }

function control(dir: string, jobId = JOB) {
  const applied: Applied[] = []
  const other: Array<Record<string, unknown>> = []
  const c = new SessionControl({
    sessionDir: dir,
    jobId,
    emitApplied: (p) => applied.push(p),
    onOther: (p) => other.push(p),
  })
  return { c, applied, other }
}

describe("P3-T05 SessionControl (D36)", () => {
  it("a command id already in applied.jsonl is not applied twice and its command_applied is re-emitted", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const first = control(dir)
    let models = 0
    first.c.handlers.set_model = () => {
      models++
      return { outcome: "applied" }
    }
    await first.c.feed(line(1, { type: "set_model", payload: { model: "claude-haiku-4-5" } }))
    expect(models).toBe(1)
    expect(first.applied).toEqual([{ commandId: id(1), type: "set_model", outcome: "applied" }])
    const file = path.join(dir, "applied.jsonl")
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // The same line again in this process, then in a later run of the session.
    await first.c.feed(line(1, { type: "set_model", payload: { model: "claude-haiku-4-5" } }))
    expect(models).toBe(1)
    expect(first.applied).toHaveLength(2)
    expect(first.applied[1]).toEqual(first.applied[0] as Applied)

    const later = control(dir, "99999999-2222-3333-4444-555555555555")
    let laterModels = 0
    later.c.handlers.set_model = () => {
      laterModels++
      return { outcome: "applied" }
    }
    await later.c.feed(line(1, { type: "set_model", payload: { model: "claude-haiku-4-5" } }))
    expect(laterModels).toBe(0)
    expect(later.applied).toEqual([{ commandId: id(1), type: "set_model", outcome: "applied" }])
    // Recorded before it was applied, then settled: two lines.
    const records = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(records.map((r) => r.outcome ?? null)).toEqual([null, "applied"])
  })

  it("the log line is written before the handler runs", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const { c } = control(dir)
    let seen = ""
    c.handlers.set_model = () => {
      seen = readFileSync(path.join(dir, "applied.jsonl"), "utf8")
      return { outcome: "applied" }
    }
    await c.feed(line(1, { type: "set_model", payload: { model: "m" } }))
    expect(JSON.parse(seen.trim())).toMatchObject({ commandId: id(1), seq: 1, type: "set_model" })
  })

  it("a lower or equal seq with a new id is dropped; commands apply in seq order", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const { c, applied } = control(dir)
    const order: number[] = []
    c.handlers.set_model = (_cmd, l) => {
      order.push(l.seq)
      return { outcome: "applied" }
    }
    await c.feed(line(2, { type: "set_model", payload: { model: "a" } }))
    await c.feed(line(3, { type: "set_model", payload: { model: "b" } }, 2))
    await c.feed(line(4, { type: "set_model", payload: { model: "c" } }))
    expect(order).toEqual([2, 4])
    expect(applied.map((a) => a.commandId)).toEqual([id(2), id(4)])
  })

  it("a command taken by a run that died before settling is applied by the next run", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const dead = control(dir)
    dead.c.handlers.message = () => null // deferred, never settled: the process died
    await dead.c.feed(line(5, { type: "message", payload: { text: "hi" } }))
    expect(dead.applied).toEqual([])
    const next = control(dir, "99999999-2222-3333-4444-555555555555")
    const taken: string[] = []
    next.c.handlers.message = (cmd) => {
      taken.push(cmd.payload.text)
      return { outcome: "applied" }
    }
    await next.c.feed(line(5, { type: "message", payload: { text: "hi" } }))
    expect(taken).toEqual(["hi"])
  })

  it("a released command is applied by the next process of the same job, even below the highest seq", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const first = control(dir)
    first.c.handlers.message = () => null
    first.c.handlers.set_level = () => ({ outcome: "applied" })
    await first.c.feed(line(1, { type: "message", payload: { text: "later" } }))
    await first.c.feed(line(2, { type: "set_level", payload: { level: "strict" } }))
    first.c.release(id(1))
    const next = control(dir) // the same job, restarted
    const taken: string[] = []
    next.c.handlers.message = (cmd) => {
      taken.push(cmd.payload.text)
      return { outcome: "applied" }
    }
    await next.c.feed(line(2, { type: "set_level", payload: { level: "strict" } }))
    await next.c.feed(line(1, { type: "message", payload: { text: "later" } }))
    expect(taken).toEqual(["later"])
    expect(next.applied).toEqual([
      { commandId: id(2), type: "set_level", outcome: "applied" },
      { commandId: id(1), type: "message", outcome: "applied" },
    ])
  })

  it("a type with no handler is acked failed (not supported); a bad command line is dropped; other lines pass on", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const { c, applied, other } = control(dir)
    await c.feed(line(1, { type: "set_level", payload: { level: "strict" } }))
    expect(applied).toEqual([
      { commandId: id(1), type: "set_level", outcome: "failed", error: NOT_SUPPORTED },
    ])
    await c.feed(JSON.stringify({ type: "command", commandId: "x", seq: 2, command: {} }))
    await c.feed("not json")
    await c.feed(JSON.stringify({ type: "abort" }))
    expect(applied).toHaveLength(1)
    expect(other).toEqual([{ type: "abort" }])
  })

  it("a throwing handler settles failed with its message", async () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const { c, applied } = control(dir)
    c.handlers.set_model = () => {
      throw new Error("boom")
    }
    await c.feed(line(1, { type: "set_model", payload: { model: "m" } }))
    expect(applied).toEqual([
      { commandId: id(1), type: "set_model", outcome: "failed", error: "boom" },
    ])
  })
})

describe("P3-T05 SessionInput", () => {
  it("delivers a message when the CLI starts it, not when the SDK pulls it", async () => {
    const delivered: string[] = []
    const input = new SessionInput({ onDelivered: (m) => delivered.push(m.text) })
    const it = input[Symbol.asyncIterator]()
    input.push("first")
    const a = await it.next()
    // No lifecycle seen yet: the pull delivers (an older CLI).
    expect(delivered).toEqual(["first"])
    input.lifecycleEvent((a.value as { uuid: string }).uuid, "started")
    const m = input.push("second", id(1))
    const b = await it.next()
    expect((b.value as { uuid: string }).uuid).toBe(m.uuid)
    expect(delivered).toEqual(["first"])
    expect(input.outstanding().map((x) => x.text)).toEqual(["second"])
    input.lifecycleEvent(m.uuid, "queued")
    expect(input.outstanding()).toHaveLength(1)
    input.lifecycleEvent(m.uuid, "started")
    expect(delivered).toEqual(["first", "second"])
    expect(input.outstanding()).toEqual([])
  })

  it("cancelOutstanding cancels what the CLI has not read and never yields it", async () => {
    const input = new SessionInput()
    const it = input[Symbol.asyncIterator]()
    input.push("prompt")
    await it.next()
    input.lifecycleEvent("unknown", "started") // a lifecycle-speaking CLI
    input.push("a", id(1))
    input.push("b", id(2))
    expect(input.cancelOutstanding().map((m) => m.commandId)).toEqual([id(1), id(2)])
    input.close()
    expect((await it.next()).done).toBe(true)
  })
})
