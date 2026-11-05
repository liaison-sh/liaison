// SPDX-License-Identifier: FSL-1.1-ALv2
// The port sweep before a test server starts stops a stale test server of a
// previous run, and nothing else: a foreign listener on a port of the block
// (Docker's forwarder publishing a container there, for one) keeps running.
import { afterEach, describe, expect, it } from "bun:test"
import { createServer } from "node:net"
import { killPortHolders } from "./worker-env"

const children: Bun.Subprocess[] = []

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill(9)
    } catch {}
  }
})

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

async function untilListening(port: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await listening(port))) {
    if (Date.now() > deadline) throw new Error(`nothing listens on ${port}`)
    await Bun.sleep(50)
  }
}

async function exited(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  return await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)])
}

describe("killPortHolders", () => {
  it("kills a stale bun listener on the port", async () => {
    const port = await freePort()
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ok") })`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    })
    children.push(proc)
    await untilListening(port)

    await killPortHolders([port])
    expect(await exited(proc, 5_000)).toBe(true)
  })

  it("leaves a listener that is not a bun or node process running", async () => {
    const port = await freePort()
    const proc = Bun.spawn({
      cmd: ["python3", "-m", "http.server", "--bind", "127.0.0.1", String(port)],
      stdout: "ignore",
      stderr: "ignore",
    })
    children.push(proc)
    await untilListening(port)

    await killPortHolders([port])
    expect(await exited(proc, 1_000)).toBe(false)
    expect(await listening(port)).toBe(true)
  })

  it("leaves a process that only holds a connection to the port running", async () => {
    const port = await freePort()
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
    try {
      const client = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); await Bun.sleep(30_000)`,
        ],
        stdout: "ignore",
        stderr: "ignore",
      })
      children.push(client)
      await Bun.sleep(500)

      await killPortHolders([port])
      expect(await exited(client, 1_000)).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
