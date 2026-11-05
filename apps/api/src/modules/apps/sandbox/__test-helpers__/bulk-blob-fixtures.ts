// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test helpers for the bulk-blob host service (Phase 16 Task A7).
//
// Spins a tiny Bun-native HTTP server on an ephemeral port and exposes a few
// canned routes. Tests call `startFixtureServer()` once in `beforeAll`, then
// build URLs through `jsonlUrl(...)` / `hugeUrl` / etc.
import { promises as fsp } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface FixtureServerHandle {
  port: number
  baseUrl: string
  stop: () => Promise<void>
  /** Write `rows` to a temp JSONL file and return a local URL that serves it. */
  jsonlUrl: (rows: unknown[]) => Promise<string>
  /** URL whose handler streams >2 MiB of repeated JSONL lines. */
  hugeUrl: string
  /** URL whose handler streams 50 MiB of JSONL lines. */
  bigUrl: string
  /** URL whose handler streams 3 valid lines, 1 broken, 1 valid. */
  brokenUrl: string
  /** URL whose handler streams a small (5-row) JSONL doc — `["a","b","c","d","e"]`. */
  smallUrl: string
}

let serial = 0

function makeJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
}

export async function startFixtureServer(): Promise<FixtureServerHandle> {
  const tmpDir = join(tmpdir(), `bulk-blob-test-${process.pid}-${++serial}`)
  await fsp.mkdir(tmpDir, { recursive: true })

  // Pre-built fixtures.
  const smallBody = makeJsonl(["a", "b", "c", "d", "e"])
  const brokenBody =
    JSON.stringify({ ok: 1 }) +
    "\n" +
    JSON.stringify({ ok: 2 }) +
    "\n" +
    JSON.stringify({ ok: 3 }) +
    "\n" +
    "this is not valid json\n" +
    JSON.stringify({ ok: 5 }) +
    "\n"

  // Custom-served files registered at runtime — keyed by URL path.
  const customFiles = new Map<string, string>()

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/small.jsonl") {
        return new Response(smallBody, { headers: { "content-type": "application/jsonl" } })
      }
      if (path === "/broken.jsonl") {
        return new Response(brokenBody, { headers: { "content-type": "application/jsonl" } })
      }
      if (path === "/huge.jsonl") {
        // ~2.5 MiB — 50,000 rows of ~50 bytes each.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const line = JSON.stringify({ pad: "x".repeat(40), idx: 0 }) + "\n"
            for (let i = 0; i < 50_000; i++) {
              controller.enqueue(enc.encode(line))
            }
            controller.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "application/jsonl" } })
      }
      if (path === "/big.jsonl") {
        // ~50 MiB — 1,000,000 rows of ~50 bytes each.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const line = JSON.stringify({ pad: "x".repeat(40), idx: 0 }) + "\n"
            for (let i = 0; i < 1_000_000; i++) {
              controller.enqueue(enc.encode(line))
            }
            controller.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "application/jsonl" } })
      }
      if (path.startsWith("/custom/")) {
        const filePath = customFiles.get(path)
        if (!filePath) return new Response("not found", { status: 404 })
        const file = Bun.file(filePath)
        return new Response(file, { headers: { "content-type": "application/jsonl" } })
      }
      return new Response("not found", { status: 404 })
    },
  })

  // `Bun.serve({ port: 0 })` always returns a number once the server is bound;
  // the type includes `undefined` for not-yet-listening edge cases. We've already
  // synchronously bound, so coerce.
  const port = server.port as number
  const baseUrl = `http://127.0.0.1:${port}`

  async function jsonlUrl(rows: unknown[]): Promise<string> {
    const id = String(++serial)
    const filePath = join(tmpDir, `custom-${id}.jsonl`)
    await fsp.writeFile(filePath, makeJsonl(rows), "utf-8")
    const path = `/custom/${id}.jsonl`
    customFiles.set(path, filePath)
    return `${baseUrl}${path}`
  }

  return {
    port,
    baseUrl,
    stop: async () => {
      server.stop(true)
      await fsp.rm(tmpDir, { recursive: true, force: true })
    },
    jsonlUrl,
    hugeUrl: `${baseUrl}/huge.jsonl`,
    bigUrl: `${baseUrl}/big.jsonl`,
    brokenUrl: `${baseUrl}/broken.jsonl`,
    smallUrl: `${baseUrl}/small.jsonl`,
  }
}
