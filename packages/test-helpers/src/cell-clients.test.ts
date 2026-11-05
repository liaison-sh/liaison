// SPDX-License-Identifier: FSL-1.1-ALv2
// The cell clients against one real `src/index.ts` process (createRoleCell):
// a socket opened through the ticket exchange gets its `presence_sync`, and a
// scripted turn registers on the process it was sent to.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { bootstrap } from "./auth"
import { jsonLogLines, openCellSocket, scriptTurnOn } from "./cell-clients"
import { createRoleCell, type RoleCell, type RoleProcess } from "./role-processes"

// Clear of the lanes (0-3), the other helper tests (50-61, 99) and the moved
// P1 cell scenarios (70, 71).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 72

describe("cell clients", () => {
  let cell: RoleCell
  let proc: RoleProcess
  let token: string

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["all"])
    proc = cell.processes[0] as RoleProcess
    token = (await bootstrap(proc.url)).accessToken
  }, 120_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 30_000)

  it("openCellSocket gets presence_sync from an all process", async () => {
    const socket = await openCellSocket(proc, token)
    try {
      const sync = socket.frames.find((f) => f.type === "presence_sync")
      expect(sync).toBeDefined()
      // A later frame is awaited from where the socket stands: a ping answers a pong.
      socket.send({ type: "ping" })
      const pong = await socket.waitFor((f) => f.type === "pong", 10_000)
      expect(pong.type).toBe("pong")
    } finally {
      await socket.close()
    }
  }, 30_000)

  it("openCellSocket refuses a bad token loudly, with no frame", async () => {
    await expect(openCellSocket(proc, "not-a-token")).rejects.toThrow(/ticket/)
  }, 30_000)

  it("scriptTurnOn registers a script the process's scripted provider will read", async () => {
    const threadId = crypto.randomUUID()
    await scriptTurnOn(proc, threadId, [{ text: "hello from the cell" }])
    const res = await fetch(`${proc.url}/api/_test/agent-script?threadId=${threadId}`)
    const body = (await res.json()) as { data: { remaining: number } }
    expect(body.data.remaining).toBe(1)
  }, 30_000)

  it("jsonLogLines parses the process's JSON log lines", () => {
    const lines = jsonLogLines(proc)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => typeof l === "object" && l !== null)).toBe(true)
    expect(lines.some((l) => typeof l.msg === "string")).toBe(true)
  })
})
