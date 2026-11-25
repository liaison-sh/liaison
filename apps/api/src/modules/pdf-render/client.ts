// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The API's door to the render service. With LIAISON_PDF_RENDER_SOCKET set,
// every request goes over that socket to the isolated service. Without it, in
// production, an upload is refused PDF_RENDER_UNAVAILABLE (generated documents
// never need the service); outside production a local child stands in,
// logged as not isolated.

import { env } from "~/lib/env"
import { pdfLogger as log } from "~/lib/logger"
import type { PdfRenderRequest, PdfRenderResponse } from "./protocol"
import { runRenderRequest } from "./runner"

/** The transport, replaceable in tests. */
export const renderTransport = {
  socketPath: (): string | undefined => env.LIAISON_PDF_RENDER_SOCKET,
  production: (): boolean => env.NODE_ENV === "production",
}

let warnedLocal = false

const unavailable = <T>(): PdfRenderResponse<T> => ({
  ok: false,
  code: "PDF_RENDER_UNAVAILABLE",
  message:
    "This server has no file reader for uploads: an administrator sets LIAISON_PDF_RENDER_SOCKET and runs the pdf-render service.",
})

/** One request to the render service. Never throws: every outcome is data. */
export async function callRenderService<T>(req: PdfRenderRequest): Promise<PdfRenderResponse<T>> {
  const socket = renderTransport.socketPath()
  if (!socket) {
    if (renderTransport.production()) return unavailable()
    if (!warnedLocal) {
      warnedLocal = true
      log.warn(
        "pdf render runs as a local child process: NOT ISOLATED (no LIAISON_PDF_RENDER_SOCKET)",
      )
    }
    return runRenderRequest<T>(req)
  }
  try {
    const res = await fetch("http://pdf-render/run", {
      method: "POST",
      unix: socket,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    } as RequestInit)
    if (!res.ok) return unavailable()
    return (await res.json()) as PdfRenderResponse<T>
  } catch (err) {
    log.error({ err, socket }, "pdf render service unreachable")
    return unavailable()
  }
}
