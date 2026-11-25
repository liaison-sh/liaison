// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The render service: one HTTP endpoint on one Unix socket. It runs in its
// own container (deploy service `pdf-render`: no network, read-only, no
// secret, no data volume, its own UID and PID namespace) and spawns one child
// per request (runner.ts). It reads nothing from the environment but the
// socket path.

import { chmodSync, existsSync, unlinkSync } from "node:fs"
import type { PdfRenderRequest } from "./protocol"
import { runRenderRequest } from "./runner"

/** A request body is at most this large (8 MB upload, base64, twice at seal). */
const MAX_BODY_BYTES = 48 * 1024 * 1024

function isRequest(body: unknown): body is PdfRenderRequest {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b.orgId !== "string") return false
  if (b.op === "intake") return typeof b.pdf === "string"
  if (b.op === "seal_merge")
    return typeof b.frozen === "string" && typeof b.signaturePages === "string"
  return false
}

export function startRenderServer(socketPath: string): { stop: () => void } {
  if (existsSync(socketPath)) unlinkSync(socketPath)
  const server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok")
      if (req.method !== "POST" || url.pathname !== "/run")
        return new Response("not found", { status: 404 })
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, code: "PDF_UNREADABLE", message: "bad request" })
      }
      if (!isRequest(body))
        return Response.json({ ok: false, code: "PDF_UNREADABLE", message: "bad request" })
      return Response.json(await runRenderRequest(body))
    },
  })
  // The API runs under another UID: the socket is the volume's only file.
  chmodSync(socketPath, 0o666)
  return { stop: () => server.stop(true) }
}
