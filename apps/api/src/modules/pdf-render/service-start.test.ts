// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `pdf-render` deploy service starts with nothing but its socket path and
// NODE_ENV=production (deploy/docker-compose.yml gives it no secret and no
// network): its entry must import nothing that validates the API's
// configuration (lib/env.ts) or reaches a service.
import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MAIN = path.join(import.meta.dir, "main.ts")

let dir = ""
let child: ReturnType<typeof Bun.spawn> | undefined

afterEach(() => {
  child?.kill("SIGKILL")
  child = undefined
  // The service leaves its socket folder unwritable: give it back before removing it.
  if (dir) chmodSync(dir, 0o755)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string, ms: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined })),
    ])
    if (next.done) break
    seen += decoder.decode(next.value)
    if (seen.includes(needle)) break
  }
  reader.releaseLock()
  return seen
}

describe("the render service entry", () => {
  it("starts and answers its health check with only its socket and NODE_ENV=production", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pdf-render-start-"))
    const socket = path.join(dir, "render.sock")
    child = Bun.spawn([process.execPath, MAIN], {
      cwd: path.join(import.meta.dir, "../../.."),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        NODE_ENV: "production",
        LIAISON_PDF_RENDER_SOCKET: socket,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await waitForLine(child.stdout as ReadableStream<Uint8Array>, "listening", 20_000)
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(50).then(() => false),
    ])
    const stderr = exited ? await new Response(child.stderr as ReadableStream).text() : ""
    expect({ exited, stderr }).toEqual({ exited: false, stderr: "" })
    expect(out).toContain(`pdf render service listening on ${socket}`)
    const res = await fetch("http://pdf-render/healthz", { unix: socket } as RequestInit)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  }, 30_000)

  it("leaves its socket folder holding only the socket: nothing else can be written there, and a restart still listens", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pdf-render-start-"))
    const socket = path.join(dir, "render.sock")
    const start = () =>
      Bun.spawn([process.execPath, MAIN], {
        cwd: path.join(import.meta.dir, "../../.."),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          NODE_ENV: "production",
          LIAISON_PDF_RENDER_SOCKET: socket,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    child = start()
    await waitForLine(child.stdout as ReadableStream<Uint8Array>, "listening", 20_000)
    expect(() => writeFileSync(path.join(dir, ".render-probe"), "x")).toThrow()
    child.kill("SIGKILL")
    await child.exited
    // A restart over the stale socket (the container restarted) listens again.
    child = start()
    const again = await waitForLine(child.stdout as ReadableStream<Uint8Array>, "listening", 20_000)
    expect(again).toContain("listening")
    const res = await fetch("http://pdf-render/healthz", { unix: socket } as RequestInit)
    expect(res.status).toBe(200)
    expect(() => writeFileSync(path.join(dir, ".render-probe"), "x")).toThrow()
  }, 45_000)
})
